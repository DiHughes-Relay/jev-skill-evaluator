# Jev Skill Evaluator

Pick skills from the Relay teacher skills taxonomy, add a transcript, and Jev (TypeSafe) rates
every teacher turn against each look-for: Strong / Attempting / Insufficient / Non-Example.

## Run it
To host it for teammates, see DEPLOY.md (Vercel, with a shared password).

On your laptop:
1. Copy `.env.example` to `.env` and paste your TypeSafe key after `TYPESAFE_API_KEY=`
2. In this folder: `node server.js`
3. Open http://localhost:4317

`JEV_MOCK=1 node server.js` runs with random ratings (no key, no cost) for trying the UI.
Set `APP_PASSWORD` in `.env` (or in Vercel) to require a password for every API call.

Code layout: `lib/core.js` has all the logic; `server.js` is the app (page + API), used both on your laptop and as Vercel's entrypoint.

## Pages
- **Full transcript** (`/`): rates a finished transcript, as for end-of-session feedback.
- **Turn by turn** (`/live.html`): replays a transcript one teacher turn at a time, letting Jev see only that turn
  and what came before it, as the simulator would have to when deciding how students and the coach respond next.
  Single and responsive look-fors are rated as in the full run. For multi-turn look-fors, each turn Jev also answers
  `in_progress` (noul), `step` (which observable behavior this turn carries out), `complete` (noul) and a "so far" rating
  (`live` section of `prompt-template.json`). The app keeps one open sequence per look-for between turns: a turn continues
  it when in_progress > 50% and Jev names a step (or in_progress > 70%); two turns without one end it. A sequence that
  completes or ends gets one whole-sequence rating. Lesson-wide look-fors aren't rated live. Logic: `liveTurn` in `lib/core.js`.
- **How it works** (`/how-it-works.html`): the approach, for engineers (covers the full-transcript method so far).

## How it works page
The app's second page (`/how-it-works.html`, linked from the header) documents the Jev approach for engineers:
how the taxonomy is pulled in, the exact requests and responses, and why context is sent the way it is.
Its content is in `docs/how-it-works.js`; the real Jev requests and responses it shows are in `docs/examples.json`.
It's behind the same password as the rest of the app, because the examples include taxonomy text.

## How each Jev call is built
One call per (teacher turn × look-for), in exactly the playground shape:
- **state**: `teacher_skill` (one look-for from the taxonomy), `scoring_band_definitions`,
  `teacher_statement_to_score.transcript_quote`
- **questions**: the single choice question in `prompt-template.json`

Edit `prompt-template.json` to change band definitions, the question, or the model
(`jev-latest` by default). Edits apply on the next run, no restart needed.
Taxonomy mapping: strong_examples → strong, attempting_examples → attempting,
non_examples → insufficient, plus one fixed off-topic line as non_example.

## Taxonomy
`data/taxonomy.json` is a snapshot of the relay-taxonomy database (89 skills, 249 look-fors)
taken 2026-11-10. It does not update itself; ask Claude to refresh it when the taxonomy changes.

## Context by look-for scope (draft)
`data/look-for-scopes.json` holds DRAFT scope tags for every look-for (also in
`look-for-scope-tags.csv` for review). They live only in this app; the real taxonomy is never written to.
With Context set to "By look-for scope":
- Single utterance: just the turn, original question
- Responsive utterance: + 2 turns before, "rate only the transcript_quote"
- Multi-turn move: two passes. Pass 1: each turn with ± 3 turns of context; Jev also answers whether the turn is
  part of a sequence (`sequence_questions`) and which turns start/end it. Runs of consecutive in-sequence turns
  (> 50%) become sequences. Pass 2: each sequence of 2+ turns is rated once, on its last turn, with the whole span
  as context (`instructions_sequence_final`); the cell shows e.g. "turns 2–10" and the other turns say "part of turns 2–10".
  A sequence rated Non-Example is dropped and its turns keep their own ratings.
- Lesson-wide pattern: one call with the whole transcript (`instructions_lesson`)
The "Same for all" options give every look-for the same window instead.
