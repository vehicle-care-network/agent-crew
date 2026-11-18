# Changelog

Callers pin `@v1`, which moves to each release. A release is a `VERSION` bump on `main`
([how](docs/reference.md#releasing-the-crew)).

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
