/**
 * The local review queue (#981): a directory with one empty file per pull request number waiting
 * for review. `review-notify.ts` adds one; `review-worker.ts` takes them all.
 *
 * WHY A DIRECTORY, NOT A SERVER. It needs no process to be running when a session notifies, it
 * survives the worker restarting, and a person can see it with `ls`. A pull request notified twice is
 * one file, so a burst of pushes queues one review, and the worker reviews whatever head the pull
 * request has when its turn comes.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where queued pull request numbers wait. */
const REVIEW_QUEUE_DIRECTORY = join(homedir(), '.cache', 'enso-review', 'queue')
/** A queue entry's name: the pull request number, nothing else. */
const QUEUE_ENTRY = /^\d+$/

/** Queues pull request `number` for review. Queuing one already queued changes nothing. */
export function enqueueReview(number: number, directory: string = REVIEW_QUEUE_DIRECTORY): void {
  if (!Number.isInteger(number) || number <= 0) throw new Error(`not a pull request number: ${number}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, String(number)), '')
}

/** Takes every queued pull request number off the queue, lowest first. Anything else in the directory is left alone. */
export function drainReviewQueue(directory: string = REVIEW_QUEUE_DIRECTORY): number[] {
  mkdirSync(directory, { recursive: true })
  const entries = readdirSync(directory).filter((entryName) => QUEUE_ENTRY.test(entryName))
  for (const queueEntry of entries) rmSync(join(directory, queueEntry), { force: true })
  return entries.map(Number).toSorted((first, second) => first - second)
}
