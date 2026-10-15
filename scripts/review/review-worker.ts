#!/usr/bin/env bun

/**
 * The local review worker (#981): reviews pull requests as they change, one at a time, with
 * `review-pr.ts`, until stopped.
 *
 *   bun run review-worker [--once] [--poll-seconds <n>] [--review-existing]
 *
 * Two ways a pull request reaches it:
 *   - THE QUEUE (`review-queue.ts`), checked every few seconds: a session that pushed ran
 *     `bun run review-notify`, so its review starts at once.
 *   - THE POLL, every `--poll-seconds` (180): every open pull request whose head changed since the
 *     worker last looked. ⚠ The poll is what makes it correct; the queue only makes it fast. A
 *     notify that never came, a push from another machine, a worker that was stopped: the next poll
 *     finds each one, because `review-pr.ts` skips a head it already reviewed (from the status
 *     comment), so asking again is cheap and never reviews twice.
 *
 * ⚠ IT STARTS FROM A BASELINE. At start the worker records every open pull request's head without
 * reviewing it, and from then on reviews what changes, and what is queued. Without the baseline, the
 * first poll would see every open pull request as changed and post a full review on each — 20 of them
 * when this was written, an hour of reviews nobody asked for. `--review-existing` skips the baseline,
 * for when that backlog IS wanted.
 *
 * `--once` takes the queue (and, with `--review-existing`, one poll), reviews what they name, and
 * exits: for a cron job, or a test.
 * One worker per machine: a second one refuses to start while the first's lock names a live process.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { RUNS_DIRECTORY, WORKER_LOCK, WORKER_LOG } from './review-paths.ts'
import { reviewPullRequest } from './review-pr.ts'
import { drainReviewQueue } from './review-queue.ts'

const DEFAULT_POLL_SECONDS = 180
/** How often the queue is checked between polls. */
const QUEUE_CHECK_MILLISECONDS = 10_000
const MILLISECONDS_PER_SECOND = 1000

/** An open pull request, as the poll lists it. */
export interface OpenPullRequest {
  readonly number: number
  readonly headRefOid: string
  readonly isDraft: boolean
}

/**
 * What to review now, in order: the queued numbers first (a session asked), then each open,
 * non-draft pull request whose head is not the one last seen. Each number once.
 */
export function pullRequestsToReview(
  queued: readonly number[],
  open: readonly OpenPullRequest[] | undefined,
  lastSeenHeads: ReadonlyMap<number, string>,
): number[] {
  const changed = (open ?? [])
    .filter((pullRequest) => !pullRequest.isDraft && lastSeenHeads.get(pullRequest.number) !== pullRequest.headRefOid)
    .map((pullRequest) => pullRequest.number)
  return [...new Set([...queued, ...changed])]
}

function openPullRequests(): OpenPullRequest[] {
  const answer = Bun.spawnSync(
    ['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefOid,isDraft'],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  if (answer.exitCode !== 0) throw new Error(`gh pr list: ${answer.stderr.toString().trim()}`)
  return JSON.parse(answer.stdout.toString()) as OpenPullRequest[]
}

/** A line on the terminal, and in `worker.log`, which `review-status` reads, so a worker run in the background is not silent. */
function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`
  process.stdout.write(stamped)
  appendFileSync(WORKER_LOG, stamped)
}

/** Takes the worker lock, or answers the pid of the live worker that holds it. */
function takeLock(): number | undefined {
  if (existsSync(WORKER_LOCK)) {
    const holder = Number(readFileSync(WORKER_LOCK, 'utf8'))
    try {
      process.kill(holder, 0)
      return holder
    } catch {
      // A lock left by a worker that is gone: take it over.
    }
  }
  mkdirSync(RUNS_DIRECTORY, { recursive: true })
  writeFileSync(WORKER_LOCK, String(process.pid))
  return undefined
}

/** What one review ended as, for the bookkeeping after a pass. `head` is the head it was at, when known. */
export interface ReviewOutcome {
  readonly number: number
  readonly failed: boolean
  readonly head: string | undefined
}

/** Reviews each pull request in turn; one that fails is logged and does not stop the rest. */
async function reviewEach(numbers: readonly number[]): Promise<ReviewOutcome[]> {
  const outcomes: ReviewOutcome[] = []
  for (const number of numbers) {
    try {
      const result = await reviewPullRequest({ number, dryRun: false })
      log(result.summary)
      outcomes.push({ number, failed: result.failed, head: result.head })
    } catch (error: unknown) {
      log(`#${number}: review failed — ${String(error)}`)
      outcomes.push({ number, failed: true, head: undefined })
    }
  }
  return outcomes
}

/** How many times a review may fail at one head before the worker stops trying it by itself. */
export const MAXIMUM_ATTEMPTS_PER_HEAD = 3
const SHORT_SHA_LENGTH = 7

/** Failed attempts so far, per pull request, at the head they failed at. */
export type FailureCounts = Map<number, { readonly head: string | undefined; readonly count: number }>

/** A failed review's attempt count: one more when it failed at the same head as before, else a first. */
function attemptCount(failures: FailureCounts, number: number, head: string | undefined): number {
  const earlier = failures.get(number)
  return earlier !== undefined && earlier.head === head ? earlier.count + 1 : 1
}

/**
 * The bookkeeping after a pass; answers the lines to log.
 *   - Every head the poll saw is recorded, except a failed review's.
 *   - ⚠ A failed review's head is FORGOTTEN, even one the baseline or an earlier poll recorded, so
 *     the next poll names it again. Only skipping the write was not enough: a queued review that failed
 *     in a pass with no poll kept the baseline's head and was never retried (#993's review).
 *   - After `MAXIMUM_ATTEMPTS_PER_HEAD` failures at one head, the head is recorded instead: a failure
 *     that does not go away (docker down, a token that cannot be minted) would otherwise cost a
 *     worktree, an install and a run folder every poll, and hold up every other review. A notify still
 *     retries it, because queued numbers are reviewed whatever the recorded head.
 *   - A success clears the pull request's count.
 */
export function afterReviews(
  lastSeenHeads: Map<number, string>,
  failures: FailureCounts,
  open: readonly OpenPullRequest[] | undefined,
  outcomes: readonly ReviewOutcome[],
): string[] {
  const failedNumbers = new Set(outcomes.filter((outcome) => outcome.failed).map((outcome) => outcome.number))
  for (const pullRequest of open ?? []) {
    if (!failedNumbers.has(pullRequest.number)) lastSeenHeads.set(pullRequest.number, pullRequest.headRefOid)
  }
  const givenUp: string[] = []
  for (const outcome of outcomes) {
    if (!outcome.failed) {
      failures.delete(outcome.number)
      continue
    }
    const head = outcome.head ?? open?.find((pullRequest) => pullRequest.number === outcome.number)?.headRefOid
    const count = attemptCount(failures, outcome.number, head)
    failures.set(outcome.number, { head, count })
    if (count < MAXIMUM_ATTEMPTS_PER_HEAD || head === undefined) {
      lastSeenHeads.delete(outcome.number)
      continue
    }
    lastSeenHeads.set(outcome.number, head)
    givenUp.push(
      `#${outcome.number}: giving up at ${head.slice(0, SHORT_SHA_LENGTH)} after ${count} failed reviews; bun run review-notify ${outcome.number} to retry`,
    )
  }
  return givenUp
}

/**
 * One pass: the queue, the poll when it is due, the reviews they name, then the bookkeeping
 * (`afterReviews`): heads the poll saw are recorded, a failed review's head is forgotten for a retry.
 */
async function workerPass(lastSeenHeads: Map<number, string>, failures: FailureCounts, poll: boolean): Promise<void> {
  let open: OpenPullRequest[] | undefined
  if (poll) {
    try {
      open = openPullRequests()
    } catch (error: unknown) {
      log(`poll failed — ${String(error)}`)
    }
  }
  const outcomes = await reviewEach(pullRequestsToReview(drainReviewQueue(), open, lastSeenHeads))
  for (const line of afterReviews(lastSeenHeads, failures, open, outcomes)) log(line)
}

/** What the command line asks of the worker. */
export interface WorkerOptions {
  readonly once: boolean
  readonly pollSeconds: number
  readonly reviewExisting: boolean
}

/** The command line: `--once`, `--poll-seconds <n>`, `--review-existing`. */
export function parseWorkerArguments(argv: readonly string[]): WorkerOptions {
  const pollIndex = argv.indexOf('--poll-seconds')
  const pollSeconds = pollIndex === -1 ? DEFAULT_POLL_SECONDS : Number(argv[pollIndex + 1])
  if (!Number.isInteger(pollSeconds) || pollSeconds <= 0) throw new Error('--poll-seconds takes a whole number')
  return { once: argv.includes('--once'), pollSeconds, reviewExisting: argv.includes('--review-existing') }
}

/** The heads the worker starts from: every open pull request's current one, so only later changes are reviewed. */
function baselineHeads(): Map<number, string> {
  const heads = new Map(openPullRequests().map((pullRequest) => [pullRequest.number, pullRequest.headRefOid] as const))
  log(
    `baseline: ${heads.size} open pull requests as they are now; reviewing what changes from here, and what is queued`,
  )
  return heads
}

/** Holds the worker lock until Ctrl-C: `false` when another live worker has it, said on stderr. */
function holdWorkerLock(): boolean {
  const holder = takeLock()
  if (holder !== undefined) {
    process.stderr.write(
      `a review worker is already running (pid ${holder}); stop it first, or leave it to do the work\n`,
    )
    process.exitCode = 1
    return false
  }
  process.on('SIGINT', () => {
    releaseWorkerLock()
    process.exit(0)
  })
  return true
}

function releaseWorkerLock(): void {
  rmSync(WORKER_LOCK, { force: true })
}

/** The worker until stopped: the queue every few seconds, the poll when it is due. */
async function runUntilStopped(
  lastSeenHeads: Map<number, string>,
  pollMilliseconds: number,
  firstPollAt: number,
): Promise<never> {
  const failures: FailureCounts = new Map()
  let nextPoll = firstPollAt
  for (;;) {
    const poll = Date.now() >= nextPoll
    if (poll) nextPoll = Date.now() + pollMilliseconds
    await workerPass(lastSeenHeads, failures, poll)
    await Bun.sleep(QUEUE_CHECK_MILLISECONDS)
  }
}

async function main(): Promise<void> {
  const options = parseWorkerArguments(process.argv.slice(2))
  if (!holdWorkerLock()) return
  const pollMilliseconds = options.pollSeconds * MILLISECONDS_PER_SECOND
  const lastSeenHeads = options.reviewExisting ? new Map<number, string>() : baselineHeads()
  log(
    `review worker started: queue every ${QUEUE_CHECK_MILLISECONDS / MILLISECONDS_PER_SECOND}s, poll every ${options.pollSeconds}s`,
  )
  if (options.once) {
    await workerPass(lastSeenHeads, new Map(), options.reviewExisting)
    releaseWorkerLock()
    return
  }
  // With a baseline the first poll is one interval away; with --review-existing it is now.
  await runUntilStopped(lastSeenHeads, pollMilliseconds, options.reviewExisting ? 0 : Date.now() + pollMilliseconds)
}

if (import.meta.main) await main()
