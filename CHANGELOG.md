# Changelog

Callers pin `@v1`, which moves to each release. A release is a `VERSION` bump on `main`
([how](docs/reference.md#releasing-the-crew)).

## 1.14.0

- **A PR's own corrections to Scout's pieces are tested (sandbox runs).** Scout lays main's
  `crew.json`, Scout config, seed scripts and core specs over the PR before it runs, so branches
  opened before those existed still have them. That also overwrote what the PR itself corrected: a
  mission that moved a UI and fixed the core spec driving it had main's old spec run against the new
  UI, and failed run after run with nothing Patch could push. The files a PR changes under
  `.github/agents/crew.json`, `.github/scout/`, `scripts/scout/` and `e2e/scout/core/` now come back
  from the PR after main's are laid over; every other core spec is still main's. This gives up the rule
  that a PR can never change what a core spec checks. What covers it instead: Agent HQ flags every
  existing test the crew changed and holds the PR until a person looks, and Iris reviews the spec like
  any code. The GitHub Actions workflow (`scout-qa.yml`) is unchanged and still takes core specs from
  main.
- **A repo with no app** (`"scout": { "app": false }` in `crew.json`). Scout has nothing to open, so it
  runs `commands.test` and sends that to HQ as its one flow. The setup check skips Scout's pieces and
  the probe for such a repo.
- **The crew runs on itself.** This repo now has its own `.github/agents/crew.json` (no app; the tests
  are a syntax check of the shell scripts and `node --test`), so Agent HQ can send Bolt, Iris, Patch and
  Scout here when Shep traces a failure to the crew. It runs in HQ's sandboxes: move the repo there
  under Setup, Runners.

## 1.13.2

- **Bolt can fix the repo's own crew config when that is the mission.** Shep diagnosed a Scout failure
  as a page missing from `scout.warm` in `.github/agents/crew.json` and started a mission to add it.
  Bolt's brief said never to touch `.github/`, so Bolt confirmed the diagnosis, wrote "blocked" and
  changed nothing: no fix for a cause in `crew.json` or `.github/scout/` could ever be made by the
  crew. Bolt may now change those two when the task itself names the change, and Patch may take such a
  pull request further. Workflows, `risk-map.json`, `LESSONS.md` and the notes files stay off limits.

## 1.13.1

- **A review that waits on the pull request's description no longer needs a person.** Iris can ask for
  something the description has to say (which core flows are expected to fail until merge). Patch
  changes code, never a description, so three rounds went by and Radar's reading of the stuck mission
  was `person`: correct that no agent could make the edit, and the mission stopped. `diagnose` has a
  new answer, `pr`, with the text to add in `body`; Agent HQ adds it to the description itself and
  sends Iris back. The brief also treats `person` as the last resort: before giving it, Radar asks
  whether anyone in the crew or HQ could make the change. Needs an HQ that knows `pr`; an older one
  refuses the reading and goes by the error text.

## 1.13.0

- **Radar finds the root cause of any failure on a mission** (mode `diagnose`). Until now it read one
  kind of failure: a smoke test's run that broke before testing. It now reads whatever stopped a
  mission: a run that broke, an agent that failed at its work, Scout's failing flows, a red check, fix
  rounds that didn't clear it. Two new answers say the cause is on the mission's own pull request:
  `code` (the change is wrong) and `test` (the test is wrong, not the change). With a pull request,
  Radar reads that branch, and checks whether the same run would fail without the change before it
  blames it. HQ also sends the fixes Shep already has under way (`known`, as `radar-out/known.txt`),
  and Radar names the one that covers the same cause (`sameAs`) so a second mission failing for it
  waits on that fix instead of getting its own. The diagnosis is stamped with the brief that wrote it
  (`brief: 2`); HQ acts on a mission's failure only from this one. Agent HQ's Shep asks for a reading
  on every mission that fails and acts on the answer
  ([reference](docs/reference.md#diagnosing-a-failure)). A repo's caller workflows need no change.

## 1.12.5

- **A crew-config problem is named on the mission.** A sandbox run that failed because
  `.github/agents/crew.json` was missing, lacked a required key, or a brief used a key it doesn't
  define went to HQ as "The X run failed in the sandbox. See <url>", so finding the cause meant reading
  the log. `crew_render` (`scripts/run/common.sh`) now reports the `[CrewSetup]` line `render.mjs`
  printed as the reason for the failure. The line still reaches the run's log. A `crew.json` that isn't
  valid JSON still gets the generic message.

## 1.12.4

- **An app that stops answering is a broken run, not a failed flow.** `next dev` can go down in the
  middle of a Scout run (it restarts itself when memory runs short, and Scout's agent has a shell). The
  flows that ran while it was down failed on their first page with `net::ERR_CONNECTION_REFUSED`, and
  went to HQ as failed flows: a smoke test showed "Failed", and Bolt was sent to fix a bug that wasn't
  in the app. The recorded run (`scripts/scout/record.sh`, used by the workflow and the sandbox script)
  now checks the app answers first and starts it again when it doesn't (`scripts/scout/start-app.sh`,
  split out of `start-env.sh`), with the end of `next-dev.log` in the run's log so the reason is on
  record. Flows that still failed only because the app wasn't answering are run once more. If it
  happens twice, HQ is told the run broke, with the reason, instead of being sent failed flows; the
  PR comment says the same. Scout's brief tells it to restart the app the same way and never to report
  a dead app as a bug.

## 1.12.3

- **A saved smoke test is the same test on every run, in a sandbox too.** On GitHub Actions the spec
  Scout wrote for a smoke test came back as an artifact on its next run. A sandbox has no artifacts, so
  Scout wrote the test again from the steps each time, and two runs of the same commit could disagree
  (the same test passing, then failing, then passing on an unchanged main). The run now sends the
  smoke spec and its seeds to HQ with the evidence, and the next run of that test starts from them
  (`hq.mjs specs-pull` with `SCENARIO_ID`). HQ keeps the spec of the last run that passed, and drops it
  when the test's steps are edited. Needs an HQ that keeps them; an older HQ answers "none" and the run
  goes on as before.
- **Scout says why when it writes no flow for a PR.** Its notes carry a `No browser flow:` line with the
  reason and what it checked instead. HQ now reads such a run from the committed flows (passed, marked
  as "committed flows only"; a failing one is a failure) instead of as a broken run.

## 1.12.2

- **A PR that changes a core flow is tested by that flow.** Scout's report sorted flows by folder alone,
  so a pull request that repairs or edits a committed spec under `core/` and passes it was reported as
  "No flows specific to this PR were tested", which HQ reads as a run that didn't test the PR. A core
  spec the PR itself adds or edits now counts as a test of the PR (shown as "core, changed in this PR"),
  in the PR comment and in what HQ is sent (`inPr` on the flow; an older HQ ignores it and goes by the
  comment).

## 1.12.1

- **The run's log says what the app asked each fake.** At the end of a Scout run, one line per fake
  service: the routes the app called, how often, and the statuses it got, with a warning for calls that
  had no route. A fake the app never called gets a warning naming the variables that point at it: the
  fake being up says nothing about whether the flow reached it. Scout is told to check the same thing
  before it calls a flow failed, and to seed what the app checks before it makes the call.

## 1.12.0

- **Radar diagnoses a broken run** (mode `diagnose`). Given the end of a failed run's log, Radar reads it
  against the crew's scripts and the repo's config and says where the cause is (`repo`, `crew`, `hq`,
  `person` or `retry`) and what to change, as `radar-out/diagnosis.json`, sent with
  `hq.mjs diagnosis-post`. Agent HQ's Shep asks for it when a smoke test's run breaks before testing,
  opens the fix where the cause is, and runs the test again with the fix applied
  ([reference](docs/reference.md#diagnosing-a-broken-run)). Needs an HQ with run repair; nothing else
  changes for a repo.

## 1.11.4

- **Scout in a sandbox: a repo's Playwright older than the runner's OS.** A Playwright release has
  browsers only for the systems of its day, so a repo pinned to an older one failed every Scout run
  with "Playwright does not support chromium on ..." once the sandbox image moved to a newer OS. When
  the repo's Playwright can't install Chromium, the run now takes the current Playwright (in
  `node_modules` only, for that run) and says so in the log. Bumping `@playwright/test` in the repo
  removes the warning.

## 1.11.3

- **A fake's variables reach the app.** `start-env.sh` wrote the first fake's variable onto the end of the
  repo's last `scout.env` line (no line break between them), so that variable was never set and the
  repo's last one carried it as part of its value. Affected every repo with a fake and a `scout.env`.

## 1.11.2

- **No Node version of the crew's own.** A repo that names none (`.nvmrc`, `crew.json` `node`) used to get
  22; it now gets the current LTS on GitHub Actions and its runner's Node elsewhere. Off Actions, a full
  version (`22.11.0`) is fetched exactly, a major gets its latest release, `NODE_DIST_URL` (or
  `NVM_NODEJS_ORG_MIRROR`) names a mirror, and a platform nodejs.org has no working build for keeps its
  own Node with a warning instead of failing the run.

## 1.11.1

- **Sandbox runs use the repo's Node** (`.nvmrc`, else `crew.json` `node`), as `setup-node` does for a
  workflow. The sandbox image carries one Node (24 today), and its npm refused a lockfile written under
  Node 22: `npm ci` ended every Bolt run on such a repo in seconds. `crew_render` now fetches the repo's
  major from nodejs.org when the runner's differs (checksum verified, kept under `~/.cache/hq-node`) and
  puts it first on `PATH` for the rest of the run.

## 1.11.0

- **Fake services for Scout.** A flow that depends on a third party (Nylas, Stripe, Twilio) can be tested
  without a key: a fake is one JSON definition of the routes it answers, the variables that point the app
  at it, the real hosts it replaces and the webhooks it sends, and `scripts/scout/fakes.mjs` runs them all
  on local ports. Definitions come from Agent HQ's Fakes page (`hq.mjs fakes-pull`) and from the repo's
  `.github/scout/fakes/<name>.json`, which wins by name. `start-env.sh` starts them, sets their variables
  and blocks their real hosts. The format is in `scout/FAKES.md`.
- **Radar drafts a fake from the code** (mode `fake`, started from HQ's Fakes page): the calls the app
  makes, where its address comes from, the webhooks and redirects that come back, and the changes the app
  needs first. Needs an HQ with the Fakes page.

## 1.10.0

- **The crew runs without Agent HQ.** With no `AGENT_HQ_URL` variable, Iris, Scout, Radar's labels and the
  production probe run from the repo's own events and report on the PR and the run. A run that belongs to
  an HQ mission fails early and says what to set.
- **Nova, Bolt, Iris and Patch run on your machine, without Agent HQ.** A Claude Code skill
  (`templates/local/`, installed by `SETUP.md` as `.claude/skills/crew/`): type `/crew` and what to build.
  Nova's mock opens in your browser, you approve it or give notes, Bolt builds it on a new branch, Iris
  reviews, Patch fixes, and it ends with a pull request for a person to land. The skill fetches the briefs
  at `v1` into `.crew/` and renders them with the repo's `crew.json`, so the agents behave as they do on
  GitHub; the briefs and the HQ-driven runs are unchanged. Scout and Rocket are not part of it.
  `scripts/setup/check.mjs` checks the installed skill.
- **Setup asks where the agents run.** `SETUP.md` starts with the choice between GitHub Actions, Vercel
  sandboxes started by an Agent HQ, and your own machine (the `/crew` skill only), and has the steps for
  each. `scripts/setup/check.mjs --sandbox` and `--local` check those setups: no caller workflows, no
  Claude secret and no `AGENT_HQ_URL` are expected there, and `--local` requires the skill.
- **`AGENT_HQ_URL` no longer has a default.** A repo that reports to an HQ must set
  the variable (repo or organization): `gh variable set AGENT_HQ_URL --body https://your-hq.example`.
- The HQ App's name and commit identity are variables (`AGENT_HQ_BOT`, `AGENT_HQ_BOT_EMAIL`); the defaults
  are unchanged.
- `templates/`: starter callers (secrets passed by name), `crew.json`, risk map, notes, and Scout's seed,
  harness, smoke spec and probe.
- `SETUP.md`: install the crew in a repo step by step, by hand or by pointing Claude Code at it, and
  `scripts/setup/check.mjs` to check a repo before its first run.
- The README is now the short version; the full description moved to `docs/reference.md`.
- The briefs say "the owner" where they named a person.
- MIT license.

## 1.9.1

- Releases are cut by a `VERSION` bump: the release workflow tags the version and moves `v1`.
