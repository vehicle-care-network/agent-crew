# Changelog

Callers pin `@v1`, which moves to each release. A release is a `VERSION` bump on `main`
([how](docs/reference.md#releasing-the-crew)).

## Unreleased

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
- **Setup asks where the agents run.** `SETUP.md` starts with the choice between GitHub Actions and Vercel
  sandboxes started by an Agent HQ, and has the steps for each. `scripts/setup/check.mjs --sandbox` checks
  a sandbox repo: no caller workflows, no Claude secret and no `AGENT_HQ_URL` are expected there.
- **`AGENT_HQ_URL` no longer has a default.** Before releasing this, a repo that reports to an HQ must set
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
