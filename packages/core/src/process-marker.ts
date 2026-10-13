import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A marker per running process, reconciled at the next start (#385).
 *
 * A process can record its own orderly stop and its own crash (`log-process.ts`), but not a
 * SIGKILL, an OOM kill or a power loss — nothing runs after those. So every process leaves a
 * small file while it runs — its role, pid and start time — and removes it when it ends cleanly.
 * At the next start, every marker still there whose owner is not alive is a process that ended
 * without a record, and is said so, with the dead process's own pid and start time.
 *
 * Why a marker and not the log's tail (the issue's first proposal): the marker needs no day file,
 * survives a rotation, says which process died when two run at once (another checkout, another
 * port), and blames the launch that died rather than the one that noticed.
 *
 * ⚠ Liveness is NOT the pid alone: a pid is reused after a reboot, and a reboot is exactly the
 * power-loss case. On Linux the pid's actual start time (`/proc/<pid>/stat`) is compared with
 * the marker's; a mismatch is a dead owner. Elsewhere the pid is all there is.
 *
 * @module
 */

/** @group Logging */
export interface EnsoProcessMarker {
  /** The role on the process's records: `server`, `web`, `pi`. */
  readonly process: string
  readonly pid: number
  /** ISO instant the process started — the same figure its `logging configured` record carries. */
  readonly startedAt: string
}

/**
 * The marker directory under a logs directory: `ENSO_HOME/logs/processes`.
 *
 * @group Logging
 */
export function processMarkersDir(logsDir: string): string {
  return join(logsDir, 'processes')
}

const markerFilename = (marker: EnsoProcessMarker): string => `${marker.process}-${marker.pid}.json`

/** A marker being written: `<marker>.<writer pid>.tmp` until its rename (`writeProcessMarker`). */
const STAGING_NAME = /\.(\d+)\.tmp$/

/**
 * Write this process's marker, atomically (a half-written marker would read as malformed).
 *
 * @group Logging
 */
export function writeProcessMarker(logsDir: string, marker: EnsoProcessMarker): string {
  const directory = processMarkersDir(logsDir)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, markerFilename(marker))
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  renameSync(staging, path)
  return path
}

/**
 * Remove a marker; a marker already gone is not an error (two paths may both end a process).
 *
 * @group Logging
 */
export function removeProcessMarker(path: string): void {
  rmSync(path, { force: true })
}

/** How far the marker's start time and the kernel's may disagree and still be the same process: clock-tick rounding, two clocks read at different instants. */
const START_TIME_TOLERANCE_MS = 5000

/**
 * When the pid started, from the kernel, in milliseconds since the epoch; undefined where that
 * cannot be read (not Linux, no such pid, an unreadable `/proc`).
 *
 * `/proc/<pid>/stat` field 22 is the start time in clock ticks since boot; `/proc/stat`'s
 * `btime` is the boot instant. The tick is `sysconf(_SC_CLK_TCK)`, 100 on every Linux this runs
 * on; the tolerance above absorbs the rounding.
 */
function processStartTimeMs(pid: number): number | undefined {
  let stat: string
  let system: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    system = readFileSync('/proc/stat', 'utf8')
  } catch {
    return undefined
  }
  // The command name sits in parentheses and may itself hold spaces or parentheses: split after the LAST `)`.
  const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const startTicks = Number(afterCommand[19]) // field 22 of the whole line; `state` (field 3) is index 0 here
  const bootSeconds = Number(/^btime (\d+)$/m.exec(system)?.[1])
  if (!Number.isFinite(startTicks) || !Number.isFinite(bootSeconds)) return undefined
  return bootSeconds * 1000 + startTicks * 10
}

/** Whether `pid` names a running process. ESRCH: none. EPERM: one we may not signal — alive, someone else's. */
function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
  }
  return true
}

/**
 * Whether a marker's owner is still running: the pid exists, and where the kernel says when it
 * started, it agrees with the marker.
 *
 * @group Logging
 */
export function isProcessMarkerAlive(marker: EnsoProcessMarker, now: () => number = Date.now): boolean {
  if (!pidIsRunning(marker.pid)) return false
  const kernelStart = processStartTimeMs(marker.pid)
  if (kernelStart === undefined) return true
  const markerStart = Date.parse(marker.startedAt)
  if (!Number.isFinite(markerStart) || markerStart > now()) return false
  return Math.abs(kernelStart - markerStart) <= START_TIME_TOLERANCE_MS
}

/**
 * A marker whose owner is gone, or a file in the marker directory that is not a marker.
 *
 * @group Logging
 */
export type DeadProcessMarker =
  | { readonly kind: 'ended'; readonly marker: EnsoProcessMarker }
  | { readonly kind: 'unreadable'; readonly path: string }

const isMarker = (value: unknown): value is EnsoProcessMarker =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as EnsoProcessMarker).process === 'string' &&
  Number.isInteger((value as EnsoProcessMarker).pid) &&
  typeof (value as EnsoProcessMarker).startedAt === 'string'

/**
 * Every marker in the directory whose owner is not alive, removed and returned so the caller can
 * say so. A live owner's marker stays; so does this process's own (`ownPid`). A staging file left
 * by a writer that died mid-write is removed as unreadable.
 *
 * ⚠ Other processes write and remove markers in this directory WHILE it is read (#906): two
 * launchers starting together, a third ending. Three races, each measured as a false report (8
 * writers starting at once, 100 rounds: 5 "unreadable", 1 "ended without a record"), each closed
 * here. A live writer's staging file is a marker mid-write, not debris — skipped, never removed,
 * or its writer's rename fails. A file gone between the listing and the read was renamed or
 * removed by its owner — nothing to say. And a marker judged dead that is gone by then was its
 * owner's clean end: an owner removes its marker before it exits, so only a marker still there
 * after its owner has gone is an end nothing recorded.
 *
 * @group Logging
 */
export function reconcileProcessMarkers(logsDir: string, ownPid: number = process.pid): DeadProcessMarker[] {
  const directory = processMarkersDir(logsDir)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const dead: DeadProcessMarker[] = []
  for (const markerName of names) {
    const path = join(directory, markerName)
    const writer = STAGING_NAME.exec(markerName)?.[1]
    if (writer !== undefined && pidIsRunning(Number(writer))) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      parsed = undefined
    }
    if (!isMarker(parsed)) {
      removeProcessMarker(path)
      dead.push({ kind: 'unreadable', path })
      continue
    }
    if (parsed.pid === ownPid || isProcessMarkerAlive(parsed) || !existsSync(path)) continue
    removeProcessMarker(path)
    dead.push({ kind: 'ended', marker: parsed })
  }
  return dead
}
