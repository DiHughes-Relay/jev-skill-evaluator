# Putting the Jev Skill Evaluator on Vercel

The app is ready for Vercel as-is: the page is in `public/`, the server code is in `api/` (thin wrappers) and
`lib/core.js`, and `vercel.json` tells Vercel how to run it. Nothing needs to be built.

## Before you start

- **Who can open it.** Set `APP_PASSWORD` (step 3). Without it, anyone with the link can use your Jev credit
  and see the taxonomy. The page itself loads without a password, but it shows nothing until the password is entered:
  the skills list and every evaluation require it.
- **What goes in.** Transcripts are sent to Vercel (our server code) and to TypeSafe (Jev). Simulator transcripts are fine;
  check real classroom transcripts with student names against Relay's student-data rules first.
- **What's in the repo.** The taxonomy snapshot (`data/taxonomy.json`) and the draft scope tags are internal Relay data,
  so the GitHub repo must be **private**. The `.env` file with your key is excluded and never uploaded.

## Steps

1. **GitHub.** The folder goes into a new private GitHub repository (Claude can do this once you say which account:
   your own, DiHughes-Relay, or the RelayGSE organization).
2. **Vercel → Add New → Project → Import** that repository. Framework preset: **Other**. Leave the build settings at their defaults (no overrides).
3. **Environment variables** (in the import screen, or later under Settings → Environment Variables):
   - `TYPESAFE_API_KEY`: your Jev key
   - `APP_PASSWORD`: a password you'll share with teammates
4. **Deploy.** Vercel gives you a link like `jev-skill-evaluator.vercel.app`. Open it, enter the password, and run the
   sample simulator transcript to check it works.
5. **Share** the link and the password separately (e.g. link in Slack, password in a DM).

## Changing things later

- Push a change to the repository and Vercel redeploys automatically.
- Changing the key or password: edit the environment variable in Vercel, then **Redeploy** (Deployments → ⋯ → Redeploy).
- Each look-for is evaluated in its own request, which keeps every request well inside Vercel's 60-second limit
  (`vercel.json`). A very long transcript (hundreds of teacher turns) on a multi-turn look-for is the case to watch.
- Running it on your laptop still works the same way: `node local-server.js`, then http://localhost:4317.
  If `APP_PASSWORD` is in your local `.env`, the local copy asks for it too.
