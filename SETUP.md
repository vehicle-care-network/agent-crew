# Set up the agent crew in a repo

These steps install the crew in one repo. They are written to be followed by a person or by Claude Code.
Steps 1 to 5 give you **Iris** (reviews every PR) and **Radar** (labels every PR's impact) on any repo, in
about ten minutes. Steps 6 to 8 are optional: **Scout**, the production probe, and Agent HQ.

> **If you are Claude, setting this up for someone:**
> - Work on a new branch and open a pull request. Never push to the default branch.
> - Never ask for a token or key in the chat, and never write one to a file. Step 3 is the person's: give
>   them the commands to run themselves.
> - Fill the starter files in from the repo (its `package.json`, README, folders, sign-in page). Where the
>   repo doesn't tell you, ask one short question instead of guessing.
> - Don't overwrite a file that already exists; `cp -Rn` below skips them. Say which ones you skipped.
> - Stop after step 5 unless the person asked for Scout, the probe or HQ. Offer Scout only when the app is
>   Next.js on Firebase.
> - Finish by running the check (step 4) and reporting its output as it is.

## What you need

- A GitHub repo with Actions enabled, and admin access to it (to add a secret).
- The [`gh`](https://cli.github.com) CLI, signed in (`gh auth status`), and Node 20 or newer.
- A Claude subscription or an Anthropic API key. Each run is billed to that account.
- For Scout only: a Next.js app that uses Firebase (Firestore and Auth), and npm.

## 1 · Get the crew's files

From the root of your repo:

```bash
CREW="${TMPDIR:-/tmp}/agent-crew"
rm -rf "$CREW" && git clone --depth 1 https://github.com/vehicle-care-network/agent-crew "$CREW"
git switch -c crew-setup
```

The clone is only a source for the starter files and the check script. Nothing from it is committed
except what you copy.

## 2 · Copy the base files and fill them in

```bash
cp -Rn "$CREW/templates/base/." .
```

That adds four files you edit and two you don't:

| File | What to do |
| --- | --- |
| `.github/agents/crew.json` | Fill in every field (below). |
| `.github/agents/risk-map.json` | Make the globs match your folders (below). |
| `.github/agents/IRIS.notes.md` | Your review conventions, or delete the file. |
| `.github/workflows/agent-iris.yml`, `agent-radar.yml` | Leave as they are. |

**`crew.json`**, field by field:

- `product`: one sentence on what the product is and who uses it. Every agent reads it first.
- `node`: your Node major version. Ignored when the repo has an `.nvmrc`.
- `commands`: what to run from the repo root. Take them from `package.json`'s scripts:
  - `install`: `npm ci`. (npm is the tested path. With pnpm or yarn, use that tool's frozen install.)
  - `lint`, `typecheck`, `test`, `format`: the real commands, for example `npm run lint`,
    `npx tsc --noEmit`, `npm test`. Write `true` for any the repo doesn't have. Never invent a script.
- `paths`: where the code is, so agents know where to look: `source` (a list of folders), `models` (where
  the data types or schema live), `tests` (a folder or glob).
- `scout`: leave as it is until step 6.

**`risk-map.json`** sorts every changed file into a tier; the highest match wins and anything unmatched is
`normal`. Keep the starter's shape and change the globs to your repo: `critical` for sign-in, access rules,
money and secrets; `high` for the API and the data's shape; `low` for tests, docs and tooling. Check it with
a few real paths:

```bash
mkdir -p .crew && cp -R "$CREW/scripts" .crew/ && node .crew/scripts/agents/impact.mjs app/api/users/route.ts README.md; rm -rf .crew
```

## 3 · Add your Claude credential (the person does this)

Either one. The subscription token is used when both are set.

```bash
claude setup-token                      # prints a long-lived token for your Claude subscription
gh secret set CLAUDE_CODE_OAUTH_TOKEN   # paste it when asked
```

or

```bash
gh secret set ANTHROPIC_API_KEY         # paste an API key from console.anthropic.com
```

Set it on the organization instead (`--org your-org --visibility all`) to cover every repo at once.

Also check **Settings → Actions → General**: "Allow all actions and reusable workflows", or an allow list
that includes `vehicle-care-network/agent-crew@*` and `anthropics/claude-code-action@*`.

## 4 · Check it

```bash
node "$CREW/scripts/setup/check.mjs" --github
```

It reads your files, and with `--github` your repo's secrets, labels and variables. It changes nothing.
`✗` lines would fail a run; fix them and run it again until it says **Ready**. `!` lines are worth reading.

## 5 · Merge, then watch it work

```bash
git add .github && git commit -m "Set up the agent crew" && git push -u origin crew-setup
gh pr create --fill
```

Merge that pull request. (Iris doesn't review a PR that only changes the crew's own setup, so nothing runs
on this one.) Then, on the next pull request anyone opens:

- **Radar** adds an `impact:` label within a minute.
- **Iris** posts a review a few minutes later, and again when new commits change the PR's files.
- Comment `/iris look at the error handling` on any PR to ask her yourself.

Runs are under the repo's **Actions** tab. That's the base setup done.

---

## 6 · Add Scout (optional: Next.js on Firebase)

Scout starts your app with `next dev` on the Firebase emulators, with a demo project and dummy keys, so it
cannot reach real data. It needs to be able to sign in: your app must offer an email and password form when
it runs on the Auth emulator.

```bash
cp -Rn "$CREW/templates/scout/." .
npm install --save-dev @playwright/test
npm install firebase-admin              # skip if it is already a dependency
gh label create scout --description "Scout tests this PR on every push" --color 5319e7
```

Then make these match your app. Each has a `TODO` where it needs you:

| File | What to do |
| --- | --- |
| `.github/agents/crew.json`, `scout` | `port` and `readyPath` (a page that answers once the app is up), `warm` (pages to compile first), `env` (variables the app needs to start, **dummy values only**), `firebaseRules` (`true` when the repo has `firestore.rules`), `blockHosts` (third-party hosts the app must not reach). |
| `scripts/scout/seed.mjs` | The accounts and the little data a signed-in user needs. |
| `e2e/scout/_support/scout.ts` | `loginAs`: the selectors of your sign-in page, and what shows once signed in. |
| `e2e/scout/core/smoke.spec.ts` | Keep it to "the app loads" and "the seeded user signs in". |
| `.github/scout/core-flows.md` | Five to fifteen journeys that must not break. |
| `.github/agents/SCOUT.notes.md` | The seeded accounts, and what can't be tested without real keys. |

Try it on your machine before pushing (needs Java 21 for the emulators). Move your own `.env.local` aside
first: Scout writes its own and refuses to overwrite yours.

```bash
mkdir -p .crew && cp -R "$CREW/scripts" "$CREW/briefs" "$CREW/scout" "$CREW/playwright.scout.config.ts" .crew/
printf '%s\n' .crew/ scout-out/ firebase.scout.json >> .git/info/exclude
node .crew/scripts/setup/render.mjs
SCOUT_APP_PORT=3100 SCOUT_FS_PORT=18080 SCOUT_AUTH_PORT=19099 bash .crew/scripts/scout/start-env.sh
npx playwright install chromium
SCOUT_BASE_URL=http://localhost:3100 npx playwright test -c .crew/playwright.scout.config.ts
bash .crew/scripts/scout/stop-env.sh && rm -f .env.local firebase.scout.json
```

When the smoke spec passes there, run the check again, commit, and merge. Then on any pull request:

- add the **`scout`** label (Scout re-tests on every push while it stays), or
- comment **`/scout`**, or `/scout check the booking form on a phone`.

Scout posts one comment on the PR with each flow's result. The screenshots, videos and Playwright report
are in the run's artifacts (`scout-evidence`).

## 7 · Add the production probe (optional)

A few read-only Playwright checks against your live site every 15 minutes. No AI, no Claude usage.

```bash
cp -Rn "$CREW/templates/probe/." .
```

Add the site to `crew.json`, and edit `e2e/scout/probe/up.spec.ts` to check what proves your site is up:

```json
  "probe": { "url": "https://www.example.com" }
```

A failed probe turns the run red, and GitHub notifies you as it does for any failed workflow.

## 8 · Connect Agent HQ (optional)

With an Agent HQ, the rest of the crew (Nova, Bolt, Patch, Rocket) works here too, and every run reports
to your dashboard.

```bash
cp -Rn "$CREW/templates/hq/." .
gh variable set AGENT_HQ_URL --body https://your-hq.example
```

Install your HQ's GitHub App on the repo, protect the default branch (pull requests required, no force
pushes), and if the App isn't `vcn-agent-hq`, set `AGENT_HQ_BOT` and `AGENT_HQ_BOT_EMAIL` too
([reference](docs/reference.md#access)). HQ's Setup view then checks the rest.

## When something goes wrong

| What you see | Why | Fix |
| --- | --- | --- |
| `[CrewSetup] .github/agents/crew.json is missing` or `is missing: …` | The file isn't on the branch the run used, or lacks a key | Step 2, then the check |
| `Environment variable validation failed` in the Claude step | No Claude credential reached the run | Step 3. If the secret is set, the caller must pass it by name, as the templates do, not `secrets: inherit` |
| The workflow fails at once with "not allowed" or "was not found" | The repo's Actions settings block outside workflows | Step 3, the Actions setting |
| `AGENT_HQ_URL is not set, and … belongs to an Agent HQ mission` | An HQ agent's workflow ran without an HQ address | Step 8, or delete the `templates/hq` workflows |
| Nothing runs when you comment `/iris` or `/scout` | Comment triggers only work once the workflow is on the default branch, and only for people who belong to the repo | Merge the setup PR first |
| Iris didn't review a PR | It is a draft, comes from a fork, or only changes the crew's own files | Mark it ready, or comment `/iris` |
| Scout: `refusing to overwrite` `.env.local` | Local run with your own `.env.local` present | Move it aside for the run |
| Scout: every flow fails at sign-in | `loginAs` doesn't match your sign-in page, or the seed didn't create the account | Step 6: fix `e2e/scout/_support/scout.ts` and `scripts/scout/seed.mjs`, and run it locally |
| Scout: "the agent step failed, so this PR was only smoke-tested" | Claude couldn't start | Step 3 |

Updates arrive on their own: the callers pin `@v1`, which moves with each release
([CHANGELOG.md](CHANGELOG.md)). To change how an agent works in your repo, edit `crew.json` or the
`*.notes.md` files; [docs/reference.md](docs/reference.md) has the rest.
