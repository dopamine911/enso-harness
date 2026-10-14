import { expect, test } from 'bun:test'
import {
  claudeSessionFolder,
  type IssueComment,
  lastReviewedHeadOf,
  parseReviewArguments,
  planReview,
  type PullRequestState,
  reviewSettings,
  runSummary,
  STATUS_MARKER,
  statusCommentBody,
  statusCommentsOf,
} from '../review/review-pr.ts'

const HEAD = 'a'.repeat(40)
const PREVIOUS = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const PULL_REQUEST: PullRequestState = {
  number: 7,
  headRefOid: HEAD,
  baseRefName: 'main',
  baseRefOid: BASE,
  isDraft: false,
  author: { login: 'someone' },
}
const ALWAYS_ANCESTOR = (): boolean => true
const NEVER_ANCESTOR = (): boolean => false

/** The workflow's job `if:` and its scope step, as one rule (#981). */
test('a first review is full, from the base', () => {
  expect(planReview(PULL_REQUEST, undefined, ALWAYS_ANCESTOR)).toEqual({ kind: 'review', scope: 'full', from: BASE })
})

test('a push after a review reviews only its own commits', () => {
  expect(planReview(PULL_REQUEST, PREVIOUS, ALWAYS_ANCESTOR)).toEqual({
    kind: 'review',
    scope: 'new-commits',
    from: PREVIOUS,
  })
})

test('a force-push that dropped the reviewed head falls back to a full review', () => {
  expect(planReview(PULL_REQUEST, PREVIOUS, NEVER_ANCESTOR)).toEqual({ kind: 'review', scope: 'full', from: BASE })
})

test('a head already reviewed, a draft and a bot are skipped', () => {
  expect(planReview(PULL_REQUEST, HEAD, ALWAYS_ANCESTOR).kind).toBe('skip')
  expect(planReview({ ...PULL_REQUEST, isDraft: true }, undefined, ALWAYS_ANCESTOR).kind).toBe('skip')
  expect(
    planReview({ ...PULL_REQUEST, author: { login: 'dependabot', is_bot: true } }, undefined, ALWAYS_ANCESTOR).kind,
  ).toBe('skip')
})

/**
 * ⚠ THE STATUS COMMENT IS THE WORKFLOW'S. It starts with the workflow's marker, so the Actions
 * review and this one upsert one comment, and a posted review records the head it reviewed — which
 * the next run reads back. A run that posted nothing records none, so the head is tried again.
 */
test('⚠ the status comment carries the workflow marker and, when the review was posted, the reviewed head', () => {
  const posted = statusCommentBody({ posted: true, headSha: HEAD, scope: 'full', agentExitCode: 0 })
  expect(posted.startsWith(STATUS_MARKER)).toBe(true)
  expect(lastReviewedHeadOf(posted)).toBe(HEAD)
  expect(
    lastReviewedHeadOf(statusCommentBody({ posted: false, headSha: HEAD, scope: 'full', agentExitCode: 1 })),
  ).toBeUndefined()
  expect(lastReviewedHeadOf(`${STATUS_MARKER}\n✅ **Claude PR review** ran on \`aaaaaaa\`.`)).toBeUndefined()
  expect(lastReviewedHeadOf(undefined)).toBeUndefined()
})

/**
 * ⚠ POSTED IS WHAT THE DECISION LOG SAYS, NOT DOCKER-AGENT'S EXIT CODE. #989's first run: docker-agent
 * exited 1 after the review went out, and the status said "failed, no verdict" under a verdict.
 */
test('⚠ a review posted before docker-agent failed is reported as posted, with the exit noted', () => {
  const body = statusCommentBody({ posted: true, headSha: HEAD, scope: 'full', agentExitCode: 1 })
  expect(body).toContain('✅')
  expect(body).toContain('exited 1 after the review was posted')
  expect(statusCommentBody({ posted: false, headSha: HEAD, scope: 'full', agentExitCode: 1 })).toContain(
    'no review comment was posted',
  )
})

test("Claude Code's session folder for a directory, named as Claude Code names it", () => {
  expect(claudeSessionFolder('/home/daniel/.cache/enso-review/pr-989-6eb2ed1-1791986401294/tree', '/home/daniel')).toBe(
    '/home/daniel/.claude/projects/-home-daniel--cache-enso-review-pr-989-6eb2ed1-1791986401294-tree',
  )
})

test('the review worktree gets the grant hook on every tool call', () => {
  const settings = JSON.parse(reviewSettings('/runs/7/grant.json')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
  }
  const [entry] = settings.hooks.PreToolUse
  expect(entry?.matcher).toBe('*')
  expect(entry?.hooks[0]?.command).toMatch(/scripts\/review\/tool-grant-hook\.ts \/runs\/7\/grant\.json$/)
})

test('the command line takes a pull request number and --dry-run', () => {
  expect(parseReviewArguments(['981', '--dry-run'])).toEqual({ number: 981, dryRun: true })
  expect(parseReviewArguments(['981'])).toEqual({ number: 981, dryRun: false })
  expect(() => parseReviewArguments(['--dry-run'])).toThrow()
})

/**
 * A run edits only its own status comment (a token cannot edit another's), but reads the last
 * reviewed head from any status comment, so switching poster (the owner, then the App's bot) does
 * not forget what was reviewed.
 */
test("the status comment a run updates is its own; the last reviewed head comes from its own, else anyone's", () => {
  const comment = (author: string, body: string, id: number): IssueComment => ({ id, body, author })
  const owners = comment(
    'dopamine911',
    statusCommentBody({ posted: true, headSha: PREVIOUS, scope: 'full', agentExitCode: 0 }),
    1,
  )
  const actions = comment('github-actions[bot]', `${STATUS_MARKER}\n✅ ran`, 2)
  expect(statusCommentsOf([actions, owners], 'reviewer[bot]', ['dopamine911'])).toEqual({
    own: undefined,
    lastReviewedHead: PREVIOUS,
  })
  const bots = comment(
    'reviewer[bot]',
    statusCommentBody({ posted: true, headSha: HEAD, scope: 'new-commits', agentExitCode: 0 }),
    3,
  )
  expect(statusCommentsOf([actions, owners, bots], 'reviewer[bot]', ['dopamine911'])).toEqual({
    own: bots,
    lastReviewedHead: HEAD,
  })
  expect(statusCommentsOf([actions], 'reviewer[bot]')).toEqual({ own: undefined, lastReviewedHead: undefined })
})

/** ⚠ A `head=` line in a stranger's comment is not a review: trusting it would skip a head nobody reviewed. */
test('⚠ a status comment by anyone but the poster or a trusted author records nothing', () => {
  const stranger: IssueComment = {
    id: 9,
    author: 'someone-else',
    body: statusCommentBody({ posted: true, headSha: HEAD, scope: 'full', agentExitCode: 0 }),
  }
  expect(statusCommentsOf([stranger], 'reviewer[bot]', ['dopamine911'])).toEqual({
    own: undefined,
    lastReviewedHead: undefined,
  })
})

test('the run summary says what was posted, or that nothing was, with the exit code and the log', () => {
  const base = {
    number: 7,
    where: 'posted as reviewer[bot]',
    scope: 'full',
    agentExitCode: 0,
    listProblem: undefined,
    log: '/r/review.log',
  }
  expect(runSummary({ ...base, posted: true })).toBe(
    '#7: reviewed (full); comment posted as reviewer[bot]; docker-agent exited 0; log /r/review.log',
  )
  expect(
    runSummary({ ...base, posted: false, agentExitCode: 1, listProblem: 'the comment list was not built: x' }),
  ).toBe(
    '#7: FAILED: no review comment was posted; docker-agent exited 1; the comment list was not built: x; log /r/review.log',
  )
})

/**
 * ⚠ A FAILED RUN KEEPS THE HEAD REVIEWED BEFORE IT (#993's review): the retry then reviews only the
 * commits since that review, and the head that failed is still unreviewed, so it is tried again.
 */
test('⚠ a failed status keeps the previously reviewed head, so the retry is new-commits from it', () => {
  const failed = statusCommentBody({
    posted: false,
    headSha: HEAD,
    scope: 'new-commits',
    agentExitCode: 1,
    previouslyReviewedHead: PREVIOUS,
  })
  expect(failed).toContain('❌')
  expect(lastReviewedHeadOf(failed)).toBe(PREVIOUS)
  expect(planReview(PULL_REQUEST, lastReviewedHeadOf(failed), ALWAYS_ANCESTOR)).toEqual({
    kind: 'review',
    scope: 'new-commits',
    from: PREVIOUS,
  })
  expect(
    lastReviewedHeadOf(statusCommentBody({ posted: false, headSha: HEAD, scope: 'full', agentExitCode: 1 })),
  ).toBeUndefined()
})
