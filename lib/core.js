// Shared core for the Jev Skill Evaluator: used by server.js (local) and api/*.js (Vercel).
// Secrets come from environment variables (TYPESAFE_API_KEY, optional APP_PASSWORD); locally also from .env.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const CONCURRENCY = 6;

// ---- config -------------------------------------------------------------
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
const MOCK = process.env.JEV_MOCK === '1';
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const taxonomy = readJson('data/taxonomy.json');
// Draft scope tags (local only — never written back to the taxonomy)
const scopeTags = readJson('data/look-for-scopes.json').scopes;
const scopeOf = (id) => scopeTags[id]?.scope || 'single_utterance';

// How much transcript each scope gets, and which question wording ('contextual' | 'sequence')
const SCOPE_PLAN = {
  single_utterance: { before: 0, after: 0 },
  responsive_utterance: { before: 2, after: 0, wording: 'contextual' },
  multi_turn_move: { before: 3, after: 3, wording: 'sequence' },
  lesson_pattern: { whole: true },
};

// transcript = [{index, label, speaker, text, isTeacher}] in order.
// Window = n teacher turns before/after the target plus everything said between them.
function windowFor(transcript, target, nBefore, nAfter) {
  const out = { index: target.index, label: target.label, text: target.text };
  if (!nBefore && !nAfter) return out;
  const tPos = transcript.filter((x) => x.isTeacher).map((x) => x.index);
  const k = tPos.indexOf(target.index);
  const start = !nBefore ? target.index : k - nBefore >= 0 ? tPos[k - nBefore] : 0;
  const end = !nAfter ? target.index : k + nAfter + 1 < tPos.length ? tPos[k + nAfter + 1] - 1 : transcript.length - 1;
  const fmt = (x) => ({ turn: x.label, speaker: x.speaker || 'Unknown', text: x.text });
  if (start < target.index) out.before = transcript.slice(start, target.index).map(fmt);
  if (end > target.index) out.after = transcript.slice(target.index + 1, end + 1).map(fmt);
  return out;
}

// Build every Jev job for a run. mode: 'scope' or a number of turns (same window for every look-for).
function planJobs(lookFors, transcript, mode) {
  const teacher = transcript.filter((t) => t.isTeacher);
  const jobs = [];
  for (const lf of lookFors) {
    if (mode === 'scope') {
      const plan = SCOPE_PLAN[scopeOf(lf.id)];
      if (plan.whole) { jobs.push({ lf, key: 'lesson', turn: { whole: transcript.map((x) => ({ turn: x.label, speaker: x.speaker || 'Unknown', text: x.text })) } }); continue; }
      for (const t of teacher) {
        const turn = windowFor(transcript, t, plan.before, plan.after);
        const job = { lf, key: t.index, turn, wording: plan.wording };
        if (scopeOf(lf.id) === 'multi_turn_move') {
          // Also ask Jev which teacher turns the sequence runs from/to (options = teacher turns in the window)
          const k = teacher.indexOf(t);
          job.seqOptions = teacher.slice(Math.max(0, k - plan.before), k + plan.after + 1).map((x) => ({ index: x.index, label: x.label }));
          turn.quoteTurn = t.label;
        }
        jobs.push(job);
      }
    } else {
      const n = Number(mode) || 0;
      for (const t of teacher) jobs.push({ lf, key: t.index, turn: windowFor(transcript, t, n, n), wording: n ? 'contextual' : undefined });
    }
  }
  return jobs;
}

// ---- multi-turn sequences --------------------------------------------------
// Pass 1 answers per turn: in_sequence (probability), seq_start / seq_end (teacher-turn index).
// A sequence = a run of consecutive teacher turns that Jev itself says are in a sequence (> 50%).
// Jev's start/end answers only SPLIT a run (when two neighbours agree there is a boundary between them);
// they never stretch a span over turns Jev rated as not in the sequence.
// Each sequence of 2+ teacher turns is then rated once, at its last turn, with the whole span as context.
const SEQ_THRESHOLD = 0.5;
function findSequences(pass1, transcript) {
  const teacherIdx = transcript.filter((t) => t.isTeacher).map((t) => t.index);
  const p = Object.fromEntries(pass1.map((x) => [x.key, x]));
  const runs = []; let cur = [];
  for (const i of teacherIdx) {
    const inSeq = (p[i]?.inSequence ?? 0) > SEQ_THRESHOLD;
    const prev = cur[cur.length - 1];
    const boundary = prev !== undefined && p[prev]?.end !== undefined && p[prev].end < i && p[i]?.start !== undefined && p[i].start > prev;
    if (!inSeq || boundary) { if (cur.length) runs.push(cur); cur = []; }
    if (inSeq) cur.push(i);
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2).map((members) => ({ start: members[0], end: members[members.length - 1], members }));
}
function sequenceJob(lf, transcript, seq) {
  const end = transcript[seq.end];
  const turn = windowFor(transcript, end, seq.members.length - 1, 0);
  turn.quoteTurn = end.label;
  return { lf, key: seq.end, turn, wording: 'sequence_final', seq };
}
const seqKey = (i) => 't' + i;

// ---- taxonomy text -> structured state -----------------------------------
// Taxonomy fields are markdown-ish text: one example per line, optional "* " / "- " bullets,
// with notes in square brackets like [Why attempting: ...] or [type: ...].
function splitItems(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[*\-•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}
function stripQuotes(s) {
  return s.trim().replace(/^["“”']+|["“”']+$/g, '').trim();
}
function parseExamples(text, withWhy) {
  return splitItems(text).map((item) => {
    const notes = [];
    const body = item.replace(/\[([^\]]+)\]/g, (_, inner) => {
      notes.push(inner.replace(/^why\s+[a-z\- ]+:\s*/i, '').trim());
      return '';
    });
    const out = { text: stripQuotes(body.replace(/\s+/g, ' ')) };
    if (withWhy && notes.length) out.why = notes.join('; ');
    return withWhy ? out : out.text;
  });
}

// turn = { text, before?: [{turn, speaker, text}], after?: [...] }
// With no context the state is identical to the original playground format.
function statementToScore(turn) {
  const t = typeof turn === 'string' ? { text: turn } : turn;
  if (t.whole) return { transcript: t.whole };
  const out = t.quoteTurn ? { transcript_quote_turn: t.quoteTurn, transcript_quote: t.text } : { transcript_quote: t.text };
  if (t.before?.length) out.turns_before_quote = t.before;
  if (t.after?.length) out.turns_after_quote = t.after;
  return out;
}

function buildState(lookFor, turn, tpl) {
  return {
    teacher_skill: [
      {
        name: lookFor.name,
        type: lookFor.look_for_type,
        teacher_facing: lookFor.teacher_facing_explanation,
        observable_behaviors: splitItems(lookFor.observable_behaviors),
        acceptable_variations: splitItems(lookFor.acceptable_variations),
        examples: {
          strong: parseExamples(lookFor.strong_examples, false),
          attempting: parseExamples(lookFor.attempting_examples, true),
          insufficient: parseExamples(lookFor.non_examples, true),
          non_example: [{ text: tpl.off_topic_non_example }],
        },
      },
    ],
    scoring_band_definitions: tpl.scoring_band_definitions,
    [turn && turn.whole ? 'lesson_transcript_to_score' : 'teacher_statement_to_score']: statementToScore(turn),
  };
}

// Selected skills -> unique look-fors (a look-for shared by several skills is scored once)
function lookForsForSkills(skillIds) {
  const byId = new Map();
  for (const skill of taxonomy.skills.filter((s) => skillIds.includes(s.id))) {
    for (const lf of skill.look_fors || []) {
      if (!byId.has(lf.id)) byId.set(lf.id, { ...lf, skills: [] });
      byId.get(lf.id).skills.push({ name: skill.name, type: lf.look_for_type });
    }
  }
  return [...byId.values()];
}

// When neighbouring turns are sent, swap in the question wording that points Jev at the target turn.
// Without context the questions are exactly as written in prompt-template.json.
function questionsFor(turn, tpl, wording, seqOptions) {
  const [key, q] = Object.entries(tpl.questions)[0];
  let instructions = null;
  if (turn?.whole) instructions = tpl.instructions_lesson;
  else if (wording === 'sequence_final') instructions = tpl.instructions_sequence_final;
  else if (turn && (turn.before?.length || turn.after?.length)) {
    instructions = wording === 'sequence' ? tpl.instructions_sequence : tpl.instructions_with_context;
  }
  const out = instructions ? { [key]: { ...q, instructions } } : { ...tpl.questions };
  if (seqOptions?.length) {
    const opts = Object.fromEntries(seqOptions.map((o) => [seqKey(o.index), `Turn ${o.label}`]));
    const sq = tpl.sequence_questions;
    out.in_sequence = { type: 'noul', instructions: sq.in_sequence, criteria: sq.in_sequence_criteria };
    out.seq_start = { type: 'choice', instructions: sq.seq_start, criteria: opts };
    out.seq_end = { type: 'choice', instructions: sq.seq_end, criteria: opts };
  }
  return out;
}

// ---- Jev call -------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function callJev(body) {
  if (MOCK) {
    await sleep(150);
    const answers = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === "noul") { answers[name] = { type: "noul", noul: Math.random() }; continue; }
      const keys = Object.keys(q.criteria);
      const p = keys.map(() => Math.random()); const sum = p.reduce((x, y) => x + y);
      const probabilities = Object.fromEntries(keys.map((k, i) => [k, p[i] / sum]));
      const choice = keys[p.indexOf(Math.max(...p))];
      answers[name] = { type: "choice", choice, confidence: probabilities[choice], probabilities };
    }
    return { model: "mock", answers, usage: { input_tokens: 0 } };
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable || attempt >= 4) {
      const text = await res.text();
      throw new Error(`Jev ${res.status}: ${text.slice(0, 400)}`);
    }
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
  }
}

// ---- access control ------------------------------------------------------
// If APP_PASSWORD is set, every /api call must send it in the x-app-password header.
// (Unset locally = open, as before.)
function authorized(req) {
  const want = process.env.APP_PASSWORD;
  if (!want) return true;
  const got = String(req.headers['x-app-password'] || '');
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(got), h(want));
}

// ---- HTTP helpers (work with Node's http and Vercel's Node functions) -----
function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel parses JSON for us
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
  });
}
// Wraps a handler with the method check, password check and error handling.
function route(method, fn) {
  return async (req, res) => {
    try {
      if (req.method !== method) return send(res, 405, { error: 'method not allowed' });
      if (!authorized(req)) return send(res, 401, { error: 'password required' });
      await fn(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: String(e.message || e) });
      else res.end();
    }
  };
}

const handlers = {
  config: route('GET', async (req, res) => send(res, 200, {
    hasKey: !!process.env.TYPESAFE_API_KEY || MOCK, mock: MOCK, snapshot_date: taxonomy.snapshot_date,
  })),

  skills: route('GET', async (req, res) => send(res, 200, taxonomy.skills.map((s) => ({
    id: s.id, name: s.name, alignment: s.alignment, skill_type: s.skill_type, description: s.description,
    look_fors: (s.look_fors || []).map((l) => ({ id: l.id, name: l.name, type: l.look_for_type, scope: scopeOf(l.id), visible: scopeTags[l.id]?.visible_in_transcript || 'yes', visibleNote: scopeTags[l.id]?.note || '' })),
  })))),

  // Shows exactly what was sent to Jev for one look-for + turn (or 'lesson', or a whole sequence)
  preview: route('POST', async (req, res) => {
    const { lookForId, skillIds, transcript, mode, key, seq } = await readBody(req);
    const lf = lookForsForSkills(skillIds).find((l) => l.id === lookForId);
    const tpl = readJson('prompt-template.json');
    const job = seq ? sequenceJob(lf, transcript, seq) : planJobs([lf], transcript, mode).find((j) => String(j.key) === String(key));
    send(res, 200, { model: tpl.model, state: buildState(lf, job.turn, tpl), questions: questionsFor(job.turn, tpl, job.wording, job.seqOptions) });
  }),

  // Streams one JSON line per Jev answer. The page sends one look-for per request (lookForIds),
  // which keeps each request short enough for hosted function time limits.
  evaluate: route('POST', async (req, res) => {
    if (!process.env.TYPESAFE_API_KEY && !MOCK) return send(res, 400, { error: 'No TYPESAFE_API_KEY configured' });
    const { skillIds, transcript, mode = 'scope', excludeLookForIds = [], lookForIds } = await readBody(req);
    const tpl = readJson('prompt-template.json'); // re-read so edits apply without restarting
    const qKey = Object.keys(tpl.questions)[0];
    const lookFors = lookForsForSkills(skillIds).filter((l) => !excludeLookForIds.includes(l.id) && (!lookForIds || lookForIds.includes(l.id)));
    const jobs = planJobs(lookFors, transcript, mode);
    const byIndex = Object.fromEntries(transcript.map((t) => [t.index, t]));
    const fromSeqKey = (k) => (k ? Number(String(k).slice(1)) : undefined);
    const seqInfo = (seq) => ({ startLabel: byIndex[seq.members[0]].label, endLabel: byIndex[seq.end].label, members: seq.members, start: seq.start, end: seq.end });

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const write = (o) => res.write(JSON.stringify(o) + '\n');
    write({ kind: 'start', total: jobs.length, mode, lookFors: lookFors.map(({ id, name, skills }) => ({
      id, name, skills, scope: scopeOf(id), lessonWide: mode === 'scope' && scopeOf(id) === 'lesson_pattern',
    })) });
    let aborted = false;
    req.on('close', () => { if (!res.writableEnded) aborted = true; });
    const pass1 = new Map(); // lookForId -> [{key, inSequence, start, end}]

    const runAll = async (list) => {
      let next = 0;
      const worker = async () => {
        while (!aborted && next < list.length) {
          const { lf, key, turn, wording, seqOptions, seq } = list[next++];
          const body = { model: tpl.model, state: buildState(lf, turn, tpl), questions: questionsFor(turn, tpl, wording, seqOptions) };
          try {
            const out = await callJev(body);
            const a = out.answers[qKey];
            const msg = { kind: 'result', turn: key, lookForId: lf.id, choice: a.choice, label: tpl.questions[qKey].criteria[a.choice] || a.choice, confidence: a.confidence, probabilities: a.probabilities, model: out.model, tokens: out.usage?.input_tokens };
            if (seqOptions) {
              const p = { key, inSequence: out.answers.in_sequence?.noul ?? 0, start: fromSeqKey(out.answers.seq_start?.choice), end: fromSeqKey(out.answers.seq_end?.choice) };
              (pass1.get(lf.id) || pass1.set(lf.id, []).get(lf.id)).push(p);
              msg.inSequence = p.inSequence;
            }
            if (seq) msg.sequence = seqInfo(seq);
            write(msg);
          } catch (e) {
            write({ kind: 'error', turn: key, lookForId: lf.id, error: String(e.message || e), ...(seq ? { sequence: seqInfo(seq) } : {}) });
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    };

    await runAll(jobs);

    // Pass 2: one rating per multi-turn sequence, placed on the turn where it ends
    const seqJobs = [];
    for (const lf of lookFors) {
      if (!pass1.has(lf.id)) continue;
      for (const seq of findSequences(pass1.get(lf.id), transcript)) {
        write({ kind: 'sequence', lookForId: lf.id, ...seqInfo(seq) });
        seqJobs.push(sequenceJob(lf, transcript, seq));
      }
    }
    if (seqJobs.length && !aborted) { write({ kind: 'more', add: seqJobs.length }); await runAll(seqJobs); }
    res.end(JSON.stringify({ kind: 'done' }) + '\n');
  }),
};

module.exports = { handlers, send, MOCK, buildState, lookForsForSkills, splitItems, parseExamples, planJobs, questionsFor, windowFor, findSequences };
