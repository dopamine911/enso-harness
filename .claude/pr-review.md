# Review instructions for this repository

These add to the review procedure in `.github/workflows/claude-pr-review.yml`. They never remove a section or relax a verdict rule.

## Comments on changed code (#482)

If `.review-context/touched-comments.md` exists, `Read` it before writing the review. It lists every comment whose own lines this pull request changed, or where CODE changed in the declaration the comment documents. It was built from the diff and the TypeScript syntax tree (`scripts/docs/touched-comments.ts`), most likely stale first. Its line numbers are the pull request's own. The selection is already made; your job is the judgment.

For each quoted comment:

1. `Read` the declaration it names, at the lines given, in the pull request's version of the file.
2. Decide whether every claim in the comment is still true of that code: what it does, what it guarantees, what it refuses, the order of steps, and every name it cites.
3. For a comment that states an `@invariant`, the rule is its one-line sentence AND the paragraph under it: the docs pages print both. `Read` each pinning test the list names (by the `file:line` of its `@pins` line). Check that the test exercises what the rule says, not merely that it exists. A test that proves the sentence but not the paragraph is a finding. An invariant marked `@unpinned` with a reason is allowed to have no test; check only that the reason is still true.

Report each comment that is wrong or stale under **Issues & Suggestions**, titled `Comment drift: <file>:<line>`:

- say which claim no longer holds, and what the code does instead;
- severity: an `@invariant` or `@flow` that is wrong is **load-bearing**, because the docs pages are built from these tags; any other wrong comment is a **soft nit**, unless it would mislead a caller about behaviour, which is **load-bearing**.

For the entries under "Also changed, not quoted", check the ones marked "states an invariant" first, then as many of the rest as the review allows.

In **Testing**, say how many listed comments you checked and how many you could not reach. A list you did not finish is a gap to name, not a pass. If the file does not exist, write "Comment list not available" there.
