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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { reviewPullRequest } from './review-pr.ts'
import { drainReviewQueue } from './review-queue.ts'

const WORKER_LOCK = join(homedir(), '.cache', 'enso-review', 'worker.lock')
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

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`)
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
  mkdirSync(join(homedir(), '.cache', 'enso-review'), { recursive: true })
  writeFileSync(WORKER_LOCK, String(process.pid))
  return undefined
}

/** Reviews each pull request in turn; one that fails is logged and does not stop the rest. Answers the ones that failed. */
async function reviewEach(numbers: readonly number[]): Promise<Set<number>> {
  const failed = new Set<number>()
  for (const number of numbers) {
    try {
      const result = await reviewPullRequest({ number, dryRun: false })
      log(result.summary)
      if (result.failed) failed.add(number)
    } catch (error: unknown) {
      log(`#${number}: review failed — ${String(error)}`)
      failed.add(number)
    }
  }
  return failed
}

/**
 * Records the heads a poll saw, except those of pull requests whose review just failed. ⚠ A failed
 * review's head stays unseen, so the next poll tries it again; recording it would leave a failed head
 * unreviewed until the next push (#993's review).
 */
export function recordSeenHeads(
  lastSeenHeads: Map<number, string>,
  open: readonly OpenPullRequest[] | undefined,
  failed: ReadonlySet<number>,
): void {
  for (const pullRequest of open ?? []) {
    if (!failed.has(pullRequest.number)) lastSeenHeads.set(pullRequest.number, pullRequest.headRefOid)
  }
}

/** One pass: the queue, the poll when it is due, the reviews they name. Records the heads the poll saw. */
async function workerPass(lastSeenHeads: Map<number, string>, poll: boolean): Promise<void> {
  let open: OpenPullRequest[] | undefined
  if (poll) {
    try {
      open = openPullRequests()
    } catch (error: unknown) {
      log(`poll failed — ${String(error)}`)
    }
  }
  const failed = await reviewEach(pullRequestsToReview(drainReviewQueue(), open, lastSeenHeads))
  recordSeenHeads(lastSeenHeads, open, failed)
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
  let nextPoll = firstPollAt
  for (;;) {
    const poll = Date.now() >= nextPoll
    if (poll) nextPoll = Date.now() + pollMilliseconds
    await workerPass(lastSeenHeads, poll)
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
    await workerPass(lastSeenHeads, options.reviewExisting)
    releaseWorkerLock()
    return
  }
  // With a baseline the first poll is one interval away; with --review-existing it is now.
  await runUntilStopped(lastSeenHeads, pollMilliseconds, options.reviewExisting ? 0 : Date.now() + pollMilliseconds)
}

if (import.meta.main) await main()
