#!/usr/bin/env bun

/**
 * What the local review worker is doing, in one look (#981).
 *
 *   bun run review-status
 *
 * Everything it reports is read from the files the reviewer already writes under
 * `~/.cache/enso-review/`, so it works whether or not a worker is running, and from any checkout:
 *   - THE WORKER: the lock's pid, whether that process is alive, how long it has run, and which
 *     checkout (and commit) it runs from. Its code is that checkout's: a worker started before a merge
 *     runs the old code until restarted.
 *   - THE QUEUE: the pull requests notified and not yet taken.
 *   - IN PROGRESS: a run folder whose `tree/` worktree still exists is a review under way (the worktree
 *     is removed when a review ends), with its elapsed time and its last tool call.
 *   - RECENT: the last lines of `worker.log`, which the worker appends every line it prints to.
 */

import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { queuedReviews } from './review-queue.ts'

const RUNS_DIRECTORY = join(homedir(), '.cache', 'enso-review')
const WORKER_LOCK = join(RUNS_DIRECTORY, 'worker.lock')
/** The worker's own log, appended to by `review-worker.ts`. */
export const WORKER_LOG = join(RUNS_DIRECTORY, 'worker.log')
/** A run folder's name, as `review-pr.ts` makes it: `pr-<number>-<short head>-<start, epoch ms>`. */
const RUN_DIRECTORY_NAME = /^pr-(\d+)-([0-9a-f]+)-(\d+)$/
const RECENT_LOG_LINES = 8
const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

/** A run folder's name, read back. */
export interface RunFolder {
  readonly number: number
  readonly shortHead: string
  readonly startedAt: number
}

/** The run folder a name describes, or `undefined` for anything else in the directory. */
export function runFolderOf(name: string): RunFolder | undefined {
  const match = RUN_DIRECTORY_NAME.exec(name)
  if (match === null) return undefined
  return { number: Number(match[1]), shortHead: match[2] ?? '', startedAt: Number(match[3]) }
}

/** A duration as a person reads it: `42s`, `3m 05s`, `1h 12m`. */
export function readableDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / MILLISECONDS_PER_SECOND))
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  if (hours > 0) return `${hours}h ${String(minutes % MINUTES_PER_HOUR).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}s`
  return `${seconds}s`
}

/** The last tool call a run's decision log records, as one line, or `undefined` before the first. */
export function lastToolCall(decisionLogText: string): string | undefined {
  const lines = decisionLogText.split('\n').filter((line) => line.trim().length > 0)
  const last = lines.at(-1)
  if (last === undefined) return undefined
  const record = JSON.parse(last) as {
    tool?: string
    input?: { command?: unknown; file_path?: unknown }
    decision?: { kind?: string }
  }
  const target = record.input?.command ?? record.input?.file_path
  const firstLine = typeof target === 'string' ? (target.split('\n')[0] ?? '') : ''
  return `${record.tool ?? '?'} ${record.decision?.kind ?? '?'} ${firstLine}`.trim()
}

/** Everything `review-status` shows, gathered before it is rendered. */
export interface ReviewStatus {
  readonly worker:
    | { readonly kind: 'none' }
    | { readonly kind: 'stale'; readonly pid: number }
    | { readonly kind: 'running'; readonly pid: number; readonly uptime: string; readonly checkout: string }
  readonly queued: readonly number[]
  readonly inProgress: readonly {
    readonly run: RunFolder
    readonly elapsed: string
    readonly lastCall: string | undefined
  }[]
  readonly recent: readonly string[]
}

function workerLine(worker: ReviewStatus['worker']): string {
  if (worker.kind === 'none') return 'worker:      not running (start one: bun run review-worker)'
  if (worker.kind === 'stale') return `worker:      not running (stale lock names pid ${worker.pid}, which is gone)`
  return `worker:      running, pid ${worker.pid}, up ${worker.uptime}, from ${worker.checkout}`
}

/** The status as the terminal shows it. */
export function renderReviewStatus(status: ReviewStatus): string {
  const queued = status.queued.length === 0 ? 'empty' : status.queued.map((number) => `#${number}`).join(' ')
  const inProgress =
    status.inProgress.length === 0
      ? ['in progress: nothing']
      : status.inProgress.map(
          (current) =>
            `in progress: #${current.run.number} at ${current.run.shortHead}, ${current.elapsed} so far; last call: ${current.lastCall ?? 'none yet'}`,
        )
  const recent = status.recent.length === 0 ? ['  (no worker.log yet)'] : status.recent.map((line) => `  ${line}`)
  return [workerLine(status.worker), `queue:       ${queued}`, ...inProgress, 'recent:', ...recent, ''].join('\n')
}

function run(command: readonly string[]): string | undefined {
  const answer = Bun.spawnSync([...command], { stdout: 'pipe', stderr: 'pipe' })
  return answer.exitCode === 0 ? answer.stdout.toString().trim() : undefined
}

/**
 * The worker, from what was read: the lock's text (`undefined`: no lock), the start time `ps` gave for
 * its pid (`undefined`: no such process), and its checkout's description.
 */
export function workerFrom(
  lockText: string | undefined,
  startedAt: string | undefined,
  checkout: string,
  now: number,
): ReviewStatus['worker'] {
  if (lockText === undefined) return { kind: 'none' }
  const pid = Number(lockText)
  if (startedAt === undefined || startedAt.length === 0) return { kind: 'stale', pid }
  return { kind: 'running', pid, uptime: readableDuration(now - new Date(startedAt).getTime()), checkout }
}

/** The checkout a process runs from, and its commit; read from `/proc`, so Linux only. */
function checkoutOf(pid: number): string {
  try {
    const directory = readlinkSync(`/proc/${pid}/cwd`)
    return `${directory} (${run(['git', '-C', directory, 'log', '--oneline', '-1']) ?? 'not a git checkout'})`
  } catch {
    return 'an unknown directory'
  }
}

function readWorker(now: number): ReviewStatus['worker'] {
  const lockText = existsSync(WORKER_LOCK) ? readFileSync(WORKER_LOCK, 'utf8') : undefined
  const pid = Number(lockText)
  const startedAt = lockText === undefined ? undefined : run(['ps', '-o', 'lstart=', '-p', String(pid)])
  return workerFrom(lockText, startedAt, startedAt === undefined ? '' : checkoutOf(pid), now)
}

function readInProgress(now: number): ReviewStatus['inProgress'] {
  if (!existsSync(RUNS_DIRECTORY)) return []
  return readdirSync(RUNS_DIRECTORY).flatMap((folderName) => {
    const runFolder = runFolderOf(folderName)
    if (runFolder === undefined || !existsSync(join(RUNS_DIRECTORY, folderName, 'tree'))) return []
    const decisionLog = join(RUNS_DIRECTORY, folderName, 'tool-calls.jsonl')
    const lastCall = existsSync(decisionLog) ? lastToolCall(readFileSync(decisionLog, 'utf8')) : undefined
    return [{ run: runFolder, elapsed: readableDuration(now - runFolder.startedAt), lastCall }]
  })
}

function readRecent(): string[] {
  if (!existsSync(WORKER_LOG)) return []
  return readFileSync(WORKER_LOG, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-RECENT_LOG_LINES)
}

if (import.meta.main) {
  const now = Date.now()
  process.stdout.write(
    renderReviewStatus({
      worker: readWorker(now),
      queued: queuedReviews(),
      inProgress: readInProgress(now),
      recent: readRecent(),
    }),
  )
}
