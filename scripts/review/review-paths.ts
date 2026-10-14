/**
 * Where the local reviewer keeps its state (#981), named once. The worker, the status tool, the
 * queue and the runner all read these; a second copy of a path would let `review-status` look in one
 * place while the worker writes another, and report "not running" under a running worker (#993's review).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Every run's folder (`pr-<number>-<head>-<start>`), the queue, the lock, the log. */
export const RUNS_DIRECTORY = join(homedir(), '.cache', 'enso-review')
/** One empty file per queued pull request number (`review-queue.ts`). */
export const REVIEW_QUEUE_DIRECTORY = join(RUNS_DIRECTORY, 'queue')
/** The running worker's pid (`review-worker.ts`): one worker per machine. */
export const WORKER_LOCK = join(RUNS_DIRECTORY, 'worker.lock')
/** Every line the worker prints, appended (`review-status.ts` shows the last ones). */
export const WORKER_LOG = join(RUNS_DIRECTORY, 'worker.log')
