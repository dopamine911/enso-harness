import { type Static, Type } from 'typebox'

/**
 * What git says about a thread's cwd (#453): the repository, the branch, what it pushes to, the
 * commit the last push left on the remote, and the work that is not there yet. Read by
 * `@enso/core/git` (`readGitState`) and served by `GET /api/threads/:threadId/git`.
 *
 * ⚠ "LAST PUSH" IS WHAT THIS CLONE LAST SAW. A remote-tracking ref moves only on `push` and
 * `fetch`, and Enso never fetches — no network, no credential prompt. The baseline is the newest
 * commit on this branch that the remote had when the clone last talked to it.
 *
 * ⚠ THE MERGE-BASE, NOT THE REMOTE'S TIP. Someone else's commits on the remote, fetched but not
 * merged, are not this branch's work; diffing against the tip would show them as reversed. So the
 * baseline commit is `git merge-base HEAD <ref>`, and `ref` is kept beside it for ahead/behind.
 *
 * @module
 */

/**
 * How the baseline was chosen, in the order it is tried:
 *
 * - `upstream` — the branch's configured upstream (`@{upstream}`).
 * - `remote-branch` — no upstream, but a branch of the same name on the remote (`git push`
 *   without `-u`).
 * - `remote-default` — never pushed: where it forked from the remote's default branch
 *   (`<remote>/HEAD`, else `<remote>/main`, else `<remote>/master`).
 * - `head` — no remote ref to compare with: the last commit, so only uncommitted work counts.
 * - `none` — no commit yet: nothing to compare with.
 *
 * @group Git
 */
export const EnsoGitBaselineRule = Type.Union([
  Type.Literal('upstream'),
  Type.Literal('remote-branch'),
  Type.Literal('remote-default'),
  Type.Literal('head'),
  Type.Literal('none'),
])

/**
 * The commit work is measured from, and the ref it was found through.
 *
 * @group Git
 */
export const EnsoGitBaseline = Type.Object(
  {
    rule: EnsoGitBaselineRule,
    /** The remote-tracking ref, short (`origin/feature-x`); `null` for `head` and `none`. */
    ref: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** The baseline commit — the merge-base with `ref`, or HEAD; `null` for `none`. */
    commit: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Git */
export type EnsoGitBaseline = Static<typeof EnsoGitBaseline>

/**
 * An operation git has stopped in the middle of, off the marker files in the git directory.
 *
 * @group Git
 */
export const EnsoGitOperation = Type.Union([
  Type.Literal('merge'),
  Type.Literal('rebase'),
  Type.Literal('cherry-pick'),
  Type.Literal('revert'),
  Type.Literal('bisect'),
])
/** @group Git */
export type EnsoGitOperation = Static<typeof EnsoGitOperation>

const Count = Type.Integer({ minimum: 0 })

/**
 * A git repository's state, from its working tree's point of view.
 *
 * @group Git
 */
export const EnsoGitRepository = Type.Object(
  {
    kind: Type.Literal('repository'),
    /** The working tree's top level (`git rev-parse --show-toplevel`). */
    root: Type.String({ minLength: 1 }),
    /**
     * Where the cwd sits in the working tree (`git rev-parse --show-prefix`): `''` at the top level,
     * else a `/`-ended path. `changes` and the changed files are this directory's alone; the commits
     * (`ahead`, `behind`) are the whole repository's.
     */
    scope: Type.String(),
    /** `HEAD`'s commit; `null` before the first commit. */
    head: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** The checked-out branch, short; `null` when HEAD is detached. */
    branch: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /** The branch's configured upstream, short (`origin/main`); `null` when none is set. */
    upstream: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    baseline: EnsoGitBaseline,
    /** Commits on HEAD that `baseline.ref` does not have; 0 when there is no ref. */
    ahead: Count,
    /** Commits on `baseline.ref` that HEAD does not have; 0 when there is no ref. */
    behind: Count,
    /** Files under `scope` by where their changes sit (`git status`); one file can be staged and unstaged. */
    changes: Type.Object(
      { staged: Count, unstaged: Count, untracked: Count, conflicted: Count },
      { additionalProperties: false },
    ),
    operation: Type.Union([EnsoGitOperation, Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Git */
export type EnsoGitRepository = Static<typeof EnsoGitRepository>

/**
 * What `GET /api/threads/:threadId/git` answers: a repository, a cwd that is not in one, or git
 * that could not answer — not installed, timed out, or refused the directory (git's
 * `safe.directory` ownership check) — with git's own words.
 *
 * @group Git
 */
export const EnsoGitState = Type.Union([
  EnsoGitRepository,
  Type.Object({ kind: Type.Literal('not-a-repository') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('unavailable'), reason: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
])
/** @group Git */
export type EnsoGitState = Static<typeof EnsoGitState>

/**
 * `GET /api/threads/:threadId/git`: the thread's cwd, and git's state there, read when asked.
 *
 * @group Git
 */
export const EnsoThreadGit = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
    /** The session's cwd, which git was asked about; the repository's `root` may be above it. */
    cwd: Type.String({ minLength: 1 }),
    git: EnsoGitState,
  },
  { additionalProperties: false },
)
/** @group Git */
export type EnsoThreadGit = Static<typeof EnsoThreadGit>

/**
 * How a file differs from the baseline: git's own letters (`A`, `M`, `D`, `R`, `C`, `T`), with a
 * file git does not track yet as `untracked`.
 *
 * @group Git
 */
export const EnsoGitFileStatus = Type.Union([
  Type.Literal('added'),
  Type.Literal('modified'),
  Type.Literal('deleted'),
  Type.Literal('renamed'),
  Type.Literal('copied'),
  Type.Literal('type-changed'),
  Type.Literal('untracked'),
])

/**
 * One file that differs from the baseline (#452): the working tree against `baseline.commit`,
 * so commits not yet pushed, staged and unstaged edits all count, and a new file too.
 *
 * @group Git
 */
export const EnsoGitFileChange = Type.Object(
  {
    /** Relative to the repository's root, `/`-separated. */
    path: Type.String({ minLength: 1 }),
    /** The path it had at the baseline, for a rename or copy; `null` otherwise. */
    oldPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    status: EnsoGitFileStatus,
    /** Lines added and removed; `null` for a binary file, or when git did not count them. */
    added: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    removed: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    /** git's unified diff for this file, headers included; `null` when `omitted` says why not. */
    patch: Type.Union([Type.String(), Type.Null()]),
    /**
     * Why there is no patch: a binary file, one past the size a page is sent, or one git did not
     * produce (its diff ran out of time or output, or did not account for every file).
     */
    omitted: Type.Union([Type.Literal('binary'), Type.Literal('too-large'), Type.Literal('unavailable'), Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Git */
export type EnsoGitFileChange = Static<typeof EnsoGitFileChange>

/**
 * `GET /api/threads/:threadId/changes`: git's state in the thread's cwd, and every file that differs
 * from its baseline. No files outside a repository or when git could not answer.
 *
 * @group Git
 */
export const EnsoThreadChanges = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
    cwd: Type.String({ minLength: 1 }),
    git: EnsoGitState,
    files: Type.Array(EnsoGitFileChange),
    /** More files differ than a page is sent; `files` holds the first of them, in git's order. */
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
)
/** @group Git */
export type EnsoThreadChanges = Static<typeof EnsoThreadChanges>
