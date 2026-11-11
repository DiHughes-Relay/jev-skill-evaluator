// Shared core for the Jev Skill Evaluator: used by server.js (the app, on Vercel and on your laptop).
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
const BUNDLED_TEMPLATE = require('../prompt-template.json');
// Re-read the template from disk on each run (so local edits apply without a restart); fall back to the bundled copy.
const readTemplate = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-template.json'), 'utf8')); } catch { return BUNDLED_TEMPLATE; } };
// require() (not fs) so Vercel bundles these files with the functions automatically
const taxonomy = require('../data/taxonomy.json');
// Draft scope tags (local only — never written back to the taxonomy)
const scopeTags = require('../data/look-for-scopes.json').scopes;
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

// Taxonomy non-examples carry an optional [type: ...] note (missed opportunity, relational harm, learning harm...).
// non_example_types in prompt-template.json says which band each type's examples go under; untyped ones use 'default'.
const bandsOffered = (tpl) => Object.values(Object.values(tpl.questions)[0].criteria);
const offersMissed = (tpl) => bandsOffered(tpl).includes('Missed');
function sortNonExamples(lookFor, tpl) {
  const map = tpl.non_example_types || {};
  const out = {};
  for (const ex of parseExamples(lookFor.non_examples, true)) {
    const type = ((ex.why || '').match(/type:\s*([^;,\]]+)/i)?.[1] || '').trim().toLowerCase();
    let band = map[type] || map.default || 'insufficient';
    if (band === 'missed' && !offersMissed(tpl)) band = 'attempting'; // Missed isn't offered turn by turn
    (out[band] ||= []).push(ex);
  }
  return out;
}

function buildState(lookFor, turn, tpl) {
  const non = sortNonExamples(lookFor, tpl);
  const examples = {
    strong: parseExamples(lookFor.strong_examples, false),
    attempting: [...parseExamples(lookFor.attempting_examples, true), ...(non.attempting || [])],
    insufficient: non.insufficient || [],
  };
  const missed = offersMissed(tpl);
  if (missed) examples.missed = non.missed || [];
  examples.non_example = [{ text: tpl.off_topic_non_example }];
  // Band definitions: only the bands the question offers (Missed is full-transcript only)
  const bands = Object.fromEntries(Object.entries(tpl.scoring_band_definitions).filter(([k]) => k !== 'missed' || missed));
  return {
    teacher_skill: [
      {
        name: lookFor.name,
        type: lookFor.look_for_type,
        teacher_facing: lookFor.teacher_facing_explanation,
        observable_behaviors: splitItems(lookFor.observable_behaviors),
        acceptable_variations: splitItems(lookFor.acceptable_variations),
        // When Missed is offered, Jev needs to know when the look-for is expected (e.g. "uses 1–3 of these checks strategically")
        ...(missed && lookFor.type_explanation ? { type_explanation: lookFor.type_explanation } : {}),
        examples,
      },
    ],
    scoring_band_definitions: bands,
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

// ---- live (turn-by-turn) evaluation ---------------------------------------
// Simulates scoring while the lesson happens: for each teacher turn Jev sees ONLY that turn and what came
// before it (not the students' reaction to it, which hasn't happened yet).
// - single / responsive look-fors: rated exactly as in the full-transcript run (those windows are already past-only)
// - multi-turn look-fors: Jev answers, for the move so far: is a sequence under way (in_progress), which observable
//   behavior this turn carries out (step), is the sequence finished (complete), and how well it's going so far.
//   The app keeps an "open sequence" per look-for between turns (the simulator would keep this state).
// - lesson-wide look-fors are not rated live.
const LIVE_MAX_BEFORE = 8; // teacher turns of history for an open sequence
const LIVE_FADE_AFTER = 2; // an open sequence ends ("fades") after this many teacher turns in a row that don't continue it

function liveJob(lf, transcript, target, open, tpl) {
  const scope = scopeOf(lf.id);
  if (scope === 'lesson_pattern') return null;
  if (scope === 'single_utterance') { const turn = windowFor(transcript, target, 0, 0); return { lf, scope, turn, body: { model: tpl.model, state: buildState(lf, turn, tpl), questions: questionsFor(turn, tpl) } }; }
  if (scope === 'responsive_utterance') { const turn = windowFor(transcript, target, 2, 0); return { lf, scope, turn, body: { model: tpl.model, state: buildState(lf, turn, tpl), questions: questionsFor(turn, tpl, 'contextual') } }; }
  // multi-turn: history reaches back to the start of the open sequence (plus one turn), else 3 teacher turns
  const teacher = transcript.filter((t) => t.isTeacher).map((t) => t.index);
  const k = teacher.indexOf(target.index);
  const nBefore = open ? Math.min(LIVE_MAX_BEFORE, k - teacher.indexOf(open.start) + 1) : 3;
  const turn = windowFor(transcript, target, Math.max(0, nBefore), 0);
  turn.quoteTurn = target.label;
  const L = tpl.live; const [qKey, q] = Object.entries(tpl.questions)[0];
  const behaviors = splitItems(lf.observable_behaviors);
  const steps = Object.fromEntries(behaviors.map((b, i) => ['b' + (i + 1), b]));
  steps.none = L.step_none;
  const questions = {
    [qKey]: { ...q, instructions: L.instructions_so_far },
    in_progress: { type: 'noul', instructions: L.in_progress, criteria: L.in_progress_criteria },
    step: { type: 'choice', instructions: L.step, criteria: steps },
    complete: { type: 'noul', instructions: L.complete, criteria: L.complete_criteria },
  };
  // Five-band "Building" variant: same look-for and transcript, its own band definitions and one question
  const B = L.building;
  const bodyB = { model: tpl.model,
    state: { ...buildState(lf, turn, tpl), scoring_band_definitions: B.band_definitions },
    questions: { live_rating: { type: 'choice', instructions: B.instructions, criteria: B.criteria } } };
  return { lf, scope, turn, steps, body: { model: tpl.model, state: buildState(lf, turn, tpl), questions }, bodyB };
}

// Sequence tracking driven only by the five-band rating:
//   Building -> start or continue the sequence
//   Strong / Attempting / Insufficient -> the move is finished (or has gone wrong) on this turn: the rating stands
//   Non-Example -> a turn that doesn't continue it; LIVE_FADE_AFTER of those in a row -> "unfinished"
function advanceBuilding(open, target, rating) {
  const label = rating.label;
  const add = (o) => o
    ? { ...o, members: [...o.members, target.index], labels: [...o.labels, target.label], misses: 0 }
    : { start: target.index, startLabel: target.label, members: [target.index], labels: [target.label], misses: 0 };
  if (label === 'Building') { const seq = add(open); return { open: seq, event: { type: open ? 'continuing' : 'started', startLabel: seq.startLabel, endLabel: target.label, members: seq.members } }; }
  if (label === 'Non-Example') {
    if (!open) return { open: null, event: { type: 'none' } };
    const misses = (open.misses || 0) + 1;
    const span = { startLabel: open.startLabel, endLabel: open.labels[open.labels.length - 1], members: open.members };
    if (misses >= LIVE_FADE_AFTER) return { open: null, event: { type: 'unfinished', ...span } };
    return { open: { ...open, misses }, event: { type: 'paused', ...span } };
  }
  const seq = add(open); // Strong / Attempting / Insufficient: finished here
  return { open: null, event: { type: 'completed', startLabel: seq.startLabel, endLabel: target.label, members: seq.members, rating } };
}

// A turn starts or continues a sequence when Jev says it's in one (> 50%) AND either names one of the look-for's
// observable behaviors as this turn's step, or is very sure (> 70%). Without the step check, an open sequence
// tends to "stick": with the sequence in view, Jev rates unrelated later turns around 50–60% in progress.
const LIVE_SURE = 0.7;
const continues = (inProgress, stepKey) => inProgress > SEQ_THRESHOLD && ((stepKey && stepKey !== 'none') || inProgress > LIVE_SURE);

// Carries a multi-turn look-for's open sequence from one teacher turn to the next.
// Returns the new open sequence (or null) and what happened on this turn:
//   started / continuing / completed (Jev says the sequence is finished)
//   paused (one teacher turn that doesn't continue it) / ended (LIVE_FADE_AFTER such turns; the last rating stands)
//   dropped (a one-turn "sequence" that never continued) / none
function advanceSequence(open, target, inProgress, complete, stepKey, rating) {
  if (continues(inProgress, stepKey)) {
    const seq = open
      ? { ...open, members: [...open.members, target.index], labels: [...open.labels, target.label], misses: 0 }
      : { start: target.index, startLabel: target.label, members: [target.index], labels: [target.label], misses: 0, steps: [] };
    seq.steps = stepKey && stepKey !== 'none' && !(open?.steps || []).includes(stepKey) ? [...(open?.steps || []), stepKey] : (open?.steps || []);
    seq.lastRating = rating;
    const span = { startLabel: seq.startLabel, endLabel: target.label, members: seq.members, steps: seq.steps };
    if (complete > SEQ_THRESHOLD) return { open: null, event: { type: 'completed', ...span, rating } };
    return { open: seq, event: { type: open ? 'continuing' : 'started', ...span, rating } };
  }
  if (!open) return { open: null, event: { type: 'none' } };
  const misses = (open.misses || 0) + 1;
  const span = { startLabel: open.startLabel, endLabel: open.labels[open.labels.length - 1], members: open.members, steps: open.steps, rating: open.lastRating };
  if (misses >= LIVE_FADE_AFTER) return { open: null, event: { type: open.members.length >= 2 ? 'ended' : 'dropped', ...span } };
  return { open: { ...open, misses }, event: { type: 'paused', ...span } };
}

// Missed is offered only on the full-transcript page, and only for look-fors that are Required or Conditional in a
// selected skill. An Optional look-for (one of several strategies a teacher may pick) can't really be missed.
// The turn-by-turn page never offers it: live, a missed move just leaves students where they were (Non-Example).
const isMissable = (lf) => (lf.skills || [{ type: lf.look_for_type }]).some((s) => s.type === 'Required' || s.type === 'Conditional');
const tplFor = (lf, tpl) => (isMissable(lf) ? tpl : withoutMissed(tpl));
function withoutMissed(tpl) {
  const [qKey, q] = Object.entries(tpl.questions)[0];
  const labels = Object.values(q.criteria).filter((l) => l !== 'Missed');
  const criteria = Object.fromEntries(labels.map((l, i) => ['option_' + 'abcdefgh'[i], l]));
  return { ...tpl, questions: { ...tpl.questions, [qKey]: { ...q, criteria } } };
}

async function liveTurn({ skillIds, excludeLookForIds = [], transcript, targetIndex, open = {}, openB = {}, coach = {}, coachAfter = 3 }) {
  const tpl = withoutMissed(readTemplate());
  const qKey = Object.keys(tpl.questions)[0];
  const past = transcript.slice(0, targetIndex + 1); // never send anything after the turn being rated
  const target = past[targetIndex];
  const lookFors = lookForsForSkills(skillIds).filter((l) => !excludeLookForIds.includes(l.id));
  const jobs = lookFors.map((lf) => liveJob(lf, past, target, open[lf.id], tpl));
  const started = Date.now();
  const nextOpen = {}, nextOpenB = {};
  const results = new Array(lookFors.length);
  // The harm check runs alongside the look-for calls
  const hBody = harmBody(target, tpl);
  const harmPromise = callJev(hBody).then((o) => ({ p: o.answers.harmful?.noul ?? 0, request: hBody }), (e) => ({ error: String(e.message || e), request: hBody }));
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++; const job = jobs[i]; const lf = lookFors[i];
      if (!job) { results[i] = { lookForId: lf.id, scope: scopeOf(lf.id), kind: 'skipped' }; continue; }
      const t0 = Date.now();
      try {
        // Multi-turn look-fors: the current questions and the five-band variant run side by side
        const [out, outB] = await Promise.all([callJev(job.body), job.bodyB ? callJev(job.bodyB).catch((e) => ({ error: e })) : null]);
        const a = out.answers[qKey];
        const r = { lookForId: lf.id, scope: job.scope, kind: 'result', label: tpl.questions[qKey].criteria[a.choice] || a.choice, choice: a.choice,
          confidence: a.confidence, probabilities: a.probabilities, tokens: out.usage?.input_tokens, ms: Date.now() - t0, request: job.body };
        if (job.scope === 'multi_turn_move') {
          const inProgress = out.answers.in_progress?.noul ?? 0, complete = out.answers.complete?.noul ?? 0;
          const stepKey = out.answers.step?.choice;
          Object.assign(r, { inProgress, complete, step: stepKey, stepText: job.steps[stepKey], stepConfidence: out.answers.step?.confidence,
            stepCount: Object.keys(job.steps).length - 1, stepNames: job.steps });
          const adv = advanceSequence(open[lf.id] || null, target, inProgress, complete, stepKey, { label: r.label, confidence: r.confidence, probabilities: r.probabilities, choice: r.choice });
          if (adv.open) nextOpen[lf.id] = adv.open;
          r.event = adv.event;
          if (outB && !outB.error) {
            const b = outB.answers.live_rating;
            const rb = { label: tpl.live.building.criteria[b.choice] || b.choice, choice: b.choice, confidence: b.confidence, probabilities: b.probabilities, request: job.bodyB };
            const advB = advanceBuilding(openB[lf.id] || null, target, rb);
            if (advB.open) nextOpenB[lf.id] = advB.open;
            r.building = { ...rb, event: advB.event };
          } else {
            r.building = { error: String(outB?.error?.message || outB?.error || 'no answer'), request: job.bodyB };
            if (openB[lf.id]) nextOpenB[lf.id] = openB[lf.id];
          }
        }
        results[i] = r;
      } catch (e) {
        results[i] = { lookForId: lf.id, scope: job.scope, kind: 'error', error: String(e.message || e), request: job.body };
        if (open[lf.id]) nextOpen[lf.id] = open[lf.id]; // keep the sequence open if Jev failed
        if (openB[lf.id]) nextOpenB[lf.id] = openB[lf.id];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, jobs.length || 1) }, worker));

  // When a sequence completes or ends, rate it once as a whole (same call as pass 2 of the full-transcript run).
  // Everything in the span is already in the past, so this is available live.
  await Promise.all(results.map(async (r, i) => {
    const e = r?.event;
    if (!e || (e.type !== 'completed' && e.type !== 'ended')) return;
    const job = sequenceJob(lookFors[i], past, { end: e.members[e.members.length - 1], members: e.members });
    const body = { model: tpl.model, state: buildState(lookFors[i], job.turn, tpl), questions: questionsFor(job.turn, tpl, job.wording) };
    try {
      const out = await callJev(body); const a = out.answers[qKey];
      e.finalRating = { label: tpl.questions[qKey].criteria[a.choice] || a.choice, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, request: body };
    } catch (err) { e.finalRating = { error: String(err.message || err), request: body }; }
  }));
  const harm = await harmPromise;
  const coachOut = coachStep(coach, results, lookFors, coachAfter, harm, tpl);
  return { turn: target.index, label: target.label, ms: Date.now() - started, results, open: nextOpen, openB: nextOpenB,
    coach: coachOut.coach, coachEvent: coachOut.event, harm,
    lookFors: lookFors.map(({ id, name, skills }) => ({ id, name, skills, scope: scopeOf(id) })) };
}

// ---- harm check (one call per teacher turn, independent of look-fors) ---------------
// Rated on the turn alone, so a harmful turn can't bleed into the ratings of later turns.
let RELATIONAL_HARM_EXAMPLES = null;
function relationalHarmExamples() {
  if (RELATIONAL_HARM_EXAMPLES) return RELATIONAL_HARM_EXAMPLES;
  const seen = new Set(), out = [];
  for (const s of taxonomy.skills) for (const lf of s.look_fors || []) {
    if (seen.has(lf.id)) continue; seen.add(lf.id);
    for (const ex of parseExamples(lf.non_examples, true)) if (/relational harm/i.test(ex.why || '')) out.push({ text: ex.text, why: ex.why });
  }
  return (RELATIONAL_HARM_EXAMPLES = out);
}
function harmBody(target, tpl) {
  const H = tpl.harm_check;
  return { model: tpl.model,
    state: {
      harm_definition: H.definition,
      examples: { harmful: [...(tpl.harmful_example ? [{ text: tpl.harmful_example }] : []), ...relationalHarmExamples()], not_harmful: H.not_harmful_examples.map((text) => ({ text })) },
      teacher_statement_to_score: { transcript_quote: target.text },
    },
    questions: { harmful: { type: 'noul', instructions: H.instructions, criteria: H.criteria } } };
}

// ---- coach trigger -------------------------------------------------------------
// The coach watches a few ineffective turns go by before stepping in, unless something egregious happens.
// Per teacher turn, the rating that counts for each look-for is:
//   single / responsive: its rating; multi-turn: the whole-sequence rating if a sequence finished this turn,
//   otherwise the five-band (Building) rating. Look-fors a transcript can't show (draft tag "no") don't count.
// - harm check above harm_check.step_in_now_above (0.7) -> egregious: the coach steps in now
// - harm check above counts_as_ineffective_above (0.5), or any look-for Insufficient with confidence > COACH.ineffective
//   -> an ineffective turn. Harm is rated only by this one-turn check, never by the look-for bands: look-fors that
//   see earlier turns let a harmful turn bleed into later ratings. How long harm affects a student is a rule for the
//   simulator's student-behavior logic, not for Jev.
// - the count resets when the teacher fixes what went wrong: every look-for that was Insufficient comes back
//   Strong or Attempting (confidence > COACH.ineffective). Effective ratings on OTHER look-fors don't reset it
//   (with many look-fors selected, something unrelated is nearly always rated well).
// - it also resets after COACH.quietTurns teacher turns in a row with nothing ineffective
// - when the count reaches coachAfter (2 or 3), the coach steps in; stepping in resets the count
const COACH = { ineffective: 0.5, quietTurns: 4 };
function coachStep(prev = {}, results, lookFors, coachAfter = 3, harm = null, tpl = readTemplate()) {
  const H = tpl.harm_check;
  const harmP = harm?.p ?? 0;
  const items = [];
  results.forEach((r, i) => {
    if (r?.kind !== 'result') return;
    if (scopeTags[lookFors[i].id]?.visible_in_transcript === 'no') return;
    let x = r;
    if (r.scope === 'multi_turn_move') x = r.event?.finalRating?.label ? r.event.finalRating : r.building;
    if (x?.label) items.push({ lookFor: lookFors[i].name, label: x.label, confidence: x.confidence });
  });
  const harmItem = { lookFor: 'Harm check (this turn only)', label: 'Harmful', confidence: harmP };
  const ineffective = items.filter((x) => x.label === 'Insufficient' && x.confidence > COACH.ineffective);
  if (harmP > H.counts_as_ineffective_above && harmP <= H.step_in_now_above) ineffective.unshift(harmItem);
  const count = prev.count || 0, problems = prev.problems || [], quiet = prev.quiet || 0;
  if (harmP > H.step_in_now_above) return { coach: { count: 0 }, event: { type: 'step_in_now', reasons: [harmItem], count } };
  if (ineffective.length) {
    const n = count + 1;
    if (n >= coachAfter) return { coach: { count: 0 }, event: { type: 'step_in', reasons: ineffective, count: n } };
    const open = [...new Set([...problems, ...ineffective.map((x) => x.lookFor)])];
    return { coach: { count: n, problems: open, quiet: 0 }, event: { type: 'ineffective', reasons: ineffective, count: n, problems: open } };
  }
  if (!count) return { coach: { count: 0 }, event: { type: 'none', count: 0 } };
  // Did the teacher fix what went wrong?
  const fixed = items.filter((x) => problems.includes(x.lookFor) && ['Strong', 'Attempting'].includes(x.label) && x.confidence > COACH.ineffective);
  const still = problems.filter((p) => !fixed.some((x) => x.lookFor === p));
  if (!still.length) return { coach: { count: 0 }, event: { type: 'reset', why: 'fixed', reasons: fixed, count: 0 } };
  if (quiet + 1 >= COACH.quietTurns) return { coach: { count: 0 }, event: { type: 'reset', why: 'quiet', count: 0 } };
  return { coach: { count, problems: still, quiet: quiet + 1 }, event: { type: 'none', count, fixed, problems: still } };
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
  // The "How it works" page content (password-protected: the examples include taxonomy text)
  docs: route('GET', async (req, res) => send(res, 200, { html: require('../docs/how-it-works.js'), examples: require('../docs/examples.json') })),

  // One teacher turn of the live (turn-by-turn) simulation. The page calls this once per turn, in order,
  // passing back the open sequences it received from the previous turn.
  liveTurn: route('POST', async (req, res) => {
    if (!process.env.TYPESAFE_API_KEY && !MOCK) return send(res, 400, { error: 'No TYPESAFE_API_KEY configured' });
    send(res, 200, await liveTurn(await readBody(req)));
  }),

  // The one-turn harm check for every teacher turn of a transcript (full-transcript page).
  // Each turn is checked alone, so a harmful turn never colours the turns after it.
  harm: route('POST', async (req, res) => {
    if (!process.env.TYPESAFE_API_KEY && !MOCK) return send(res, 400, { error: 'No TYPESAFE_API_KEY configured' });
    const { transcript } = await readBody(req);
    const tpl = readTemplate();
    const turns = transcript.filter((t) => t.isTeacher);
    const out = new Array(turns.length); let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < turns.length) {
        const i = next++; const body = harmBody(turns[i], tpl);
        try { const o = await callJev(body); out[i] = { turn: turns[i].index, p: o.answers.harmful?.noul ?? 0 }; }
        catch (e) { out[i] = { turn: turns[i].index, error: String(e.message || e) }; }
      }
    }));
    send(res, 200, { results: out, stepInAbove: tpl.harm_check.step_in_now_above, ineffectiveAbove: tpl.harm_check.counts_as_ineffective_above });
  }),

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
    const tpl = readTemplate();
    const job = seq ? sequenceJob(lf, transcript, seq) : planJobs([lf], transcript, mode).find((j) => String(j.key) === String(key));
    const t = tplFor(lf, tpl);
    send(res, 200, { model: t.model, state: buildState(lf, job.turn, t), questions: questionsFor(job.turn, t, job.wording, job.seqOptions) });
  }),

  // Streams one JSON line per Jev answer. The page sends one look-for per request (lookForIds),
  // which keeps each request short enough for hosted function time limits.
  evaluate: route('POST', async (req, res) => {
    if (!process.env.TYPESAFE_API_KEY && !MOCK) return send(res, 400, { error: 'No TYPESAFE_API_KEY configured' });
    const { skillIds, transcript, mode = 'scope', excludeLookForIds = [], lookForIds } = await readBody(req);
    const tpl = readTemplate(); // re-read so edits apply without restarting
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
          const t = tplFor(lf, tpl);
          const body = { model: t.model, state: buildState(lf, turn, t), questions: questionsFor(turn, t, wording, seqOptions) };
          try {
            const out = await callJev(body);
            const a = out.answers[qKey];
            const crit = t.questions[qKey].criteria;
            const msg = { kind: 'result', turn: key, lookForId: lf.id, choice: a.choice, label: crit[a.choice] || a.choice, confidence: a.confidence, probabilities: a.probabilities, bands: Object.fromEntries(Object.entries(a.probabilities || {}).map(([k, p]) => [crit[k] || k, p])), model: out.model, tokens: out.usage?.input_tokens };
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

module.exports = { handlers, liveTurn, harmBody, tplFor, advanceSequence, send, MOCK, buildState, lookForsForSkills, splitItems, parseExamples, planJobs, questionsFor, windowFor, findSequences };
