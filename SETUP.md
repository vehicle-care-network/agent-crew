# Set up the agent crew in a repo

These steps install the crew in one repo. They are written to be followed by a person or by Claude Code.
Steps 1 to 5 give you **Iris** (reviews every PR) and **Radar** (labels every PR's impact) on any repo, in
about ten minutes, and the **`/crew` skill**: Nova, Bolt, Iris and Patch on your own machine, in Claude
Code ([below](#build-something-with-the-crew-on-your-machine)). Steps 6 to 8 are optional: **Scout**, the
production probe, and Agent HQ.

## First: where should the agents run?

**What you need.** All three need a Claude subscription or an Anthropic API key; that is what every run
is billed to. The rest differs:

| | GitHub Actions | Vercel sandboxes | Your machine |
| --- | --- | --- | --- |
| **Cost of the compute** | **Paid**, to GitHub: Actions minutes. Public repos and each plan's monthly allowance are free | **Paid**, to Vercel: Sandbox time on the account your Agent HQ runs on | **Free**: your own computer |
| Claude | Subscription or API key, as a secret on the repo or organization | Subscription or API key, held by your Agent HQ | Subscription or API key, through your Claude Code sign-in |
| Accounts and access | A GitHub repo with Actions on, and admin access to add the secret | An **Agent HQ**, a Vercel account with Sandbox, and HQ's GitHub App on the repo | [Claude Code](https://claude.com/claude-code) on your machine |
| What your repo keeps | The answers in `.github/agents/` and thin caller workflows | Only the answers in `.github/agents/` | The answers in `.github/agents/` and the `/crew` skill |

**The trade-offs.**

| | GitHub Actions | Vercel sandboxes | Your machine |
| --- | --- | --- | --- |
| **Scale** | **Scales with your needs**: GitHub adds runners as pull requests come in, many at once | **Scales with your needs**: HQ starts a sandbox per run, many at once | **Limited by your computer**: runs share its processor and memory, and work only while it is on and Claude Code is open |
| What starts a run | Workflows in your repo, on its own events | Your Agent HQ, when GitHub tells it about a PR, a label or a comment | You, by typing `/crew` in Claude Code |
| Runs by itself | Yes: every pull request is reviewed and labelled | Yes, and HQ drives missions from request to release | No: a pull request nobody ran `/crew` for gets no review |
| Which agents | Iris, Radar and Scout on their own; all seven with an Agent HQ | All seven | Nova, Bolt, Iris and Patch |
| Works without Agent HQ | Yes | No: without an HQ there is nothing to start a sandbox | Yes |
| Best for | A team that wants every pull request checked, with nothing to host | A team with an Agent HQ that wants no workflows or secrets in its repos | One person trying the crew, or building on their own |

With an Agent HQ you can move a repo between GitHub Actions and sandboxes later (Setup → Runners) without
touching the repo again.

The `/crew` skill is installed with all three, so a repo on GitHub Actions or sandboxes can also build
locally. The steps below are for GitHub Actions; [on sandboxes](#on-vercel-sandboxes) and
[on your machine only](#on-your-machine-only) say what changes.

> **If you are Claude, setting this up for someone:**
> - Ask first where the agents should run: **GitHub Actions**, **Vercel sandboxes** or **their own
>   machine** (the table below). Offer sandboxes only when the person has an Agent HQ. Then set up that
>   one: [On Vercel sandboxes](#on-vercel-sandboxes) or [On your machine only](#on-your-machine-only) say
>   what changes from the steps below.
> - Work on a new branch and open a pull request. Never push to the default branch.
> - Never ask for a token or key in the chat, and never write one to a file. Step 3 is the person's: give
>   them the commands to run themselves.
> - Fill the starter files in from the repo (its `package.json`, README, folders, sign-in page). Where the
>   repo doesn't tell you, ask one short question instead of guessing.
> - Don't overwrite a file that already exists; `cp -Rn` below skips them. Say which ones you skipped.
> - Stop after step 5 unless the person asked for Scout, the probe or HQ. Offer Scout only when the app is
>   Next.js on Firebase.
> - Finish by running the check (step 4) and reporting its output as it is.

## What you need for the steps below

- A GitHub repo with Actions enabled, and admin access to it (to add a secret). Not for your machine only.
- The [`gh`](https://cli.github.com) CLI, signed in (`gh auth status`), and Node 20 or newer.
- A Claude subscription or an Anthropic API key. Each run is billed to that account.
- For Scout only: a Next.js app that uses Firebase (Firestore and Auth), and npm.
- For the `/crew` skill only: [Claude Code](https://claude.com/claude-code) on your machine.

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
cp -Rn "$CREW/templates/local/." .
```

That adds four files you edit and a few you don't:

| File | What to do |
| --- | --- |
| `.github/agents/crew.json` | Fill in every field (below). |
| `.github/agents/risk-map.json` | Make the globs match your folders (below). |
| `.github/agents/IRIS.notes.md` | Your review conventions, or delete the file. |
| `.github/workflows/agent-iris.yml`, `agent-radar.yml` | Leave as they are. |
| `.claude/skills/crew/` | Leave as it is: the `/crew` skill for Claude Code. |

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

It reads your files (the `/crew` skill's among them), and with `--github` your repo's secrets, labels and
variables. It changes nothing.
`✗` lines would fail a run; fix them and run it again until it says **Ready**. `!` lines are worth reading.

## 5 · Merge, then watch it work

```bash
git add .github .claude/skills/crew && git commit -m "Set up the agent crew" && git push -u origin crew-setup
gh pr create --fill
```

If your repo's `.gitignore` covers `.claude/`, leave `.claude/skills/crew` out of that `git add`: the skill
then works on your machine only.

Merge that pull request. (Radar labels it, and Iris may review it: she skips a PR that only changes files
under `.github/`, and this one adds the skill too.) Then, on the next pull request anyone opens:

- **Radar** adds an `impact:` label within a minute.
- **Iris** posts a review a few minutes later, and again when new commits change the PR's files.
- Comment `/iris look at the error handling` on any PR to ask her yourself.

Runs are under the repo's **Actions** tab. That's the base setup done.

## On Vercel sandboxes

Your Agent HQ starts every run in a sandbox of its own, so the repo holds no workflows and no secret. The
steps above change like this:

- **Step 2:** copy the answers and the skill, not the workflows, then fill them in as described there:

  ```bash
  mkdir -p .github && cp -Rn "$CREW/templates/base/.github/agents" .github/
  cp -Rn "$CREW/templates/local/." .
  ```

- **Step 3:** skip it. The Claude credential is the one your HQ holds.
- **Step 4:** tell the check which setup this is:

  ```bash
  node "$CREW/scripts/setup/check.mjs" --github --sandbox
  ```

- **Step 5:** commit, push and merge the same way. Nothing runs until HQ knows the repo:
  1. Install your HQ's GitHub App on the repo.
  2. Have the repo added to your HQ's list of repos.
  3. In HQ, open **Setup → Runners** and set the repo to **Vercel sandboxes, every agent**.

  From then on HQ starts Iris and Radar's label on each pull request, and the other agents from missions.
- **Step 6 (Scout):** copy everything except the workflow. HQ starts Scout on the `scout` label or `/scout`:

  ```bash
  cp -Rn "$CREW/templates/scout/." . && rm .github/workflows/scout-qa.yml
  ```

- **Step 7 (the probe)** is a GitHub workflow either way, and uses no Claude.
- **Step 8:** skip it. No caller workflows and no `AGENT_HQ_URL`: HQ gives each run its own address.

To move a repo from GitHub Actions to sandboxes later, set it in HQ's Runners and delete the caller
workflows (`agent-*.yml`, `scout-qa.yml`), or each agent runs in both places.

## On your machine only

The crew runs in Claude Code when you ask it to, and nowhere else. The steps above change like this:

- **Step 2:** copy the answers and the skill, not the workflows, then fill them in as described there:

  ```bash
  mkdir -p .github && cp -Rn "$CREW/templates/base/.github/agents" .github/
  cp -Rn "$CREW/templates/local/." .
  ```

- **Step 3:** skip it. Runs use the Claude account Claude Code is signed in to.
- **Step 4:** tell the check which setup this is. It needs no GitHub access:

  ```bash
  node "$CREW/scripts/setup/check.mjs" --local
  ```

- **Step 5:** commit and merge the same way, so the skill is there for everyone who clones the repo. Then
  use it as described [below](#build-something-with-the-crew-on-your-machine).
- **Steps 6 to 8:** skip them. Scout the agent, the probe and Agent HQ's agents run on GitHub Actions or
  sandboxes. Step 6's commands still start your app on the emulators and run the committed specs locally,
  if you want those.

To add GitHub Actions later, copy `templates/base/.github/workflows/` and do step 3.

## Build something with the crew, on your machine

The `/crew` skill runs the designing and building half of the crew in Claude Code, on your machine, with
no Agent HQ and nothing to host. It uses the Claude account Claude Code is signed in to; the secret from
step 3 is not involved. Open the repo in Claude Code, on a clean working tree, and type:

> /crew add a way to export the bookings table as CSV

1. **Nova** designs it: one HTML mock in your app's own look, opened in your browser from `agent-out/`.
   Approve it, or give notes and she revises it. Nothing is built before you approve. For a change with
   nothing to draw (a bug fix, a backend change) she says so, and you confirm the plan instead.
2. **Bolt** builds the approved mock on a new branch, `crew/<name>`, with tests, and runs your lint,
   type-check and test commands.
3. **Iris** reviews the branch, and **Patch** fixes what she found, for up to three rounds.
4. You try it, ask for changes if you want them, and say when to open the **pull request**. That is the
   first time anything is pushed. Landing it is yours: nothing is merged for you.

The agents follow the same briefs as on GitHub. The skill fetches them at the crew's `v1` release into
`.crew/` and fills them in from your `crew.json` and `*.notes.md`; `.crew/` and `agent-out/` (the mocks,
the review, the summaries) are kept out of git through `.git/info/exclude`. It needs network access to
GitHub to fetch the crew, and `gh` to open the pull request.

Not in the skill: **Scout** (label the pull request `scout` once step 6 is done) and **Rocket**'s release
trains. To run the whole line in the cloud, with a dashboard, several missions at once and releases, see
Agent HQ ([demo](https://agent-hq-demo.vercel.app)) and step 8.

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
| `/crew` isn't offered in Claude Code | The skill isn't in this checkout, or Claude Code started before it was | Step 2's second `cp`, then start a new Claude Code session in the repo |
| `/crew`: `[Crew] Couldn't fetch the crew` | No network access to GitHub, and no earlier copy in `.crew/` | Go online and run it again. For a fork or another version, set `CREW_REPO` or `CREW_REF` |
| `/crew`: `.github/agents/crew.json is missing on this branch` | The setup PR isn't merged yet, so the default branch has no `crew.json` | Merge it, or tell the skill to start from your current branch |
| Scout: `refusing to overwrite` `.env.local` | Local run with your own `.env.local` present | Move it aside for the run |
| Scout: every flow fails at sign-in | `loginAs` doesn't match your sign-in page, or the seed didn't create the account | Step 6: fix `e2e/scout/_support/scout.ts` and `scripts/scout/seed.mjs`, and run it locally |
| Scout: "the agent step failed, so this PR was only smoke-tested" | Claude couldn't start | Step 3 |

Updates arrive on their own: the callers pin `@v1`, which moves with each release
([CHANGELOG.md](CHANGELOG.md)). To change how an agent works in your repo, edit `crew.json` or the
`*.notes.md` files; [docs/reference.md](docs/reference.md) has the rest.
