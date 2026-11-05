# The agent crew

The crew Agent HQ (https://agent-hq-cyan.vercel.app) runs in every repo it works on: **Nova** designs
the mock, **Bolt** builds, **Iris** reviews, **Patch** fixes, **Scout** tests in a browser, **Radar** labels
impact, triages and audits, **Rocket** lands the finished PRs into a release and ships it. This repo holds
the crew once. A repo that uses the crew keeps only its own answers (what the product is, how to lint and
test it, what Scout can log in as) and seven thin workflows that call the ones here. Change the crew here,
tag a release, and every repo gets it.

```
agent-crew (this repo)                          a repo the crew works in
├── action.yml          "set up the crew"       ├── .github/workflows/agent-nova.yml   ─┐
├── .github/workflows/  reusable workflows      │   agent-bolt.yml, agent-iris.yml,     │ thin callers,
│   agent-nova.yml, agent-bolt.yml,             │   agent-patch.yml, agent-radar.yml,   │ `uses: …@v1`
│   agent-iris.yml, agent-patch.yml,            │   agent-rocket.yml, scout-qa.yml     ─┘
│   agent-radar.yml, agent-rocket.yml,          ├── .github/agents/crew.json           the repo's answers
│   scout-qa.yml                                │   risk-map.json, LESSONS.md,
├── briefs/  NOVA BOLT IRIS PATCH RADAR ROCKET  │   {NOVA,BOLT,IRIS,PATCH,RADAR,SCOUT,ROCKET}.notes.md (optional)
├── scripts/agents/  hq, usage, impact, …       ├── .github/scout/core-flows.md
├── scripts/scout/   report, evidence, env, …   ├── scripts/scout/seed.mjs, fixtures.mjs
├── scripts/rocket/    land.mjs (the landing loop) ├── e2e/scout/_support/scout.ts  (Playwright harness + logins)
└── playwright.scout.config.ts                  └── e2e/scout/core/*.spec.ts
```

## Scout's modes

`pr` tests one pull request and posts on it. `regression` tests the latest main across every flow in
`.github/scout/core-flows.md` (Radar starts it when enough has merged; HQ's Health card runs it by hand),
or, given a commit and a mission, a release branch Rocket built, reporting to that release in HQ.
`smoke` runs one scenario HQ hands it (a smoke test saved in HQ, on its schedule: about every 24 hours,
after each production deploy, or by hand) on main or on the deployed commit, reusing the spec it wrote
last time; the result goes to the HQ mission that started it, never to a PR.

## Designs: Nova

Every mission that starts with a mock starts with **Nova** (`agent-nova.yml`): HQ sends her the task and
she makes one self-contained HTML mock in the app's own look (brief: `briefs/NOVA.md`), uploaded to HQ for
approval. Notes on it send her a revision (`mock_url` is the version to continue from, `feedback` the
numbered notes); approval sends the mock to Bolt to build. She also redesigns an open PR: given
`pr_number`, she works on that PR's branch and mocks what it does now plus the asked-for improvements;
when that mock is approved, HQ sends Bolt with `branch` set to the PR's branch, and Bolt builds the new
mock on top of the existing code and pushes to the same branch (a plain push, never forced), after which
the PR goes back through Iris and Scout. A design can also stay a design: HQ keeps it without building.
Her model is chosen in HQ like the others, else the repo variable `AGENT_MODEL_NOVA`.

## Releases: Rocket

A release is a batch of the crew's finished PRs (Iris approved, Scout passed, checks green, no conflicts)
landed together. HQ starts one on its schedule, or when you press Release there, and sends **Rocket**
(`agent-rocket.yml`) the PRs in landing order. Rocket cuts `release/<version>` from the default branch
(`version` is `v2026.11.05`, then `.2`, `.3` for later releases the same day), merges each PR into it with a
merge commit, and runs the repo's `typecheck`, `lint` and `test` after every one. Clean merges need no
agent and cost nothing. A conflict or a failing check brings in Rocket's agent (brief: `briefs/ROCKET.md`),
which resolves it on the release branch keeping both PRs' behaviour; a PR it can't make work is left out
with a reason the person reads on its mission. Rocket pushes the release branch, and the repo's staging
branch too when `crew.json` names one:

```json
  "release": { "stagingBranch": "staging" }
```

HQ then opens the release PR, sends Scout for a regression run on it (`mode: regression` with the branch's
`sha` and the release's `mission_id`), and once that passes merges the release PR into main with a merge
commit (so GitHub marks every landed PR merged), tags it and publishes a GitHub Release. A failed regression
holds the release for you and files the failures as Ideas. Rocket's model is chosen in HQ like the others,
else the repo variable `AGENT_MODEL_ROCKET`. Rocket's commits are "Land #N: <title>" and, after an
integration fix, "Fix the integration of #N for <version>".

## How a run works

1. HQ (or a label, a `/scout` comment, a schedule) starts the repo's thin workflow. HQ always sends one
   input, `params`, a JSON string, so the contract between HQ and the repos never drifts.
2. The thin workflow calls the reusable one here at a pinned tag.
3. The reusable workflow checks the repo out, then runs the **setup action** (`action.yml`): it lays this
   repo's scripts, briefs and Playwright config into `.crew/` in the checkout (kept out of git through
   `.git/info/exclude`), and renders the briefs with the repo's `.github/agents/crew.json` and notes.
4. The agent runs with `.crew/briefs/<AGENT>.md`, reports to HQ with `.crew/scripts/agents/hq.mjs`
   (GitHub OIDC, no HQ secret anywhere), and Bolt and Patch push as the HQ App with a token HQ mints.

## What a repo provides

`.github/agents/crew.json`:

```json
{
  "product": "SmogSupport, the admin and shop-management app for smog stations",
  "node": "22",
  "commands": {
    "install": "npm ci",
    "format": "npm run format",
    "lint": "npm run lint",
    "typecheck": "npx tsc --noEmit",
    "test": "npm test"
  },
  "paths": { "source": ["app/", "views/"], "models": "app/models/", "tests": "app/__tests__/" },
  "scout": {
    "port": 3000,
    "readyPath": "/login",
    "warm": ["/admin"],
    "env": { "SOME_API_KEY": "scout-dummy" },
    "firebaseRules": true,
    "blockHosts": ["api.stripe.com"]
  }
}
```

- `node` is used when the repo has no `.nvmrc`. `commands` are run with `bash -c` from the repo root.
- `paths` only feed the briefs' prose. `scout.env` values may use `${APP_PORT}`.
- `scout.blockHosts` is applied runner-wide (`/etc/hosts`), so it must never name Agent HQ itself (Scout
  reports its verdict there, and a blocked HQ leaves the mission on "Scout is testing" for good) nor
  `api.anthropic.com` (Scout's own agent runs on it; blocked, every run dies with ECONNREFUSED before
  testing, HQ records a QA error). The script skips both with a warning if a repo lists them anyway. To
  keep the app under test from calling Claude, leave `ANTHROPIC_API_KEY` out of `scout.env`: Scout's
  environment never sets it.
- `.github/agents/<AGENT>.notes.md` (NOVA, BOLT, IRIS, PATCH, RADAR, SCOUT, ROCKET): the repo's own additions to a
  brief, inserted under "This repo". Keep them short and concrete: conventions the linter can't catch,
  what Scout can log in as, what it can't test here.
- `.github/agents/risk-map.json` (Radar's impact tiers), `.github/scout/core-flows.md`, the base seed
  (`scripts/scout/seed.mjs`, `fixtures.mjs`), the Playwright harness with the repo's login helpers
  (`e2e/scout/_support/scout.ts`; it must compile under the repo's own `tsc`, which is why it isn't shared),
  and the core smoke specs stay in the repo: they describe the product, not the crew. On a PR, Scout takes
  the core specs, seed and config from `main` (a PR can't weaken what they check) but the harness from the
  PR when it has one: a PR that changes the header fixes the sign-in helper in the same PR, and a Patch fix
  to it takes effect.
- `release.stagingBranch` (optional): the branch Rocket also force-pushes each release to, so the repo's
  staging site shows what is about to ship.
- Secrets `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) at org level (or on the repo, outside the org,
  where the callers must also pass them by name: see Access), labels `agent` and `scout`, the HQ GitHub App
  installed, and branch protection on `main`.

## Models

Right before each Claude step, the workflow asks HQ which model you chose for that agent (`hq.mjs model
<agent>`, the **Models** card in HQ's Spend view) and uses it; with no choice saved, or HQ unreachable, the
repo variable `AGENT_MODEL_<AGENT>` applies, then the workflow's default. A change in HQ reaches the next
run of every agent in every repo.

## Releasing the crew

Every change lands on `main` by PR. To release, move the major tag:

```bash
git tag -f v1 && git push -f origin v1
```

Callers pin `@v1`, so a release reaches every repo at its next run. For a breaking change (a new required
field in `crew.json`, a renamed input), tag `v2`, move callers over repo by repo, and keep `v1` until the
last one has moved. `VERSION` is informational and printed by the setup step.

## Trying a change before releasing

Point one repo's caller at your branch (`uses: vehicle-care-network/agent-crew/.github/workflows/scout-qa.yml@my-branch`)
in a PR, trigger the agent there, then switch the caller back to `@v1` before merging.

## Access

This repo is public, so any repo on GitHub can call its workflows and its setup action: the org's private
repos and personal ones such as `kayvannj/bazm-kitchen` alike. It holds no secrets. Claude credentials
live as org secrets for the org's repos and as repo secrets on repos outside the org (`gh secret set
CLAUDE_CODE_OAUTH_TOKEN -R owner/repo`); HQ is reached with each run's GitHub OIDC token; the HQ App is
installed per repo. A repo outside the org also needs its owner on HQ's allowed list
(`lib/github/oidc.ts` in agent-hq), and branch protection on a private personal repo needs GitHub Pro.

**Secrets reach the crew only if the caller passes them.** Inside the org, `secrets: inherit` does that.
Outside the org it passes nothing (GitHub honours `inherit` only within one organization), the Claude
step sees empty credentials and every agent fails with "Environment variable validation failed", however
the repo's secret is set. A caller outside the org passes them by name, which works everywhere:

```yaml
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The reusable workflows declare both under `on.workflow_call.secrets` (optional), so a caller may pass
either or both. HQ's Setup view flags a caller outside the org that still says `inherit`.
