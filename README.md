# The agent crew

The crew Agent HQ (https://agent-hq-cyan.vercel.app) runs in every repo it works on: **Bolt** builds,
**Iris** reviews, **Patch** fixes, **Scout** tests in a browser, **Radar** labels impact, triages and
audits. This repo holds the crew once. A repo that uses the crew keeps only its own answers (what the
product is, how to lint and test it, what Scout can log in as) and five thin workflows that call the ones
here. Change the crew here, tag a release, and every repo gets it.

```
agent-crew (this repo)                          a repo the crew works in
├── action.yml          "set up the crew"       ├── .github/workflows/agent-bolt.yml   ─┐
├── .github/workflows/  reusable workflows      │   agent-iris.yml, agent-patch.yml,    │ thin callers,
│   agent-bolt.yml, agent-iris.yml,             │   agent-radar.yml, scout-qa.yml      ─┘ `uses: …@v1`
│   agent-patch.yml, agent-radar.yml,           ├── .github/agents/crew.json           the repo's answers
│   scout-qa.yml                                │   risk-map.json, LESSONS.md,
├── briefs/  BOLT IRIS PATCH RADAR (templates)  │   {BOLT,IRIS,PATCH,RADAR,SCOUT}.notes.md (optional)
├── scout/   PROMPT.md (template), mcp.json     ├── .github/scout/core-flows.md
├── scripts/agents/  hq, usage, impact, …       ├── scripts/scout/seed.mjs, fixtures.mjs
├── scripts/scout/   report, evidence, env, …   ├── e2e/scout/_support/scout.ts  (re-exports ours + logins)
├── e2e/_support/scout.ts  Playwright harness   └── e2e/scout/core/*.spec.ts
└── playwright.scout.config.ts
```

## How a run works

1. HQ (or a label, a `/scout` comment, a schedule) starts the repo's thin workflow. HQ always sends one
   input, `params`, a JSON string, so the contract between HQ and the repos never drifts.
2. The thin workflow calls the reusable one here at a pinned tag.
3. The reusable workflow checks the repo out, then runs the **setup action** (`action.yml`): it lays this
   repo's scripts, briefs and harness into `.crew/` in the checkout (kept out of git through
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
- `.github/agents/<AGENT>.notes.md` (BOLT, IRIS, PATCH, RADAR, SCOUT): the repo's own additions to a
  brief, inserted under "This repo". Keep them short and concrete: conventions the linter can't catch,
  what Scout can log in as, what it can't test here.
- `.github/agents/risk-map.json` (Radar's impact tiers), `.github/scout/core-flows.md`, the base seed
  (`scripts/scout/seed.mjs`, `fixtures.mjs`), the Playwright re-export with the repo's login helpers, and
  the core smoke specs stay in the repo: they describe the product, not the crew.
- Secrets `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) at org level, labels `agent` and `scout`, the
  HQ GitHub App installed, and branch protection on `main`.

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

Settings → Actions → General → Access is set to "Accessible from repositories in the organization", which
is what lets other private repos in the org use these workflows and the setup action.
