import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notifyArgument } from '../review/review-notify.ts'
import { drainReviewQueue, enqueueReview } from '../review/review-queue.ts'
import { type OpenPullRequest, parseWorkerArguments, pullRequestsToReview } from '../review/review-worker.ts'

const HEAD = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)

test('a pull request queued twice is one entry, drained once, lowest number first', () => {
  const queue = mkdtempSync(join(tmpdir(), 'review-queue-'))
  enqueueReview(989, queue)
  enqueueReview(42, queue)
  enqueueReview(989, queue)
  expect(drainReviewQueue(queue)).toEqual([42, 989])
  expect(drainReviewQueue(queue)).toEqual([])
})

test('the queue leaves what is not a pull request number alone, and refuses to queue one that is not', () => {
  const queue = mkdtempSync(join(tmpdir(), 'review-queue-'))
  writeFileSync(join(queue, 'notes.txt'), '')
  enqueueReview(7, queue)
  expect(drainReviewQueue(queue)).toEqual([7])
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
