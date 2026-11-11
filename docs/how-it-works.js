// Content of the "How it works" page: how we work with Jev, and why.
// Served only through /api/docs (password-protected), because the examples contain taxonomy text.
// Elements with data-ex="path.to.value" are filled in by the page from docs/examples.json
// (real requests and responses captured from Jev on 2026-11-11).
// Elements with data-strip="Look-for name" are drawn from the captured pass-1 runs.
module.exports = String.raw`
<section id="summary">
<h2>In one paragraph</h2>
<p>We ask Jev (TypeSafe's <code>jev-latest</code> model) to rate teacher talk against <b>one look-for at a time</b> from Relay's teacher-skills taxonomy,
on a fixed four-band scale: <b>Strong</b>, <b>Attempting</b>, <b>Insufficient</b>, <b>Non-Example</b> (meaning "not attempted here").
Every call has the same structure: a <code>state</code> containing the look-for's full taxonomy definition, our band definitions and the text to score,
plus one multiple-choice <code>question</code>. What changes from look-for to look-for is <b>how much of the transcript Jev sees</b> and <b>how the question is worded</b>.
That depends on a new, draft classification of every look-for by <b>scope</b>: does the move happen in one sentence, in response to a student,
across several turns, or across the whole lesson? Multi-turn look-fors get a two-pass treatment: Jev first marks which turns belong to a sequence,
then rates each sequence once.</p>
<div class="callout"><b>Status.</b> This is a prototype, tested on one 14-turn simulator transcript and a handful of hand-written lines.
The scope tags are a draft (not part of the official taxonomy) and the numbers below are illustrations, not validation.</div>
</section>

<section id="jev">
<h2>1. Jev in brief</h2>
<p>Jev is a classification model. You don't write a free-text prompt; you send structured JSON describing a situation (<code>state</code>)
and one or more <code>questions</code>, and it returns a probability distribution for each question. It does not explain its answers.</p>
<table class="kv">
<tr><th>Endpoint</th><td><code>POST https://api.typesafe.ai/v1/systemone</code>, header <code>Authorization: Bearer &lt;key&gt;</code></td></tr>
<tr><th>Body</th><td><code>{ model, state, questions }</code>. <code>state</code> is any JSON we choose; the keys and their names are part of the prompt.</td></tr>
<tr><th>Model</th><td>We send <code>jev-latest</code>; responses currently report <code>jev-1.14.0</code>. Pin a version if you need stable results over time.</td></tr>
<tr><th>Question types we use</th><td><code>choice</code>: pick one of named options (<code>criteria</code>), returns <code>choice</code>, <code>confidence</code> and <code>probabilities</code>.<br>
<code>noul</code>: a yes/no-style question with <code>true</code>/<code>false</code> criteria, returns a single number between 0 and 1.</td></tr>
<tr><th>Several questions per call</th><td>Allowed, and answered against the same state. We use this to ask the sequence questions alongside the rating at almost no extra cost.</td></tr>
<tr><th>Cost and size</th><td>Input is priced at $0.042 per million tokens. Our calls run from about 1,100 tokens (one turn, no context) to about 3,800 (a whole 14-turn lesson),
so a 14-turn transcript across a skill's worth of look-fors costs a fraction of a cent.</td></tr>
<tr><th>Errors</th><td>We retry 429, 529 and 5xx up to 4 times, honouring <code>retry-after</code>, otherwise backing off 0.5s, 1s, 2s, 4s. We run up to 6 calls at once.</td></tr>
</table>

<h3>Probability vs. confidence</h3>
<p>A <code>choice</code> answer carries two different numbers, and it matters which one you show. For Whiteboards on turn 7 of our test transcript,
Jev returned probabilities of Strong 61%, Attempting 37%, Insufficient 2%, Non-Example 0%, and a separate <b>confidence</b> of 48% in its choice (Strong).
The probability is "how likely this band is"; confidence is Jev's own certainty in the pick, and it is lower whenever the runner-up is close.
We show both, and treat <b>confidence above 50%</b> as the line for "Jev thinks the teacher attempted this look-for here".
Below about 45%, read the rating as "Jev isn't sure".</p>

<h3>Run-to-run variation</h3>
<p>Identical requests don't return identical numbers. The same turn-7 request came back at 61%/48% once and 65%/53% the next time.
On borderline turns, the label itself can flip between runs (we saw Attempting 37% one run and Non-Example 41% the next).
Small differences between settings are not meaningful without repeat runs.</p>
</section>

<section id="taxonomy">
<h2>2. Getting the taxonomy into the prompt</h2>
<h3>Where it comes from</h3>
<p>The taxonomy lives in the <code>relay-taxonomy</code> Supabase project. We took a <b>read-only snapshot</b> on 2026-11-10 with one SQL query
over three tables: <code>skills</code>, <code>skill_look_fors</code> (the join, which carries Required / Conditional / Optional and a type explanation)
and <code>look_fors</code>. Result: <b>89 skills and 249 unique look-fors</b>. The prototype never writes to the taxonomy database; the snapshot is a local
JSON file that has to be refreshed by hand when the taxonomy changes.</p>
<details><summary>The snapshot query</summary>
<pre>select json_agg(s order by s.name) as snapshot from (
  select sk.id, sk.name, sk.alignment, sk.skill_type, sk.description,
    (select json_agg(json_build_object(
        'look_for_type', slf.look_for_type, 'type_explanation', slf.type_explanation,
        'id', lf.id, 'name', lf.name, 'category', lf.category,
        'teacher_facing_explanation', lf.teacher_facing_explanation,
        'observable_behaviors', lf.observable_behaviors, 'acceptable_variations', lf.acceptable_variations,
        'strong_examples', lf.strong_examples, 'attempting_examples', lf.attempting_examples, 'non_examples', lf.non_examples)
      order by case slf.look_for_type when 'Required' then 0 when 'Conditional' then 1 else 2 end, lf.name)
     from skill_look_fors slf join look_fors lf on lf.id = slf.look_for_id where slf.skill_id = sk.id) as look_fors
  from skills sk
) s</pre></details>

<h3>How a look-for becomes <code>teacher_skill</code></h3>
<p>A user picks skills; we expand them to their look-fors and <b>de-duplicate</b> (a look-for used by several skills is rated once).
Each Jev call carries <b>one</b> look-for. The taxonomy fields are markdown-ish text, so we split them into lists:</p>
<table>
<thead><tr><th>Taxonomy field</th><th>Sent as</th><th>Notes</th></tr></thead>
<tbody>
<tr><td><code>name</code>, <code>look_for_type</code></td><td><code>name</code>, <code>type</code></td><td>Type is Required / Conditional / Optional for the skill it was picked through.</td></tr>
<tr><td><code>teacher_facing_explanation</code></td><td><code>teacher_facing</code></td><td>As-is.</td></tr>
<tr><td><code>observable_behaviors</code>, <code>acceptable_variations</code></td><td>Arrays</td><td>One item per line; leading <code>*</code>, <code>-</code>, <code>•</code> or <code>1.</code> stripped.</td></tr>
<tr><td><code>strong_examples</code></td><td><code>examples.strong</code></td><td>Array of strings, surrounding quotes stripped.</td></tr>
<tr><td><code>attempting_examples</code></td><td><code>examples.attempting</code></td><td><code>{text, why}</code>. Bracketed notes like <code>[Why attempting: …]</code> become <code>why</code>.</td></tr>
<tr><td><code>non_examples</code></td><td><code>examples.insufficient</code></td><td>The taxonomy's "non-examples" are poor attempts at the move, which is our <b>Insufficient</b> band, not our Non-Example band.</td></tr>
<tr><td>(none)</td><td><code>examples.non_example</code></td><td>One fixed off-topic line for every look-for: <i>"Monkeys are my favorite animal in the zoo, they are so funny!"</i> This anchors Non-Example as "nothing to do with the skill".</td></tr>
</tbody></table>
<p><b>Deliberately not sent:</b> the skill the look-for belongs to (name, description, scoring rules), the look-for's <code>category</code>,
and the <code>type_explanation</code> (e.g. "uses 1–3 of these checks strategically"). These describe how look-fors combine into a skill score,
which is a different question from "is this look-for present in this text". Keeping one look-for per call keeps Jev focused on one definition.</p>
<p class="muted">Known wrinkle: some bracketed notes are taxonomy bookkeeping rather than explanations (e.g. <code>[type: missed opportunity]</code>);
they currently pass through into <code>why</code>.</p>
</section>

<section id="request">
<h2>3. The base request</h2>
<p>We kept the structure Diana built in the TypeSafe playground: <code>teacher_skill</code>, <code>scoring_band_definitions</code>,
<code>teacher_statement_to_score</code>, and a single choice question <code>new_choice_1</code>. All wording lives in one editable file,
<code>prompt-template.json</code>, so prompt changes don't need code changes.</p>
<h3>Band definitions (sent in every call)</h3>
<table class="kv">
<tr><th>strong</th><td data-ex="single.request.state.scoring_band_definitions.strong"></td></tr>
<tr><th>attempting</th><td data-ex="single.request.state.scoring_band_definitions.attempting"></td></tr>
<tr><th>insufficient</th><td data-ex="single.request.state.scoring_band_definitions.insufficient"></td></tr>
<tr><th>non_example</th><td data-ex="single.request.state.scoring_band_definitions.non_example"></td></tr>
</table>
<p class="muted">These were written with directions-type look-fors in mind ("verbal-only delivery", "omit time or work mode").
They fit look-fors like Specific Directions well and look-fors like Whiteboards less well; per-category band wording is an open option.</p>

<h3>A complete call: Specific Directions on one turn</h3>
<p>Turn 7 of the test transcript, with no surrounding context. This is exactly the playground format.</p>
<pre data-ex="single.request" data-json></pre>
<p>Jev's answer (Strong, probability 94%, confidence 92%):</p>
<pre data-ex="single.response" data-json></pre>
<p><code>option_a</code>…<code>option_d</code> map back to Strong / Attempting / Insufficient / Non-Example through the question's <code>criteria</code>.</p>
</section>

<section id="journey">
<h2>4. How we got to context-by-scope</h2>
<p>The main design question turned out to be <b>how much transcript to show Jev, and how to tell it which part to rate</b>. Here is the sequence of experiments,
all on the same 14-turn simulator lesson (a grade 1 lesson on dividing shapes into equal parts, with whiteboards and a run of questioning in turns 11–14).</p>

<h3>Step 1: each turn alone</h3>
<p>The first version sent one teacher turn per call, nothing else. It rated the taxonomy's own examples correctly (strong → Strong 100%,
attempting → Attempting 100%, non-example → Insufficient 100%) and an off-topic line as Non-Example on every look-for. Three problems showed up on real transcripts:</p>
<ul>
<li><b>Moves that span turns were rated as failed fragments.</b> Turns 3–5 are one whiteboard check (prompt, work time, reveal). Alone, each piece rated Insufficient or Non-Example.</li>
<li><b>Responses lose their meaning.</b> "Not for this one" only makes sense after a student asks "Can we work with a partner?"</li>
<li><b>Some look-fors can't be seen in text.</b> Multi-Modal Instruction came back Insufficient on almost every turn, because a transcript has no gestures or visuals (and the Insufficient band mentions "verbal-only delivery").</li>
</ul>

<h3>Step 2: two turns either side</h3>
<p>We added the neighbouring turns (teacher and student) as <code>turns_before_quote</code> / <code>turns_after_quote</code>, keeping the original question.</p>
<table>
<thead><tr><th>Whiteboards, turn</th><th>Alone</th><th>±2 turns, original question</th></tr></thead>
<tbody>
<tr><td>3 "draw a shape on your board"</td><td>Insufficient 51%</td><td><b>Attempting 64%</b></td></tr>
<tr><td>4 "divide your shape into equal parts"</td><td>Non-Example 64%</td><td><b>Attempting 66%</b></td></tr>
<tr><td>5 "hold your whiteboards up"</td><td>Insufficient 64%</td><td><b>Attempting 65%</b></td></tr>
<tr><td>1 "Good morning, everyone!"</td><td>Non-Example 100%</td><td class="bad">Non-Example 43%, confidence 24%</td></tr>
<tr><td>9 teacher redraws a student's line</td><td>Non-Example 93%</td><td class="bad">Non-Example 41%, confidence 21%</td></tr>
</tbody></table>
<p><b>Result:</b> the sequence was recognised, but context <b>bled</b> into unrelated turns. The question ("How well did the teacher do on this skill?") never said <i>which</i> text to rate, so Jev partly rated the whole window.</p>

<h3>Step 3: "rate only the transcript_quote"</h3>
<p>Changing only the question wording when context is present:</p>
<pre class="q" data-ex="responsive.request.questions.new_choice_1.instructions"></pre>
<table>
<thead><tr><th>Whiteboards, turn</th><th>±2, original question</th><th>±2, new wording (two runs)</th></tr></thead>
<tbody>
<tr><td>1 greeting</td><td>Non-Example 43%</td><td><b>Non-Example 99% / 99%</b></td></tr>
<tr><td>3 "draw a shape"</td><td>Attempting 64%</td><td>Attempting 63% / 67%</td></tr>
<tr><td>5 "hold your whiteboards up"</td><td>Attempting 65%</td><td>Attempting 58% / 58%</td></tr>
<tr><td>7 "In 60 seconds, hold it up"</td><td>Strong 64%</td><td><b>Strong 72% / 73%</b></td></tr>
<tr><td>9 teacher redraws the line</td><td>Non-Example 41%</td><td>Non-Example 57% / 59%</td></tr>
</tbody></table>
<p><b>Result:</b> bleed mostly fixed, sequence gains kept. This became the default.</p>

<h3>Step 4: the case that broke it (Ask, Ask, Ask)</h3>
<p>Ask, Ask, Ask means asking several students the same question before confirming. In the test lesson it plays out across turns 11–14:
Carter (11), Ella (12), Natalie (13), then the teacher confirms (14). Turn 14 kept coming back <b>Insufficient</b>. We ran it under six setups, twice each:</p>
<table>
<thead><tr><th>Setup</th><th>Jev saw</th><th>Turn 14 on Ask, Ask, Ask</th></tr></thead>
<tbody>
<tr><td>No context</td><td>turn 14</td><td>Insufficient 80%</td></tr>
<tr><td>±2, "rate only the quote"</td><td>12–14</td><td>Insufficient 75%</td></tr>
<tr><td>±3, "rate only the quote"</td><td>11–14</td><td>Insufficient 66–71%</td></tr>
<tr><td>±2, original question</td><td>12–14</td><td>Insufficient 69–74%</td></tr>
<tr><td>±3, original question</td><td>11–14</td><td>Split: Strong 42% / Insufficient 45%</td></tr>
<tr><td>±3, "rate the sequence" wording</td><td>11–14</td><td>Strong 37–44%</td></tr>
</tbody></table>
<p><b>Two lessons:</b> the window has to include the whole move (±2 never shows Carter in turn 11), and the wording that fixed bleed is exactly
what hurts here, because turn 14 on its own asks nothing. <b>No single window and wording works for every look-for.</b>
And the "rate the sequence" wording, applied to everything, made unrelated turns noisy again (turn 9 went from Non-Example 91% to a four-way tie).</p>

<h3>Step 5: let the look-for decide</h3>
<p>The taxonomy has no field saying whether a look-for happens in one utterance or across several turns. (The skill-level type "Sequence" means
look-fors happen in order across a lesson, which is different.) A keyword scan over all 249 definitions for indirect signs (examples with
<code>&lt;Student responds&gt;</code>, "follow-up", "wait time", "3+ different students") flagged likely candidates. Ask, Ask, Ask was the only look-for with all five signs.
But the scan both missed obvious cases (Whiteboards scored only one sign) and over-flagged others (Specific Praise). So we tagged every look-for directly.</p>
</section>

<section id="scopes">
<h2>5. The look-for scope classification (draft)</h2>
<p>Every look-for got one of four scope values. Each value maps to a context window and a question wording.
A simple multi-turn yes/no flag would blur cases 2 and 3, which need different handling.</p>
<table>
<thead><tr><th>Scope</th><th>Meaning</th><th>Count</th><th>Examples</th></tr></thead>
<tbody>
<tr><td><b>Single utterance</b></td><td>Complete in one teacher turn and makes sense on its own.</td><td>139</td><td>Specific Directions, Concision, Sequential Directions, Stamp Transferable Takeaway</td></tr>
<tr><td><b>Responsive utterance</b></td><td>One turn, but only makes sense next to what a student just said or did.</td><td>25</td><td>Specific Praise, Playback, Positive Narration, Cue with Definition, Rule or Procedure</td></tr>
<tr><td><b>Multi-turn move</b></td><td>Only complete across several teacher turns.</td><td>65</td><td>Ask, Ask, Ask; Whiteboards; Close the Loop; Think, Share, Build</td></tr>
<tr><td><b>Lesson-wide pattern</b></td><td>A property of the whole lesson, not of any turn.</td><td>20</td><td>Teach in Spanish, Lesson Fidelity, Speak Slowly, Circulate, Right Time (CFU)</td></tr>
</tbody></table>
<h3>How the tags were made</h3>
<ul>
<li>Four reviewers (Claude agents) each tagged about 62 look-fors against the same written rubric, reading the full definition: behaviors, variations and examples.</li>
<li>Each tag has a confidence (143 high, 105 medium, 1 low) and a one-sentence rationale citing the definition.</li>
<li>Rows are flagged for review where the tag and the keyword scan disagree, or confidence is below high (129 rows flagged in total).</li>
<li>Spot checks: Ask, Ask, Ask and Whiteboards → multi-turn; Specific Praise → responsive; Concision and Specific Directions → single utterance.</li>
</ul>
<h3>A second tag: can a transcript show it at all?</h3>
<p>Each look-for is also tagged <b>visible in a transcript</b>: yes (126), partly (111: gestures, visuals or written work matter) or no (12).
The "no" group, such as Circulate, Scan, Speak Slowly, Pause and Affirming Non-Verbal Cues, explains the Multi-Modal Instruction problem from step 1.
These are candidates to skip by default when scoring transcripts.</p>
<div class="callout"><b>Not part of the official taxonomy.</b> The tags live in this prototype only (<code>data/look-for-scopes.json</code>,
with a review sheet <code>look-for-scope-tags.csv</code> that has blank reviewer columns). They're a proposal for a taxonomy field, pending review by the taxonomy owners.
The review sheet also surfaced 20 look-fors that share a name with another look-for (e.g. two "Close the Loop" entries).</div>
</section>

<section id="perscope">
<h2>6. What we send for each scope</h2>
<p>The "window" is counted in <b>teacher turns</b>, and includes everything said between them (the students' reactions).</p>
<table>
<thead><tr><th>Scope</th><th>Transcript sent</th><th>State key</th><th>Question wording</th></tr></thead>
<tbody>
<tr><td>Single utterance</td><td>The turn only</td><td><code>teacher_statement_to_score.transcript_quote</code></td><td>Original: <i>"How well did the teacher do on this skill?"</i></td></tr>
<tr><td>Responsive utterance</td><td>The turn + 2 teacher turns before</td><td>+ <code>turns_before_quote</code></td><td>"Rate only the transcript_quote" (step 3)</td></tr>
<tr><td>Multi-turn move</td><td>The turn ± 3 teacher turns</td><td>+ <code>transcript_quote_turn</code>, <code>turns_before_quote</code>, <code>turns_after_quote</code></td><td>Sequence wording + 3 sequence questions, then a second pass (section 7)</td></tr>
<tr><td>Lesson-wide pattern</td><td>The whole transcript, one call</td><td><code>lesson_transcript_to_score.transcript</code></td><td><i>"…across the whole lesson_transcript_to_score?"</i></td></tr>
</tbody></table>
<p>Two details that matter: the text to score is always under a key whose name says what it is (<code>transcript_quote</code> vs. <code>lesson_transcript_to_score</code>),
and the question names that key. Responsive look-fors get only <i>preceding</i> turns, because the move responds to what came before. (Sending the following turns too hasn't been tested.)</p>

<details open><summary>Responsive: Cue with Definition, Rule or Procedure on turn 14 (Strong, 87%)</summary>
<p class="muted">teacher_statement_to_score</p><pre data-ex="responsive.request.state.teacher_statement_to_score" data-json></pre>
<p class="muted">questions</p><pre data-ex="responsive.request.questions" data-json></pre>
<p class="muted">response</p><pre data-ex="responsive.response" data-json></pre></details>

<details><summary>Lesson-wide: Right Time (CFU) across the whole lesson (Strong, 83%)</summary>
<p class="muted">questions</p><pre data-ex="lesson.request.questions" data-json></pre>
<p class="muted">response</p><pre data-ex="lesson.response" data-json></pre>
<p class="muted">The state carries <code>lesson_transcript_to_score: { transcript: [ {turn, speaker, text}, … ] }</code> with every teacher and student line.
This call grows with lesson length; a full-length lesson hasn't been tested yet.</p></details>
</section>

<section id="sequences">
<h2>7. Multi-turn look-fors: two passes</h2>
<p>For a multi-turn look-for we want <b>one rating per sequence</b>, placed where it ends, with the turns it covered (e.g. "Whiteboards: Strong, turns 2–10").
Jev doesn't report which turns it was looking at, so we ask it.</p>

<h3>Pass 1: rate each turn, and ask about the sequence</h3>
<p>Each teacher turn gets the ±3 window and the sequence wording, plus three extra questions in the same call:</p>
<ul>
<li><code>in_sequence</code> (noul): is this turn one step of a multi-turn sequence for this skill?</li>
<li><code>seq_start</code>, <code>seq_end</code> (choice): which teacher turn starts / ends it? The options are the teacher turns in the window,
keyed by transcript position (<code>t20</code> = "Turn 11").</li>
</ul>
<details open><summary>Pass 1 for Ask, Ask, Ask on turn 12</summary>
<p class="muted">questions (the window itself, turns 9–14, is omitted here)</p><pre data-ex="pass1.request.questions" data-json></pre>
<p class="muted">response: in sequence 91%, starts at turn 11, ends at turn 14</p><pre data-ex="pass1.response" data-json></pre></details>

<h3>Turning answers into sequences</h3>
<p>Real pass-1 answers for two look-fors across the test lesson. Each cell is one teacher turn, shaded by Jev's <code>in_sequence</code> probability; outlined cells are the sequences we found.</p>
<div class="strip" data-strip="Ask, Ask, Ask"></div>
<div class="strip" data-strip="Whiteboards"></div>
<p>Rules:</p>
<ol>
<li>A sequence is a <b>run of consecutive teacher turns</b> with <code>in_sequence</code> above 50%.</li>
<li>Jev's start/end answers can only <b>split</b> a run (when one turn says the sequence ends before the next turn, and the next says it starts after the previous one).
They never <b>extend</b> a span over turns Jev itself said were not in it. Jev answers start/end even for turns that aren't in any sequence (turn 1 claims "1 to 4"),
and when we trusted those answers, Ask, Ask, Ask ballooned to turns 5–14.</li>
<li>Runs of one turn are dropped (that's a single-turn rating, which pass 1 already gave).</li>
</ol>

<h3>Pass 2: rate each sequence once</h3>
<p>Each sequence gets one more call: the last turn as <code>transcript_quote</code>, the rest of the span as <code>turns_before_quote</code>, and this wording:</p>
<pre class="q" data-ex="pass2.request.questions.new_choice_1.instructions"></pre>
<details><summary>Pass 2 for Ask, Ask, Ask, turns 11–14 (Strong, 72%)</summary>
<pre data-ex="pass2.response" data-json></pre></details>
<p>That rating is attached to the end turn with its span. If pass 2 says <b>Non-Example</b>, the sequence is dropped and its turns keep their pass-1 ratings.
In the summary counts, a sequence counts once.</p>

<h3>Results on the test lesson</h3>
<table>
<thead><tr><th>Look-for</th><th>Sequence found</th><th>Pass 2 rating</th><th>Right?</th></tr></thead>
<tbody>
<tr><td>Ask, Ask, Ask</td><td>turns 11–14</td><td>Strong 53–72% across runs</td><td>Yes. Turn 14 had been Insufficient 75–80% before.</td></tr>
<tr><td>Whiteboards</td><td>turns 2–10</td><td>Strong 55%</td><td>Yes. The span includes setup turns ("get out your whiteboards").</td></tr>
<tr><td>Poll</td><td>turns 8–9</td><td>Strong 58%</td><td>Yes (the thumbs up/down vote).</td></tr>
<tr><td>Ask, Ask, Ask</td><td>turns 8–9</td><td>Insufficient ~50%</td><td class="bad">No. A thumbs vote plus modelling. Found in every run so far; Jev at least rates it low.</td></tr>
</tbody></table>
<p>Cost: the three extra questions ride along in calls we were already making; pass 2 adds one call per sequence (4 on this lesson).</p>
</section>

<section id="reading">
<h2>8. Reading the results</h2>
<ul>
<li><b>Non-Example means "not attempted here"</b>, not "done badly". Counts of attempts only add up Strong, Attempting and Insufficient.</li>
<li><b>"Attempted on this turn"</b> = rated Strong, Attempting or Insufficient with confidence above 50%.</li>
<li><b>Every look-for is rated on every turn</b>, including Conditional and Optional ones. Conditional look-fors that don't apply (Sequential Directions on a one-step direction)
tend to come back Insufficient at low confidence (23–49%), which still inflates Insufficient counts if confidence is ignored.</li>
<li><b>Lesson-wide look-fors</b> get one rating for the lesson, not per turn.</li>
</ul>
</section>

<section id="open">
<h2>9. Open questions and known limits</h2>
<ul>
<li><b>Validation.</b> Everything here is from one simulator lesson plus hand-written lines. We need a set of human-rated transcripts to measure agreement.</li>
<li><b>Scope tags need an owner.</b> 129 of 249 are flagged for review; the five most debatable are Cold Call, Share Student Work, Student Self-Monitoring and Self-Reflection,
Blend Sounds to Read, and Encourage Academic Risk-Taking (keyword scan said multi-turn, tagger said single utterance).</li>
<li><b>False-positive sequences</b> (Ask, Ask, Ask on 8–9). A stricter <code>in_sequence</code> threshold or a pass-2 check that the span matches the look-for are options.</li>
<li><b>Band definitions are directions-centric.</b> They may need per-category wording.</li>
<li><b>Conditional look-fors</b> are rated even where their condition doesn't hold. A preliminary "does this look-for apply here?" question is an option.</li>
<li><b>Not visible in text.</b> 12 look-fors can't be judged from a transcript and 111 only partly.</li>
<li><b>Long lessons.</b> Lesson-wide calls send the whole transcript; behaviour and limits on a full hour-long lesson are untested.</li>
<li><b>No explanations.</b> Jev returns probabilities only. Any "why" we give for a rating is our reading of the definition.</li>
<li><b>Model drift.</b> <code>jev-latest</code> moves; pin a version (currently <code>jev-1.14.0</code>) for comparisons over time.</li>
</ul>
</section>

<section id="code">
<h2>10. Where this lives in the code</h2>
<table class="kv">
<tr><th><code>prompt-template.json</code></th><td>All prompt wording: model, band definitions, the off-topic line, the question, and the context / sequence / lesson wordings. Edits apply on the next run.</td></tr>
<tr><th><code>lib/core.js</code></th><td><code>buildState</code> (taxonomy → state), <code>questionsFor</code> (which wording, plus sequence questions), <code>SCOPE_PLAN</code> and <code>windowFor</code> (what context each scope gets),
<code>findSequences</code> and <code>sequenceJob</code> (the two-pass logic), <code>callJev</code> (HTTP and retries).</td></tr>
<tr><th><code>data/taxonomy.json</code></th><td>Read-only taxonomy snapshot (2026-11-10).</td></tr>
<tr><th><code>data/look-for-scopes.json</code></th><td>Draft scope and visibility tags, keyed by look-for id.</td></tr>
<tr><th><code>docs/examples.json</code></th><td>The real requests and responses shown on this page (captured 2026-11-11).</td></tr>
</table>
</section>
`;
