import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notifyArgument } from '../review/review-notify.ts'
import { enqueueReview, finishQueuedReview, takeQueuedReviews } from '../review/review-queue.ts'
import {
  afterReviews,
  type FailureCounts,
  MAXIMUM_ATTEMPTS_PER_HEAD,
  type OpenPullRequest,
  parseWorkerArguments,
  pullRequestsToReview,
} from '../review/review-worker.ts'

const HEAD = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)

test('a pull request queued twice is one entry; taking leaves it queued, lowest number first', () => {
  const queue = mkdtempSync(join(tmpdir(), 'review-queue-'))
  enqueueReview(989, queue)
  enqueueReview(42, queue)
  enqueueReview(989, queue)
  expect(takeQueuedReviews(queue).map((entry) => entry.number)).toEqual([42, 989])
  expect(takeQueuedReviews(queue).map((entry) => entry.number)).toEqual([42, 989])
})

/**
 * ⚠ AN ENTRY OUTLIVES A STOPPED WORKER (#981 Part 4). Taking no longer deletes: an entry goes only when
 * its review ends, so a worker stopped mid-pass leaves the rest for the next one.
 */
test('⚠ a taken entry stays queued until its review is finished, then goes', () => {
  const queue = mkdtempSync(join(tmpdir(), 'review-queue-'))
  enqueueReview(993, queue)
  enqueueReview(970, queue)
  const [first, second] = takeQueuedReviews(queue)
  if (first === undefined || second === undefined) throw new Error('two entries were queued')
  finishQueuedReview(first, queue)
  expect(takeQueuedReviews(queue).map((entry) => entry.number)).toEqual([993])
  finishQueuedReview(second, queue)
  expect(takeQueuedReviews(queue)).toEqual([])
})

test('a notify that arrives while its pull request is reviewed keeps the entry for the next pass', () => {
  const queue = mkdtempSync(join(tmpdir(), 'review-queue-'))
  enqueueReview(994, queue)
  const [taken] = takeQueuedReviews(queue)
  if (taken === undefined) throw new Error('one entry was queued')
  enqueueReview(994, queue)
  finishQueuedReview(taken, queue)
  expect(takeQueuedReviews(queue).map((entry) => entry.number)).toEqual([994])
})

test('the queue leaves what is not a pull request number alone, and refuses to queue one that is not', () => {
  const queue = mkdtempSync(join(tmpdir(), 'review-queue-'))
  writeFileSync(join(queue, 'notes.txt'), '')
  enqueueReview(7, queue)
  const [entry] = takeQueuedReviews(queue)
  if (entry === undefined) throw new Error('one entry was queued')
  finishQueuedReview(entry, queue)
  expect(readdirSync(queue)).toEqual(['notes.txt'])
  expect(() => enqueueReview(0, queue)).toThrow()
})

/**
 * ⚠ THE POLL REVIEWS WHAT CHANGED, NOT WHAT IS OPEN (#981). Every open pull request is "open" on
 * every poll; only a head the worker has not seen is a change. A queued number comes first, and a
 * number both queued and changed is reviewed once.
 */
test('⚠ a poll names only open, non-draft pull requests whose head changed, after the queued ones', () => {
  const open: OpenPullRequest[] = [
    { number: 1, headRefOid: HEAD, isDraft: false },
    { number: 2, headRefOid: NEWER, isDraft: false },
    { number: 3, headRefOid: NEWER, isDraft: true },
    { number: 4, headRefOid: NEWER, isDraft: false },
  ]
  const seen = new Map([
    [1, HEAD],
    [2, HEAD],
  ])
  expect(pullRequestsToReview([4, 9], open, seen)).toEqual([4, 9, 2])
  expect(pullRequestsToReview([], undefined, seen)).toEqual([])
})

/**
 * ⚠ THE BASELINE. A worker seeded with every open head reviews nothing on its first poll; without it,
 * every open pull request would be reviewed at once.
 */
test('⚠ against a baseline of the current heads, an unchanged poll reviews nothing', () => {
  const open: OpenPullRequest[] = [
    { number: 1, headRefOid: HEAD, isDraft: false },
    { number: 2, headRefOid: NEWER, isDraft: false },
  ]
  const baseline = new Map(open.map((pullRequest) => [pullRequest.number, pullRequest.headRefOid] as const))
  expect(pullRequestsToReview([], open, baseline)).toEqual([])
  expect(pullRequestsToReview([], open, new Map())).toEqual([1, 2])
})

test('the worker command line: --once, --poll-seconds, --review-existing', () => {
  expect(parseWorkerArguments([])).toEqual({ once: false, pollSeconds: 180, reviewExisting: false })
  expect(parseWorkerArguments(['--once', '--poll-seconds', '60', '--review-existing'])).toEqual({
    once: true,
    pollSeconds: 60,
    reviewExisting: true,
  })
  expect(() => parseWorkerArguments(['--poll-seconds', 'soon'])).toThrow()
})

test('review-notify takes a pull request number, or none for the current branch', () => {
  expect(notifyArgument(['989'])).toBe(989)
  expect(notifyArgument([])).toBeUndefined()
  expect(() => notifyArgument(['main'])).toThrow()
})

/**
 * ⚠ A FAILED REVIEW IS RETRIED BY THE NEXT POLL — even one the baseline already recorded (#993's
 * review, its blocker): a queued review that failed in a pass with no poll used to keep the baseline's
 * head, and no later poll named it again.
 */
test('⚠ a queued review that failed in a pass with no poll is named by the next poll, despite the baseline', () => {
  const open: OpenPullRequest[] = [{ number: 2, headRefOid: NEWER, isDraft: false }]
  const seen = new Map([[2, NEWER]])
  const failures: FailureCounts = new Map()
  afterReviews(seen, failures, undefined, [{ number: 2, failed: true, head: NEWER }])
  expect(pullRequestsToReview([], open, seen)).toEqual([2])
})

test("a poll records the heads it saw, except a failed review's", () => {
  const open: OpenPullRequest[] = [
    { number: 1, headRefOid: NEWER, isDraft: false },
    { number: 2, headRefOid: NEWER, isDraft: false },
  ]
  const seen = new Map<number, string>()
  afterReviews(seen, new Map(), open, [{ number: 2, failed: true, head: undefined }])
  expect(seen).toEqual(new Map([[1, NEWER]]))
})

/** A failure that does not go away stops being retried by itself after a few tries at one head. */
test(`after ${MAXIMUM_ATTEMPTS_PER_HEAD} failures at one head the worker gives up on it; a new head starts over`, () => {
  const seen = new Map<number, string>()
  const failures: FailureCounts = new Map()
  const fail = (head: string): string[] => afterReviews(seen, failures, undefined, [{ number: 5, failed: true, head }])
  expect(fail(HEAD)).toEqual([])
  expect(fail(HEAD)).toEqual([])
  expect(seen.has(5)).toBe(false)
  const givenUp = fail(HEAD)
  expect(givenUp).toHaveLength(1)
  expect(givenUp[0]).toContain('giving up at aaaaaaa after 3 failed reviews; bun run review-notify 5 to retry')
  expect(seen.get(5)).toBe(HEAD)
  expect(fail(NEWER)).toEqual([])
  expect(failures.get(5)).toEqual({ head: NEWER, count: 1 })
  afterReviews(seen, failures, undefined, [{ number: 5, failed: false, head: NEWER }])
  expect(failures.has(5)).toBe(false)
})

test('a review that threw during a poll counts its failure at the head the poll saw', () => {
  const open: OpenPullRequest[] = [{ number: 8, headRefOid: NEWER, isDraft: false }]
  const failures: FailureCounts = new Map()
  afterReviews(new Map(), failures, open, [{ number: 8, failed: true, head: undefined }])
  expect(failures.get(8)).toEqual({ head: NEWER, count: 1 })
})

test('a review that threw with no poll is never given up on: its head is unknown, so the next poll retries it', () => {
  const seen = new Map<number, string>()
  const failures: FailureCounts = new Map()
  for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS_PER_HEAD + 1; attempt += 1) {
    expect(afterReviews(seen, failures, undefined, [{ number: 9, failed: true, head: undefined }])).toEqual([])
  }
  expect(seen.has(9)).toBe(false)
  expect(failures.get(9)).toEqual({ head: undefined, count: MAXIMUM_ATTEMPTS_PER_HEAD + 1 })
})
