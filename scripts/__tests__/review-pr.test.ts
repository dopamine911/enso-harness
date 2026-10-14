import { expect, test } from 'bun:test'
import {
  lastReviewedHeadOf,
  parseReviewArguments,
  planReview,
  type PullRequestState,
  reviewSettings,
  STATUS_MARKER,
  statusCommentBody,
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
 * review and this one upsert one comment, and a success records the head it reviewed — which the
 * next run reads back. A failure records none, so the head is tried again.
 */
test('⚠ the status comment carries the workflow marker and, on success only, the reviewed head', () => {
  const success = statusCommentBody('success', HEAD, 'full')
  expect(success.startsWith(STATUS_MARKER)).toBe(true)
  expect(lastReviewedHeadOf(success)).toBe(HEAD)
  expect(lastReviewedHeadOf(statusCommentBody('failure', HEAD, 'full'))).toBeUndefined()
  expect(lastReviewedHeadOf(`${STATUS_MARKER}\n✅ **Claude PR review** ran on \`aaaaaaa\`.`)).toBeUndefined()
  expect(lastReviewedHeadOf(undefined)).toBeUndefined()
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
