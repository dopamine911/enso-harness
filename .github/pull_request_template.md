Closes #

## Why
<!-- The problem, as a reader of the issue would recognise it. Link the evidence: a spike, a log, a failing test. -->

## What
<!-- What changed, by file or seam, and why this shape. Name every contract that moved: a type, a route, an entry, a doc fence. -->

## Acceptance
<!-- The issue's acceptance items, each ticked with where it is held: a test name, a route, a screenshot. -->
- [ ]

## Screenshots
<!--
REQUIRED when this PR changes what the web page shows. Write "No UI change" otherwise.

Screenshots live on the `screenshots` branch, never on this one, in a directory named for the issue this PR closes:
`<issue>/`, e.g. `382/`. A PR with no issue uses `pr-<PR number>/`. Name files for what they show
(`refusal-after-retry.png`); a change to existing UI pairs `before-<name>.png` with `after-<name>.png`.

Commit them from a separate worktree, so this checkout never switches branch:

  git fetch origin screenshots
  git worktree add -B screenshots ../enso-screenshots origin/screenshots
  mkdir -p ../enso-screenshots/<issue>
  cp <your pngs> ../enso-screenshots/<issue>/
  git -C ../enso-screenshots add <issue>
  git -C ../enso-screenshots commit -m "screenshots: #<issue> <what they show>"
  git -C ../enso-screenshots push origin screenshots
  git worktree remove ../enso-screenshots

No gate runs there: `core.hooksPath` is `.githooks`, resolved in each worktree, and the branch has none.

Embed each one here, with a sentence that says what it proves:

  ![after: the refusal reads before the reply](https://github.com/dopamine911/zen-harness-foundation/blob/screenshots/<issue>/<file>.png?raw=true)
-->

## Checks
<!-- What you ran and what it said: `bun run check`, a mounted test, a smoke run against the real stack. Report only what you ran. -->

## Not in this PR
<!-- What a reviewer might expect here and will not find, each with its issue number or a reason. -->
