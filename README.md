# Jev Skill Evaluator

Pick skills from the Relay teacher skills taxonomy, add a transcript, and Jev (TypeSafe) rates
every teacher turn against each look-for: Strong / Attempting / Insufficient / Non-Example.

## Run it
To host it for teammates, see DEPLOY.md (Vercel, with a shared password).

On your laptop:
1. Copy `.env.example` to `.env` and paste your TypeSafe key after `TYPESAFE_API_KEY=`
2. In this folder: `node local-server.js`
3. Open http://localhost:4317

`JEV_MOCK=1 node local-server.js` runs with random ratings (no key, no cost) for trying the UI.
Set `APP_PASSWORD` in `.env` (or in Vercel) to require a password for every API call.

Code layout: `lib/core.js` has all the logic; `local-server.js` is the local server (deliberately not named server.js: Vercel would treat that as the whole app); `api/*.js` are the Vercel functions.

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
