# Agent Crew

A crew of AI agents that works on your GitHub repo: one reviews every pull request, one tests it in a
real browser, one labels how risky it is. They run on GitHub Actions, in your repo, on your own Claude
account. Your repo keeps a few small files; the crew itself lives here and updates for everyone at once.

| | Agent | What it does | Runs when |
| --- | --- | --- | --- |
| 🔎 | **Iris** | Reviews the PR and leaves comments with a verdict | Every PR, or comment `/iris` |
| 🧭 | **Scout** | Tests the PR like a user, in a browser, and posts what passed and failed | Label a PR `scout`, or comment `/scout` |
| 📡 | **Radar** | Labels each PR's impact (`impact:low` to `impact:critical`), no AI | Every PR |
| 💓 | **Probe** | Checks your live site is up, no AI | Every 15 minutes |
| 🎨 ⚡ 🩹 🚀 | **Nova, Bolt, Patch, Rocket** | Design a mock, build it, fix what review and testing found, ship the release | From [Agent HQ](#agent-hq) |

No agent can merge. Reviews are comments, and landing a PR stays with a person.

## Set it up

**With Claude Code.** Open your repo and say:

> Read https://raw.githubusercontent.com/vehicle-care-network/agent-crew/main/SETUP.md and set up the agent crew in this repo.

Claude copies the starter files, fills them in from your code, runs the check script and opens a pull
request. You add one secret (your Claude credential) and merge.

**By hand.** Follow [SETUP.md](SETUP.md): it is the same steps, about ten minutes for Iris and Radar.

## What you need

- A GitHub repo with Actions on, and admin access to it.
- A Claude subscription (`claude setup-token`) or an Anthropic API key. Every run is billed to you, not to us.
- **Iris and Radar** work on any repo.
- **Scout** today tests **Next.js apps on Firebase** (Firestore and Auth): it starts your app with
  `next dev` against the Firebase emulators, so nothing it does can reach real data.

## What your repo keeps

```
.github/workflows/agent-iris.yml, agent-radar.yml, scout-qa.yml   thin callers: triggers, then `uses: …/agent-crew/…@v1`
.github/agents/crew.json        what the product is, how to install, lint and test it
.github/agents/risk-map.json    which paths are critical, high or low impact
.github/agents/*.notes.md       optional: your own additions to each agent's brief
.github/scout/, e2e/scout/, scripts/scout/    Scout only: the journeys that must not break, sign-in helper, seed data
```

Starters for every one of these are in [`templates/`](templates), and
`node scripts/setup/check.mjs` (run from your repo) tells you what is missing.

## Agent HQ

Agent HQ is the dashboard for the whole crew: you write a mission, Nova sketches it, you approve, Bolt
builds it, Iris and Scout check it, Patch fixes what they find, and Rocket lands the finished PRs in a
release. It shows every mission, who is on it and what needs you. HQ is a separate product, set up for
each team on its own accounts. The crew in this repo is free and works without it.

With an HQ, set the repo or organization variable `AGENT_HQ_URL` to its address and copy
`templates/hq/`. Without that variable a run talks only to GitHub and Claude.

## More

- [SETUP.md](SETUP.md): install the crew in a repo, step by step, with fixes for what goes wrong.
- [docs/reference.md](docs/reference.md): how everything works: Scout's modes, the three tiers of
  testing, releases, models, access, forking, and how this repo is released.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version. Callers pin `@v1`.

## License

[MIT](LICENSE).
