import { expect, test } from 'bun:test'
import {
  claudeSessionFolder,
  type IssueComment,
  lastReviewedHeadOf,
  parseReviewArguments,
  planReview,
  type PullRequestState,
  reviewCommentsSince,
  reviewSettings,
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

/**
 * ⚠ POSTED IS WHAT IS ON THE PULL REQUEST. A hook allows a post before `gh` runs it, so "allowed"
 * would record a head nobody reviewed when the post then failed (#989's review).
 */
test('a review counts as posted only when this login posted a comment in the template after the run began', () => {
  const since = '2026-10-14T14:00:00Z'
  const comment = (body: string, created_at: string, author = 'me'): IssueComment => ({
    id: 1,
    body,
    created_at,
    author,
  })
  const comments = [
    comment('## Code Review\n\n### Overview\nold', '2026-10-14T13:00:00Z'),
    comment(`${STATUS_MARKER}\n✅`, '2026-10-14T14:05:00Z'),
    comment('Thanks, fixed in abc1234.', '2026-10-14T14:06:00Z'),
    comment('## Code Review\nfrom someone else', '2026-10-14T14:06:30Z', 'claude[bot]'),
  ]
  expect(reviewCommentsSince(comments, since, 'me')).toEqual([])
  const posted = comment('## Code Review (commits pushed up to add4fef)\n…', '2026-10-14T14:07:00Z')
  expect(reviewCommentsSince([...comments, posted], since, 'me')).toEqual([posted])
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
  const comment = (author: string, body: string, id: number): IssueComment => ({ id, body, created_at: '', author })
  const owners = comment(
    'dopamine911',
    statusCommentBody({ posted: true, headSha: PREVIOUS, scope: 'full', agentExitCode: 0 }),
    1,
  )
  const actions = comment('github-actions[bot]', `${STATUS_MARKER}\n✅ ran`, 2)
  expect(statusCommentsOf([actions, owners], 'reviewer[bot]')).toEqual({ own: undefined, lastReviewedHead: PREVIOUS })
  const bots = comment(
    'reviewer[bot]',
    statusCommentBody({ posted: true, headSha: HEAD, scope: 'new-commits', agentExitCode: 0 }),
    3,
  )
  expect(statusCommentsOf([actions, owners, bots], 'reviewer[bot]')).toEqual({ own: bots, lastReviewedHead: HEAD })
  expect(statusCommentsOf([actions], 'reviewer[bot]')).toEqual({ own: undefined, lastReviewedHead: undefined })
})
