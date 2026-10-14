/**
 * The local review queue (#981): a directory with one empty file per pull request number waiting
 * for review. `review-notify.ts` adds one; `review-worker.ts` takes them, and removes each when its
 * review ends.
 *
 * WHY A DIRECTORY, NOT A SERVER. It needs no process to be running when a session notifies, it
 * survives the worker restarting, and a person can see it with `ls`. A pull request notified twice is
 * one file, so a burst of pushes queues one review, and the worker reviews whatever head the pull
 * request has when its turn comes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_QUEUE_DIRECTORY } from './review-paths.ts'

/** A queue entry's name: the pull request number, nothing else. */
const QUEUE_ENTRY = /^\d+$/

/**
 * Queues pull request `number` for review. The entry holds a stamp unique to this notify, so a notify
 * that arrives while that pull request is being reviewed is told apart from the one the review took
 * (`finishQueuedReview`). Queuing one already queued keeps one entry, with the newer stamp.
 */
export function enqueueReview(number: number, directory: string = REVIEW_QUEUE_DIRECTORY): void {
  if (!Number.isInteger(number) || number <= 0) throw new Error(`not a pull request number: ${number}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, String(number)), `${process.pid}:${process.hrtime.bigint()}`)
}

/** The queued pull request numbers, lowest first, left on the queue. Anything else in the directory is ignored. */
export function queuedReviews(directory: string = REVIEW_QUEUE_DIRECTORY): number[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((entryName) => QUEUE_ENTRY.test(entryName))
    .map(Number)
    .toSorted((first, second) => first - second)
}

/** A queue entry a worker took: the pull request, and the stamp its file held when taken. */
export interface QueuedReview {
  readonly number: number
  readonly stamp: string
}

function stampOf(directory: string, number: number): string | undefined {
  try {
    return readFileSync(join(directory, String(number)), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The queued pull requests, lowest first, LEFT on the queue until `finishQueuedReview`. ⚠ Taking used to
 * delete them all at the start of a pass, so a worker stopped mid-pass (Ctrl-C, a closed terminal, a
 * reboot) lost what it had taken, and its next start's baseline counted those heads as seen (#981 Part 4,
 * seen live with #993). Now an entry outlives a stopped worker, and the next one reviews it.
 */
export function takeQueuedReviews(directory: string = REVIEW_QUEUE_DIRECTORY): QueuedReview[] {
  return queuedReviews(directory).flatMap((number) => {
    const stamp = stampOf(directory, number)
    return stamp === undefined ? [] : [{ number, stamp }]
  })
}

/**
 * Removes a taken entry once its review has ended (posted, skipped, or failed and left to the poll's
 * retry) — unless it was queued again meanwhile: a newer stamp means a notify came during the review,
 * so the entry stays for the next pass.
 */
export function finishQueuedReview(taken: QueuedReview, directory: string = REVIEW_QUEUE_DIRECTORY): void {
  if (stampOf(directory, taken.number) === taken.stamp) rmSync(join(directory, String(taken.number)), { force: true })
}
