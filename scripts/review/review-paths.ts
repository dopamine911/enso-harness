/**
 * Where the local reviewer keeps its state (#981), named once. The worker, the status tool, the
 * queue and the runner all read these; a second copy of a path would let `review-status` look in one
 * place while the worker writes another, and report "not running" under a running worker (#993's review).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** A short head, as a run folder's name and the status comments print it. */
const SHORT_HEAD_LENGTH = 7
/** `runFolderName`'s shape, read back. */
const RUN_FOLDER_NAME = /^pr-(\d+)-([0-9a-f]+)-(\d+)$/

/** Every run's folder (`runFolderName`), the queue, the lock, the log. */
export const RUNS_DIRECTORY = join(homedir(), '.cache', 'enso-review')
/** One empty file per queued pull request number (`review-queue.ts`). */
export const REVIEW_QUEUE_DIRECTORY = join(RUNS_DIRECTORY, 'queue')
/** The running worker's pid (`review-worker.ts`): one worker per machine. */
export const WORKER_LOCK = join(RUNS_DIRECTORY, 'worker.lock')
/** Every line the worker prints, appended (`review-status.ts` shows the last ones). */
export const WORKER_LOG = join(RUNS_DIRECTORY, 'worker.log')

/**
 * A run's folder name: `pr-<number>-<short head>-<start, epoch ms>`. The runner writes it, and
 * `review-status` and the worker's start-up cleanup read it back, so it is spelled here, once.
 */
export function runFolderName(number: number, head: string, startedAt: number): string {
  return `pr-${number}-${head.slice(0, SHORT_HEAD_LENGTH)}-${startedAt}`
}

/** A run folder's name, read back. */
export interface RunFolder {
  readonly number: number
  readonly shortHead: string
  readonly startedAt: number
}

/** The run folder a name describes, or `undefined` for anything else in the directory. */
export function runFolderOf(name: string): RunFolder | undefined {
  const match = RUN_FOLDER_NAME.exec(name)
  if (match === null) return undefined
  return { number: Number(match[1]), shortHead: match[2] ?? '', startedAt: Number(match[3]) }
}
