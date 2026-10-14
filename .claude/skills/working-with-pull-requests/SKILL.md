---
name: working-with-pull-requests
description: |
  How an agent session opens, updates and answers review on a pull request in this repository: a worktree per issue, commits through the pre-commit gate, the PR template, `bun run review-notify` after every push so the local reviewer (enso-local-reviewer-bot) reviews it, reading that review, and answering each finding with a commit or a reason. Use when starting work on an issue, pushing to a PR branch, updating a branch from main, reading or replying to a review, or deciding what a red CI check means while GitHub Actions is blocked.
---

# Working with pull requests

The procedure every agent session follows for a pull request here (#981 Part 2). It exists because
sessions share no memory: each one starts at week zero, and this is the week-zero version of "how we
do PRs".

The reviewer is local. Pull requests are reviewed on the owner's machine by `bun run review-worker`,
not by GitHub Actions. The worker posts as **enso-local-reviewer-bot**, and it reviews a push when
you notify it or when its next poll (every 3 minutes) sees the new head. It is configured from
`.github/workflows/claude-pr-review.yml`, so it applies the same prompt and the same rules as the
Actions review.

## 1. Start in your own worktree

```bash
git -C <repos>/zen-harness-foundation fetch origin
git -C <repos>/zen-harness-foundation worktree add -b <type>/<issue>-<slug> <repos>/zhf-<issue> origin/main
cd <repos>/zhf-<issue> && bun install
```

`<repos>` is the directory that holds the owner's checkout, `zen-harness-foundation`. Use absolute
paths: `git -C` resolves a relative path against the checkout, while `cd` resolves it against where
you are, so one relative `../zhf-<issue>` names two different places.

- `<type>` is one of `feat`, `fix`, `docs`, `design`, `chore`, `test`, `refactor`, `ui`, as the
  existing branches use.
- **Never work in the main checkout.** The owner uses it, and it may be on any branch with
  uncommitted work.
- **Check where you are before every command that writes.** A `cd` that fails sends the commands
  after it to the wrong tree. Run `set -e` first, or `test "$(pwd)" = <worktree>`.

## 2. Commit through the gate

`git commit` runs `.githooks/pre-commit`, which runs `bun run check:all` (`scripts/gate.ts`, the
same gate CI runs). It takes 3–5 minutes.

- **Never `--no-verify` on a commit you push.** The hook allows it for a local work-in-progress commit
  (its header says so), but every pushed commit has passed the gate. A failing gate is a finding: fix
  its cause. The gates and what each holds are in `docs/verification.md`.
- **The ones that surprise newcomers:**
  - the source-citation gate: docs cite code as `path#Name`, never with a line number;
  - the CRAP ratchet: an untested function with complexity has to be tested, or pinned in
    `crap-pins.json` with a reason; a pin that falls must be lowered;
  - fallow dead code: no export without a consumer;
  - the process-environment list: a new `process.env` reader is declared in
    `scripts/lint/process-environment.ts` and in `scripts/docs/inventory/env-and-config.ts`.
- End each commit message with the attribution line your harness gives you.

## 3. Open the pull request

Use `.github/pull_request_template.md` as written:
- `Closes #<n>`, or `Refs #<n>` when the PR is only part of the issue;
- **Why**, **What** (every contract that moved), **Acceptance** (each item ticked with where it is
  held), **Screenshots** ("No UI change" when there is none);
- **Checks**: only what you ran, with its result;
- **Not in this PR**: what the PR deliberately leaves for later, with its issue.

Then notify the reviewer (step 4).

## 4. After every push: notify the local reviewer

From the PR's worktree:

```bash
bun run review-notify          # the current branch's PR
bun run review-notify <number> # or name it
```

It only queues the PR (`~/.cache/enso-review/queue/<number>`). An idle worker picks it up within
about 10 seconds; a busy one finishes the review in progress first. Each review takes 2–5 minutes.

- **Always notify.** While the worker runs, its poll also finds an un-notified push within 3 minutes.
  But a push made **while the worker is stopped** is reviewed only if it was notified: the queue
  survives a restart, and the worker starts from a baseline of the current heads, which counts an
  un-notified push as already seen. When in doubt, notify again; a head already reviewed is skipped.
- **To see what the worker is doing:** `bun run review-status`. It shows whether a worker is running
  (its pid, uptime and the checkout and commit it runs from), the queue, the review in progress with
  its elapsed time and last tool call, and the worker's recent log. If no worker is running, **tell the
  owner; do not start one.** There is one per machine. The review happens when it starts.
- **Do not run `bun run review <n>` yourself** unless the owner asks. It posts as the bot.

## 5. Read the review

The reviewer leaves two comments on the PR, both by `enso-local-reviewer-bot`:

| Comment | What it says |
|---|---|
| The review | `## Code Review` (first review) or `## Code Review (commits pushed up to <sha>)` (later pushes). Sections: Overview, Strengths, Issues & Suggestions, Bugs Found, Testing, Runtime Verification, Risk Assessment, Verdict. |
| The status | Starts with `<!-- claude-run-status: pr-review -->`. Shows ✅ or ❌, and a hidden `<!-- local-review head=<sha> scope=… -->` line for the head it reviewed. |

Read them with:

```bash
gh api repos/dopamine911/zen-harness-foundation/issues/<number>/comments --paginate \
  --jq '.[] | select(.user.login == "enso-local-reviewer-bot[bot]") | .body'
```

- **Check the status's `head=`** against the SHA you pushed. A review of an older head is not a
  review of your fix.
- **A ❌ status** means no review was posted. A running worker tries that head again at its next poll
  (every 3 minutes), for up to 3 failed attempts per head in all (so 2 retries); after that its log says "giving up", and only
  `bun run review-notify` retries it. If no worker is running, notify again once one is. The retry
  reviews the commits since the last head that was reviewed. A ✅ with "docker-agent exited 1
  after the review was posted" is a known upstream issue, and the review stands.
- **Verdicts:** Ship it, Approve-with-nits, or Needs work. A finding marked **blocker** or
  **load-bearing** must be answered before you call the PR done.

## 6. Answer every finding

1. **Verify it before you fix it.** Reproduce the claim: a test, a command, a read of the code. The
   reviewer is right often, and wrong sometimes. It marks its own confidence. A claim you cannot
   reproduce is answered with what you ran.
2. **Fix with a test that fails before the fix and passes after.** Where you can, show that it fails on
   the old code.
3. **Commit, push, notify** (steps 2 and 4). The next review covers the commits since the head it last
   reviewed, in the context of the whole PR. After a force-push it reviews the whole PR again.
4. **Reply on the PR**, one line per finding: `fixed in <sha>`, or `not changed: <reason>`. Never write
   "fixed" without the commit.

Stop when the verdict is Approve-with-nits or Ship it and every remaining finding has a reply. A
review loop on your own PR can always find one more nit; the owner decides when it is enough.

## 7. Update your branch from main

Merge, never rebase. The owner, other sessions and the reviewer all hold references to your pushed
commits.

```bash
git fetch origin && git merge origin/main
```

- **Never force-push.** A push refused as non-fast-forward means someone else pushed to the branch
  (the owner, or GitHub's "update branch" button). Merge what is there; do not overwrite it.
- **After resolving conflicts, check what the auto-merge produced, not only the conflict hunks.** Two
  sides adding the same interface member, import or test helper merge "cleanly" into a duplicate.
  The gate catches most of these, so run it.

## 8. CI while GitHub Actions is blocked

While the account's Actions minutes are used up (as they were from 2026-10-14 until the next monthly
reset), every check "fails" in about 3 seconds with the annotation "The job was not started because
recent account payments have failed or your spending limit needs to be increased". Once checks run
for minutes again, this section no longer applies: read them as real results.

- **That is not a failure of your change.** Do not try to fix it, and do not report it as one.
- **The evidence is the local gate**, which ran when you committed. Say so under **Checks**.
- **Tell a real failure from a blocked one** by its duration and annotation (`gh run view <id>`). A
  check that ran for minutes and failed is a real failure.

## 9. What agents never do

- **Merge a pull request, or bypass a rule to merge one.** `main` requires the `gate` check; while
  Actions is blocked, the owner merges with an admin bypass. That is the owner's call, every time.
- **Change branch protection, repository settings, or the review App's permissions.**
- **Edit `.github/workflows/claude-pr-review.yml` and expect its own review to cover the edit.** The
  local reviewer reads the base branch's copy, as GitHub would, so a change to the review is reviewed
  by the review as it was.
- **Post as the bot**, or delete or edit the bot's comments.
