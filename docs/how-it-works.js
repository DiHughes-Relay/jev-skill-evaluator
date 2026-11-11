// Content of the "How it works" page: our two Jev scoring systems, how they work, and why.
// Served only through /api/docs (password-protected), because the examples contain taxonomy text.
// data-ex="path" is filled by the page from { ...docs/examples.json, template: prompt-template.json }:
//   examples = real requests and responses captured from Jev on 2026-11-11; template = the live prompt file,
//   so band definitions and question wording on this page always match what is sent.
// data-strip="Look-for" draws the captured pass-1 sequence answers; data-coach draws the captured coach run.
module.exports = String.raw`
<section id="summary">
<h2>Two scoring systems, one model</h2>
<p>We use Jev (TypeSafe's <code>jev-latest</code>) to rate a teacher's talk against look-fors from Relay's teacher-skills taxonomy.
The same transcript can be scored in two ways, because the simulator needs ratings for two different jobs:</p>
<table>
<thead><tr><th></th><th>Turn by turn</th><th>End of session</th></tr></thead>
<tbody>
<tr><th>What it's for</th><td>Driving the simulation <b>while it happens</b>: how engaged the virtual students are and how well they understand,
so what they do and which mistakes they make next. And evidence for whether the <b>virtual coach</b> should step in.</td>
<td>The <b>after-action review</b> with the teacher: where they did well and where they have room to grow.
It can also tell a real coach or instructor what the teacher needs to work on.</td></tr>
<tr><th>What Jev can see</th><td>Only the turn being rated and what came before it. Never the students' reaction to that turn, or anything after.</td>
<td>The whole transcript.</td></tr>
<tr><th>What matters most</th><td>Speed (it runs between turns) and avoiding false alarms (a wrong "Insufficient" makes students act confused for no reason).</td>
<td>Completeness and fairness: moves rated as whole sequences, missed moves noticed, whole-lesson patterns judged.</td></tr>
<tr><th>Rating bands</th><td>Strong, Attempting, <b>Building</b>, Insufficient, Non-Example</td><td>Strong, Attempting, Insufficient, <b>Missed</b>, Non-Example</td></tr>
<tr><th>Multi-turn look-fors</th><td>Tracked as they unfold: "under way", then one rating when finished</td><td>Found afterwards and rated once, where the sequence ended</td></tr>
<tr><th>Lesson-wide look-fors</th><td>Not rated</td><td>One rating for the whole lesson</td></tr>
<tr><th>Harm</th><td colspan="2">The same one-turn harm check in both, separate from the look-for ratings</td></tr>
<tr><th>Extra output</th><td>The coach trigger</td><td>A full grid of ratings per turn and look-for, with counts and a CSV</td></tr>
</tbody></table>
<p><b>Why not one system?</b> They need things that can't both be true. Live, the future doesn't exist yet, so a half-finished move can't be judged
as finished, and a missed move can't be known as missed (the teacher might still make it next turn). After the session, everything is known,
and the review is <i>more</i> useful for judging finished moves and naming missed ones. Some bands only make sense in one mode:
<b>Building</b> ("partway, on track") is meaningless once the lesson is over, and <b>Missed</b> doesn't affect students in the moment
(they just stay confused, which is Non-Example). Everything else is shared: the request format, the taxonomy data, the scope tags, the band
definitions, and the harm check.</p>
<div class="callout"><b>Status.</b> Prototype. Tuned on one 14-turn simulator transcript and one made-up 12-turn test transcript
(weak directions, two harmful turns). The look-for scope tags are a draft, not part of the official taxonomy.</div>
</section>

<section id="jev">
<h2>1. Working with Jev</h2>
<p>Jev is a classification model. Instead of a free-text prompt, each request is structured JSON: a <code>state</code> describing the situation
and one or more <code>questions</code>. It returns a probability for each answer and doesn't explain itself.</p>
<table class="kv">
<tr><th>Endpoint</th><td><code>POST https://api.typesafe.ai/v1/systemone</code>, header <code>Authorization: Bearer &lt;key&gt;</code>, body <code>{ model, state, questions }</code></td></tr>
<tr><th>Model</th><td><code>jev-latest</code> (currently reports <code>jev-1.14.0</code>). Pin a version for comparisons over time.</td></tr>
<tr><th>Question types</th><td><code>choice</code>: pick one option; returns <code>choice</code>, <code>confidence</code> and <code>probabilities</code>.
<code>noul</code>: yes/no; returns one number from 0 to 1. Several questions can share one call.</td></tr>
<tr><th>Probability vs. confidence</th><td>Probability is how likely each band is; confidence is Jev's certainty in its pick, lower when the runner-up is close
(e.g. Strong 61% with confidence 48%). We treat <b>confidence above 50%</b> as "Jev means it".</td></tr>
<tr><th>Variation</th><td>Identical requests can differ by a few points between runs; borderline labels can flip. Compare settings with repeat runs.</td></tr>
<tr><th>Cost and speed</th><td>$0.042 per million input tokens; calls are 1,100–4,000 tokens. Live, one teacher turn with 9–23 look-fors plus the harm check takes about 150–300 ms (up to 8 calls in parallel).</td></tr>
<tr><th>Errors</th><td>429, 529 and 5xx are retried up to 4 times, honouring <code>retry-after</code>, else backing off 0.5–4 s.</td></tr>
</table>
</section>

<section id="taxonomy">
<h2>2. Shared: what we tell Jev about a look-for</h2>
<p>Every rating is about <b>one look-for</b>. The taxonomy comes from a read-only snapshot of the <code>relay-taxonomy</code> database
(tables <code>skills</code>, <code>skill_look_fors</code>, <code>look_fors</code>; 89 skills, 249 look-fors, taken 2026-11-10). We never write to the taxonomy.
A user picks skills; the app expands them to look-fors and rates each look-for once, even if several skills share it.</p>
<table>
<thead><tr><th>In <code>teacher_skill</code></th><th>From the taxonomy</th></tr></thead>
<tbody>
<tr><td><code>name</code>, <code>type</code>, <code>teacher_facing</code></td><td>Name; Required / Conditional / Optional for the picked skill; teacher-facing explanation</td></tr>
<tr><td><code>observable_behaviors</code>, <code>acceptable_variations</code></td><td>Split into lists, one item per line</td></tr>
<tr><td><code>type_explanation</code></td><td>Only when the Missed band is offered: says when the look-for is expected (e.g. "Required after whatever other adjusting instruction look-for(s) are used")</td></tr>
<tr><td><code>examples.strong</code> / <code>.attempting</code></td><td>The taxonomy's strong and attempting examples (attempting ones keep their "why" notes)</td></tr>
<tr><td><code>examples.insufficient</code> / <code>.missed</code></td><td>The taxonomy's non-examples, sorted by their <code>[type: …]</code> note (below)</td></tr>
<tr><td><code>examples.non_example</code></td><td>One fixed off-topic line for every look-for: <i>"Monkeys are my favorite animal in the zoo, they are so funny!"</i></td></tr>
</tbody></table>
<table>
<thead><tr><th>Non-example type</th><th>Count</th><th>Goes under</th></tr></thead>
<tbody>
<tr><td>missed opportunity</td><td>73</td><td>Missed (end of session); Attempting where Missed isn't offered</td></tr>
<tr><td>relational harm, learning harm, untyped</td><td>25, 3, 340</td><td>Insufficient. The relational-harm ones are also the harm check's examples.</td></tr>
</tbody></table>
<p><b>Not sent:</b> the skill itself (name, description, scoring rules) and the look-for's category. Those describe how look-fors add up to a skill score,
which is a different question from "is this look-for here?". One look-for per call keeps Jev focused on one definition.</p>

<h3>Look-for scope (draft tags)</h3>
<p>The taxonomy doesn't say whether a look-for happens in one sentence or across several turns, and that decides how much transcript Jev needs.
So every look-for carries a draft <b>scope</b> tag (kept in this prototype only, in <code>data/look-for-scopes.json</code>, with a review sheet):</p>
<table>
<thead><tr><th>Scope</th><th>Meaning</th><th>Count</th><th>Examples</th></tr></thead>
<tbody>
<tr><td><b>Single utterance</b></td><td>Complete in one teacher turn</td><td>139</td><td>Specific Directions, Concision</td></tr>
<tr><td><b>Responsive</b></td><td>One turn, but only makes sense after what a student said or did</td><td>25</td><td>Specific Praise, Playback, Cue with Definition, Rule or Procedure</td></tr>
<tr><td><b>Multi-turn</b></td><td>Only complete across several teacher turns</td><td>65</td><td>Ask, Ask, Ask; Whiteboards; Close the Loop</td></tr>
<tr><td><b>Lesson-wide</b></td><td>A property of the whole lesson</td><td>20</td><td>Right Time (CFU), Lesson Fidelity, Circulate</td></tr>
</tbody></table>
<p>A second tag says whether a text transcript can show the look-for at all: yes (126), partly (111), no (12, e.g. Circulate, Scan, Pause).
"No" look-fors are left out of the coach trigger.</p>
</section>

<section id="bands">
<h2>3. Shared: the rating bands</h2>
<p>All look-for ratings are one <code>choice</code> question with these bands. Definitions below are read live from <code>prompt-template.json</code>.</p>
<table>
<thead><tr><th>Band</th><th>Definition sent to Jev</th><th>Used in</th></tr></thead>
<tbody>
<tr><td><span class="b Strong">Strong</span></td><td data-ex="template.scoring_band_definitions.strong"></td><td>Both</td></tr>
<tr><td><span class="b Attempting">Attempting</span></td><td data-ex="template.scoring_band_definitions.attempting"></td><td>Both</td></tr>
<tr><td><span class="b Building">Building</span></td><td data-ex="template.live.building.band_definitions.building"></td><td>Turn by turn (multi-turn look-fors)</td></tr>
<tr><td><span class="b Insufficient">Insufficient</span></td><td data-ex="template.scoring_band_definitions.insufficient"></td><td>Both</td></tr>
<tr><td><span class="b Missed">Missed</span></td><td data-ex="template.scoring_band_definitions.missed"></td><td>End of session (Required / Conditional look-fors)</td></tr>
<tr><td><span class="b Non-Example">Non-Example</span></td><td data-ex="template.scoring_band_definitions.non_example"></td><td>Both</td></tr>
</tbody></table>
<p><b>Why these lines:</b> Attempting is <i>incomplete but fine</i>; Insufficient is <i>actively bad</i> in a way likely to hurt comprehension or engagement.
Keeping those apart stops "didn't finish" from being treated as "did harm". Non-Example means "not attempted here" and is neutral.
On the turn-by-turn page, multi-turn look-fors use versions of Strong, Attempting and Insufficient worded for "finished or not"
(<code>live.building.band_definitions</code>).</p>
</section>

<section id="harm">
<h2>4. Shared: the harm check</h2>
<p>Harm isn't a look-for band. It's <b>one extra call per teacher turn</b>, independent of any look-for: a single <code>noul</code> question,
"is anything in this turn likely to damage a student's relationship with the teacher, their self-image, or their standing with peers?"</p>
<ul>
<li><b>It sees the turn alone</b>, no earlier turns. When harm was a band inside look-for ratings, look-fors that see earlier turns kept rating perfectly
fine later turns as Harmful (53–84%) after a put-down. A one-turn check can't bleed.</li>
<li><b>No cooldown from Jev.</b> A put-down likely affects a student for several turns, but how long is a rule for the simulator's student-behavior logic, not something Jev should decide.</li>
<li><b>Examples:</b> one written harmful line, the taxonomy's 25 relational-harm non-examples, and three "not harmful" lines (firm, respectful redirection; correcting a wrong answer).</li>
<li><b>Thresholds:</b> over <span data-ex="template.harm_check.step_in_now_above"></span> is egregious (the coach steps in at once);
over <span data-ex="template.harm_check.counts_as_ineffective_above"></span> counts as an ineffective turn. End of session shows any turn over 0.5 as Harmful.</li>
</ul>
<details><summary>A harm check: "Mateo, really? Again? I literally just explained this. Why do you never listen?" (harmful 97%)</summary>
<pre data-ex="harm.request" data-json></pre><p class="muted">response</p><pre data-ex="harm.response" data-json></pre>
<p class="muted">For comparison, a normal simulator turn ("Take a second and, if you think your parts are unequal…") scores:</p><pre data-ex="harm_ok.response" data-json></pre></details>
</section>

<section id="session">
<h2>5. End-of-session scoring</h2>
<p>Every teacher turn is rated against every selected look-for, with the context its scope needs. Jev sees the whole transcript, including what comes after.</p>
<table>
<thead><tr><th>Scope</th><th>Transcript sent</th><th>Question wording</th></tr></thead>
<tbody>
<tr><td>Single utterance</td><td>The turn only</td><td data-ex="template.questions.new_choice_1.instructions"></td></tr>
<tr><td>Responsive</td><td>The turn + 2 teacher turns before</td><td data-ex="template.instructions_with_context"></td></tr>
<tr><td>Multi-turn</td><td>The turn ± 3 teacher turns, then a second pass (below)</td><td data-ex="template.instructions_sequence"></td></tr>
<tr><td>Lesson-wide</td><td>The whole transcript, one call</td><td data-ex="template.instructions_lesson"></td></tr>
</tbody></table>
<p>The text being rated is always under a key that says what it is (<code>transcript_quote</code>, <code>turns_before_quote</code>, <code>lesson_transcript_to_score</code>),
and the question names that key. Telling Jev to "rate only the transcript_quote" is what stops neighbouring turns from colouring a rating.</p>
<details><summary>A complete request: Specific Directions on one turn (Strong, 93%)</summary>
<pre data-ex="full_single.request" data-json></pre><p class="muted">response</p><pre data-ex="full_single.response" data-json></pre></details>

<h3>Multi-turn look-fors: find the sequence, then rate it once</h3>
<p>A move like Ask, Ask, Ask (several students asked the same question before the answer is confirmed) can't be judged on any one turn.
So multi-turn look-fors get two passes:</p>
<ol>
<li><b>Pass 1</b>, every turn: the rating, plus three questions in the same call: <code>in_sequence</code> (noul: is this turn a step of a sequence for the skill?),
<code>seq_start</code> and <code>seq_end</code> (choice: which teacher turn starts / ends it?).</li>
<li><b>Sequences</b> = runs of consecutive teacher turns with <code>in_sequence</code> over 50%. Start/end answers may only <i>split</i> a run, never stretch one
(Jev answers them even for turns that aren't in a sequence, and trusting them made spans balloon). One-turn runs are dropped.</li>
<li><b>Pass 2</b>, one call per sequence: the end turn as <code>transcript_quote</code>, the rest of the span before it, and <i data-ex="template.instructions_sequence_final"></i>
The rating is shown on the end turn with its span ("turns 11–14"); the other turns show "part of turns 11–14". A sequence rated Non-Example or Missed is dropped.</li>
</ol>
<p>Real pass-1 answers on the simulator lesson (shading = <code>in_sequence</code>; outlined = sequences found):</p>
<div class="strip" data-strip="Ask, Ask, Ask"></div>
<div class="strip" data-strip="Whiteboards"></div>
<details><summary>Pass 1 for Ask, Ask, Ask on turn 12: the questions</summary><pre data-ex="full_pass1.request.questions" data-json></pre>
<p class="muted">response</p><pre data-ex="full_pass1.response" data-json></pre></details>
<details><summary>Pass 2 for Ask, Ask, Ask, turns 11–14 (Strong, 69%)</summary><pre data-ex="full_pass2.response" data-json></pre></details>

<h3>Missed: only where the moment called for it</h3>
<p>The review should point out moves the teacher should have made. Missed is strict, because a loose version fires constantly
(almost any turn "could have" used some look-for):</p>
<ul>
<li><b>Only Required or Conditional look-fors</b> can be Missed. Optional ones are one of several strategies a teacher may pick, so skipping one isn't a miss.
For those, the band isn't offered at all.</li>
<li><b>A clear trigger the look-for names</b> (a wrong answer, visible confusion, 3+ step directions) and the turn where the move was due. "Could have used it" is Non-Example.</li>
<li><b>Jev also gets the look-for's <code>type_explanation</code></b>, which is what says when a look-for is expected.</li>
<li><b>One missed moment, one Missed.</b> Look-fors that see neighbouring turns tend to rate several turns in a row as Missed around one moment.
After rating, runs of Missed for the same look-for (at most two teacher turns apart) keep only the most likely one; the others show their next band
with "Missed counted at turn N".</li>
</ul>
<details><summary>Close the Loop on "Hmm, so, uh, whatever, some of you got it and some of you didn't, let's just move on…" (Missed, 90%)</summary>
<pre data-ex="full_missed.request.state.teacher_skill" data-json></pre><p class="muted">response</p><pre data-ex="full_missed.response" data-json></pre></details>

<h3>Lesson-wide look-fors</h3>
<p>One call with the whole transcript under <code>lesson_transcript_to_score</code>, shown in its own panel above the grid.</p>
<details><summary>Right Time (CFU) across the lesson (Strong, 90%)</summary><pre data-ex="full_lesson.response" data-json></pre></details>

<h3>Reading the results</h3>
<ul>
<li>"Look-fors attempted" lists Strong, Attempting and Insufficient ratings with confidence over 50%, plus confident Missed ratings.</li>
<li>The summary row counts Strong / Attempting / Insufficient / Missed per look-for; a sequence counts once. The Harm check column counts harmful turns.</li>
</ul>
</section>

<section id="live">
<h2>6. Turn-by-turn scoring</h2>
<p>The page replays a transcript one teacher turn at a time, the way the simulator would call it. For each turn it sends only the turns up to and
including that one (the server also cuts anything later), and the state it kept from the previous turn: which multi-turn sequences are open, and the coach's count.</p>
<table>
<thead><tr><th>Look-for scope</th><th>Live treatment</th></tr></thead>
<tbody>
<tr><td>Single utterance, responsive</td><td>Same request as end of session (those windows only look back already), without the Missed band</td></tr>
<tr><td>Multi-turn</td><td>Two calls in parallel: one says <i>where the sequence is</i>, one says <i>how it's going</i> (below)</td></tr>
<tr><td>Lesson-wide</td><td>Not rated: there's no "whole lesson" yet</td></tr>
</tbody></table>

<h3>Multi-turn look-fors: where it is, and how it's going</h3>
<ul>
<li><b>Where the sequence is</b> (step-based call): <code>in_progress</code> (noul: does this turn start or continue a sequence?), <code>step</code>
(choice: which of the look-for's observable behaviors does this turn carry out, or none?), and <code>complete</code> (noul: is the sequence finished?).
The window reaches back to the start of the open sequence (up to 8 teacher turns), else 3.</li>
<li><b>A turn continues a sequence</b> only if <code>in_progress</code> is over 50% <i>and</i> Jev names a step, or <code>in_progress</code> is over 70%.
Two teacher turns in a row without that end it. Without the step requirement, an open sequence "sticks": with the sequence in view, Jev rates unrelated later turns 50–60% in progress.</li>
<li><b>How it's going</b> (five-band call): Strong / Attempting / <b>Building</b> / Insufficient / Non-Example, with the live band definitions.
This is the rating students and the coach react to while the move is under way.</li>
<li><b>When a sequence completes or ends</b>, it gets one whole-sequence rating (the same pass-2 call as end of session; the whole span is already in the past).</li>
</ul>
<p><b>Why two calls:</b> each method is good at one half. Asked "how's it going so far?" on the old four bands, Jev split between Strong and Attempting
at low confidence, because "components missing" fit a move that simply wasn't finished. Building fixes that (Whiteboards turns 2–4: Building 82–96%).
But letting the five-band answer also decide when a move had finished made it end moves early and confirm false ones: an unsure mid-move turn came back
Strong, Attempting or Insufficient at 30–40%, which reads as "finished". The step-based answers keep the sequence boundaries honest.</p>
<details><summary>Whiteboards, turn 3 of the simulator lesson: both requests and the answers</summary>
<p class="muted">answers (parsed)</p><pre data-ex="live_multi.answers" data-json></pre>
<p class="muted">step-based request: questions</p><pre data-ex="live_multi.step_request.questions" data-json></pre>
<p class="muted">five-band request: band definitions and question</p><pre data-ex="live_multi.building_request.state.scoring_band_definitions" data-json></pre><pre data-ex="live_multi.building_request.questions" data-json></pre></details>

<h3>What each rating means for the room</h3>
<table>
<thead><tr><th>Rating</th><th>Students</th><th>Coach</th></tr></thead>
<tbody>
<tr><td><span class="b Strong">Strong</span></td><td>Engagement and comprehension up</td><td>No</td></tr>
<tr><td><span class="b Attempting">Attempting</span></td><td>Slight lift, some risk of confusion</td><td>No</td></tr>
<tr><td><span class="b Building">Building</span></td><td>On track; nothing to react to yet</td><td>No</td></tr>
<tr><td><span class="b Non-Example">Non-Example</span></td><td>No change (includes a missed move)</td><td>No</td></tr>
<tr><td><span class="b Insufficient">Insufficient</span></td><td>Comprehension or engagement drops</td><td>Counts toward the ineffective-turn limit</td></tr>
<tr><td><span class="b Harmful">Harm check</span></td><td>A student's relationship, self-image or standing takes a hit (duration set by student logic)</td><td>Over 0.7: steps in now. 0.5–0.7: counts as ineffective</td></tr>
</tbody></table>

<h3>The coach trigger</h3>
<p>The coach is meant to watch 2–3 ineffective turns go by before stepping in, unless something egregious happens.</p>
<ul>
<li><b>Ineffective turn:</b> any look-for rated Insufficient with confidence over 50% (for multi-turn look-fors, the five-band rating, or the whole-sequence
rating on the turn a sequence finishes), or a harm check of 0.5–0.7. Look-fors a transcript can't show don't count.</li>
<li><b>Steps in</b> after 2 or 3 ineffective turns (a setting), or immediately on a harm check over 0.7. Stepping in resets the count.</li>
<li><b>The count resets</b> when the teacher <i>fixes what went wrong</i> (the look-fors that were Insufficient come back Strong or Attempting), or after 4 teacher turns with nothing ineffective.
Good ratings on unrelated look-fors don't reset it: with 20+ look-fors selected, something unrelated is nearly always rated well, and the count would never build.</li>
<li><b>It only sees the selected look-fors.</b> Weak directions only count if the directions look-fors are selected, so each simulation needs the right ones.</li>
</ul>
<p>The made-up test transcript, live, coach after 3 (Checking for Understanding Strategy + Setting Expectations):</p>
<div data-coach></div>
</section>

<section id="limits">
<h2>7. Known limits and open questions</h2>
<ul>
<li><b>Validation.</b> Two transcripts, one of them made up. We need human-rated transcripts to measure agreement.</li>
<li><b>Scope tags need an owner.</b> 129 of 249 are flagged for review. They'd be worth proposing as a taxonomy field.</li>
<li><b>Taxonomy gaps.</b> 340 non-examples are untyped and default to Insufficient, though some describe something missing rather than done badly.
Some look-fors (e.g. Close the Loop) have no Insufficient examples at all once typed ones are sorted out.</li>
<li><b>Who was harmed.</b> The harm check says a turn is harmful, not which student. The simulator needs that; a follow-up question could pick from the students named.</li>
<li><b>Missed merging.</b> Two genuine misses of the same look-for within two turns count as one.</li>
<li><b>Step answers are rough.</b> For Ask, Ask, Ask, Jev never picked "calls on 3+ different students", so "steps seen" understates progress.</li>
<li><b>Endings are noticed late live.</b> A sequence without a clear finish is marked ended two turns after it stops.</li>
<li><b>Model drift.</b> <code>jev-latest</code> moves; pin a version for comparisons.</li>
</ul>
</section>

<section id="code">
<h2>8. Where this lives</h2>
<table class="kv">
<tr><th><code>prompt-template.json</code></th><td>All wording and thresholds: band definitions, questions, context wordings, sequence questions, the live (Building) bands,
the harm check, the non-example type mapping. Edits apply on the next run.</td></tr>
<tr><th><code>lib/core.js</code></th><td><code>buildState</code>, <code>questionsFor</code>, <code>planJobs</code> / <code>windowFor</code> (context per scope), <code>findSequences</code> and <code>sequenceJob</code> (two passes),
<code>tplFor</code> (when Missed is offered), <code>collapseMissed</code>, <code>liveTurn</code>, <code>advanceSequence</code>, <code>harmBody</code>, <code>coachStep</code>, <code>callJev</code>.</td></tr>
<tr><th><code>data/</code></th><td><code>taxonomy.json</code> (read-only snapshot) and <code>look-for-scopes.json</code> (draft scope and visibility tags).</td></tr>
<tr><th><code>samples/</code></th><td>The made-up coach test transcript, as text and as a simulator CSV.</td></tr>
<tr><th><code>docs/examples.json</code></th><td>The requests and responses on this page (captured 2026-11-11).</td></tr>
</table>
</section>
`;
