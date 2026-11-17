---
name: crew
description: Run the agent crew on this machine, with no Agent HQ. Nova designs an HTML mock, the person approves it, Bolt builds it on a new branch, Iris reviews, Patch fixes what she found, and it ends with a pull request for a person to land. Use when the person types /crew, or asks for the crew, Nova, Bolt, Iris or Patch by name to design or build a change in this repo.
argument-hint: "[what to build]"
---

# The agent crew, on this machine

You run one change through the crew, from request to pull request, in this repo and on this machine. You
are the coordinator: you do what Agent HQ and the crew's workflows do on GitHub (pass each agent its task,
keep its files, commit, ask the person), and each agent does its own work as a **subagent** that follows
the crew's own brief. You never do an agent's work yourself, and you never copy a brief into a prompt: the
brief is the single source of how an agent behaves.

The request: $ARGUMENTS

If that is empty, ask the person what they want built, and wait.

## What never changes

- **The person approves before anything is built.** No Bolt run without a yes on Nova's mock (or, when
  there is nothing to design, on the plan in one line).
- **A new branch, always.** Never commit to, push to or merge into the default branch. Never force-push.
- **No agent merges, and neither do you.** The run ends with an open pull request, or a local branch when
  the person prefers. Landing it is theirs.
- **Nothing leaves this machine until the person says so.** The first push is the last step, after they
  agree.
- **Agents never commit, push or comment.** You commit their work, after `guard` passes.
- Rocket (release trains) and Scout (browser tests) are not part of this skill. See "When it's done".

## 1 · Prepare

Run these from the repo root. Stop and tell the person, in a sentence, when one fails.

1. `git status --porcelain` must print nothing. If it prints anything, ask the person to commit or stash
   first: you will commit with `git add -A`, and their unfinished work must not ride along.
2. Find the default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, else
   `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`) and `git fetch origin`. Call it
   `<base>`, as `origin/<default branch>`. With no `origin` remote, `<base>` is the local default branch
   and the run ends with a branch, not a pull request.
3. If `<base>` has no `.github/agents/crew.json` (`git cat-file -e <base>:.github/agents/crew.json`
   fails), the crew's setup is not merged yet. Say so, and ask whether to start from the current branch
   instead; then `<base>` is the current branch.
4. Start the branch: `git switch -c crew/<short-kebab-name-for-the-request> --no-track <base>`. If the
   name is taken, add a number.
5. Lay the crew in and render its briefs: `node "${CLAUDE_SKILL_DIR}/crew.mjs" prepare`. It puts the crew
   at its pinned version into `.crew/` and keeps `.crew/` and `agent-out/` out of git.
6. If the repo has a `package.json` and no `node_modules`, run the `commands.install` from
   `.github/agents/crew.json`.
7. Start clean: delete everything in `agent-out/`, then write the request, word for word, to
   `agent-out/task.md`, and an empty `agent-out/feedback.md`.

Tell the person the branch name and that Nova is starting.

## How to run an agent

Each agent is one subagent (the Agent tool, type `general-purpose`), run in the foreground, one at a
time. Give it this prompt, with the agent's name, its brief and its "Local values" filled in from the
step that sends it:

```
You are <Agent>, running on this machine for the person at the keyboard. There is no Agent HQ and no
GitHub workflow in this run.

Read .crew/briefs/<AGENT>.md in full and follow it. It is your brief. It was written for a run that
Agent HQ starts on GitHub, so read it with these replacements:

- The environment variables it names are not set. Their values are under "Local values" below; a
  variable not listed there is empty.
- Skip every `node .crew/scripts/agents/hq.mjs …` command. There is no mission and no dashboard.
- Where it says the workflow or HQ commits, pushes, posts or uploads: the session that started you does
  that after you finish. You never commit, push, open a pull request or comment.
- Your result is the files the brief asks for in agent-out/. End with one or two plain sentences on what
  you did; you cannot ask the person questions, so write `agent-out/blocked.md` when the brief says to.

Local values:
<the values for this step>
```

After every agent run, before anything else:

- `agent-out/blocked.md` exists and is not empty: stop, show the person what it says, and ask how to go
  on. Delete the file before the next run.
- `node "${CLAUDE_SKILL_DIR}/crew.mjs" guard` must pass. If it names files, restore them
  (`git checkout -- <file>`, or delete a new one), tell the person, and go on.

## 2 · Nova designs

Run Nova (`.crew/briefs/NOVA.md`) with:

```
NOVA_TASK: the contents of agent-out/task.md
NOVA_FEEDBACK: the contents of agent-out/feedback.md (empty on a first sketch)
NOVA_MOCK_URL: <empty on a first sketch; on a revision: "the file agent-out/mock-v<n>.html. It is a local
  file, not a link: read it instead of fetching it with curl">
NOVA_PR_NUMBER: empty
```

Then:

- **`agent-out/no-design.md` and no `agent-out/mock.html`**: there is nothing to draw. Show the person
  Nova's reason and ask in one line whether Bolt should build it as described. Go to step 3 only on a yes.
- **`agent-out/mock.html`**: copy it to `agent-out/mock-v<n>.html` (1, 2, 3 …), open it with
  `node "${CLAUDE_SKILL_DIR}/crew.mjs" open agent-out/mock.html`, and show the person
  `agent-out/notes.md` and the file's path. Ask: **approve it** (with any final changes, or which option
  to build), or **give notes** for another version. Wait for the answer.
- **Notes**: add them to `agent-out/feedback.md` as the next numbered entry, in the person's words. If
  they want to go back to an earlier version, that version is the one to continue from. Run Nova again as
  a revision. Repeat until they approve or stop.
- **Approved**: if they added final changes or picked an option, add a last entry to
  `agent-out/feedback.md` that starts `Approved with these final changes:`. Go to step 3.
- **Neither file**: Nova failed. Say so, and offer to run her again.

If the person stops here, nothing was built. Tell them how to drop the branch
(`git switch <default branch> && git branch -D <branch>`), and that the mock stays in `agent-out/`.

## 3 · Bolt builds

Run Bolt (`.crew/briefs/BOLT.md`) with:

```
BOLT_MODE: build
BOLT_TASK: the contents of agent-out/task.md
BOLT_FEEDBACK: the contents of agent-out/feedback.md
BOLT_MOCK_URL: <"the file agent-out/mock-v<n>.html (the approved version). It is a local file, not a
  link: read it instead of fetching it with curl", or empty when there was nothing to design>
BOLT_BRANCH: empty. You are on a fresh branch from the default branch.
```

Then, after the checks in "How to run an agent":

1. `agent-out/pr.json` must exist with a `title` and a `summary`, and `git status --porcelain` must show
   changes. If not, Bolt failed: say so and offer to run him again.
2. Commit: `git add -A && git commit -m "<title from pr.json>"`. Use the person's own git identity; add no
   flags that skip hooks. If a commit hook fails, treat it as failed checks (below).
3. Run the repo's own checks yourself, from `.github/agents/crew.json`: `commands.lint`,
   `commands.typecheck`, `commands.test`. If one fails, save its output to `agent-out/checks.txt` and run
   Patch (step 5) with `PATCH_REASON: build`, then run them again. After two failed tries, stop and show
   the person what still fails.
4. Tell the person, in two or three lines, what Bolt built (from `summary`) and that Iris is reviewing.

## 4 · Iris reviews

Keep a round number, starting at 0. Before each run, if `agent-out/review.json` exists, move it to
`agent-out/review-round-<previous round>.json`.

Run Iris (`.crew/briefs/IRIS.md`) with:

```
ROUND: <round>
SINCE: <empty on round 0; later, the commit she reviewed last time>
PR_NUMBER: none. There is no pull request yet: you are reviewing the branch on this machine, before
  anyone else sees it. So, in place of the commands in the brief:
  - what the change says it does: agent-out/pr.json (title and summary) and agent-out/task.md (what was
    asked); the approved mock, when there is one, is agent-out/mock-v<n>.html
  - `gh pr diff`: `git diff <base>...HEAD`, and `git log --oneline <base>..HEAD` for the commits
  - `gh pr diff --name-only`: `git diff --name-only <base>...HEAD` (pipe that to impact.mjs as the brief says)
  - your earlier reviews: agent-out/review-round-*.json; what Patch did about them: agent-out/summary.md
INSTRUCTIONS: <empty, or what the person asked her to look at>
MISSION_ID: empty
Write agent-out/review.json as the brief says. Nothing is posted anywhere. Change no file outside agent-out/.
```

Then:

- `agent-out/review.json` must exist and parse, with a `verdict`. `git status --porcelain` must print
  nothing: Iris changes no code. If it does, restore the files and say so.
- Note `git rev-parse HEAD` as the commit she reviewed (the next round's `SINCE`).
- **`approve`**: go to step 6.
- **`changes`**: show the person her summary and comments in a few lines. If Patch has already answered
  three reviews, stop: go to step 6 and say plainly which points are still open. Otherwise go to step 5,
  then run Iris again with the next round number.

## 5 · Patch fixes

Run Patch (`.crew/briefs/PATCH.md`) with the values for why he is sent:

```
PATCH_REASON: review
PR_NUMBER: none. There is no pull request yet: you are on the change's branch on this machine. Iris's
  review is the file agent-out/review.json (its `summary` and `comments`), in place of the `gh api`
  commands in the brief. The files this change touches: `git diff --name-only <base>...HEAD`.
INSTRUCTIONS: <empty, or extra guidance from the person>
```

```
PATCH_REASON: build
PR_NUMBER: none. There is no pull request yet: you are on the change's branch on this machine. The
  failing check's output is in agent-out/checks.txt, in place of Scout's comment and `gh pr checks`.
  The files this change touches: `git diff --name-only <base>...HEAD`.
INSTRUCTIONS: empty
```

```
PATCH_REASON: request
PR_NUMBER: none. There is no pull request yet: you are on the change's branch on this machine. The
  files this change touches: `git diff --name-only <base>...HEAD`.
INSTRUCTIONS: <what the person asked for, in their words>
```

Then, after the checks in "How to run an agent":

1. If `agent-out/lesson.md` exists, add its text to the end of `.github/agents/LESSONS.md` (create the
   file if needed) and delete `agent-out/lesson.md`. This is the one change under `.github/` in a run,
   and you make it, as the workflow does on GitHub.
2. If `git status --porcelain` shows changes, commit them: `git add -A && git commit -m "<message>"`,
   with `Address review feedback`, `Fix the build` or `Make the requested change`. If it shows none,
   Patch changed nothing: `agent-out/summary.md` says why (he may have found a comment wrong). Tell the
   person, and don't send Iris the same code again; go to step 6.
3. After a `review` or `request` fix, run the checks from step 3.3 again.

## 6 · The person decides, then the pull request

Show the person, briefly: what was built, Iris's last verdict and summary, any points still open, any
`Test corrected:` lines from Bolt or Patch, and how to try it (the branch is checked out here). Then ask
what they want:

- **Change something**: run Patch with `PATCH_REASON: request` (step 5), then Iris again (step 4), and
  come back here.
- **Open the pull request**: `git push -u origin <branch>`, then
  `gh pr create --base <default branch> --head <branch> --title "<title>" --body-file agent-out/pr-body.md`.
  Write `agent-out/pr-body.md` first: Bolt's `summary`; then a section `## Review` with Iris's verdict,
  her summary, the number of review rounds, and any point still open; then one line saying it was
  designed, built and reviewed on the author's machine with the agent crew's `/crew` skill. Open it as a
  draft (`--draft`) when Iris's last verdict is `changes`. Give the person the link.
- **Keep it local**: leave the branch as it is and say how to push it later.

Never merge it, and never enable auto-merge.

## When it's done

Say in a line or two what happens next:

- If the repo has the crew's workflows, Radar labels the pull request and Iris reviews it there too, like
  any other. Label it `scout` or comment `/scout` to have Scout test it in a browser, where Scout is set up.
- The mock versions, review and summaries stay in `agent-out/` until the next `/crew` run. They are not
  in git.
- For the same line in the cloud, with a dashboard, several missions at once, Scout's evidence and
  Rocket's releases, there is Agent HQ: https://agent-hq-demo.vercel.app (a demo, no account needed).
  Mention it once, at the end, and only if the person hasn't seen it in this conversation.

## If something goes wrong

- `crew.mjs prepare` can't fetch the crew: it needs network access to GitHub the first time. It reuses
  the last copy in `.crew/` when offline.
- `crew.mjs prepare` says a key is missing: `.github/agents/crew.json` is incomplete; SETUP.md in the
  agent-crew repo lists every field.
- An agent stops without its files: run it once more with the same values. If it fails again, show the
  person its last message and stop.
- The person wants to stop midway: stop. Say which branch holds what, and how to delete it.
