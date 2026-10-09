import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRunning } from './process-tree.ts'

/**
 * Launching a run, and cleaning up after one (#742). Before, a run had neither: it ran inside
 * whatever launched it, so its memory was that terminal's (an omp tab peaked at 46.5 GB and the
 * kernel's OOM kill took omp's own worker); nothing checked for room before it started; and what it
 * left in `/tmp` (a tmpfs, so RAM) stayed there.
 *
 * - **Its own temporary directory.** Every process of a run (the recorder, Playwright and its
 *   Chromium, Enso and the agent's commands) gets `TMPDIR` = `<tmp>/enso-arena-XXXXXX`, which names
 *   its owner and is removed after the run. One a killed run left is swept by the next `start`.
 * - **Its own scope.** With `systemd-run --user`, the run is a transient scope with a memory cap, so
 *   a run that overruns is killed inside it and nothing else is touched. The launcher stays outside,
 *   so it is there to clean up whatever the run left.
 * - **Room first.** Memory, `/tmp` and the disk under `--out` are checked before anything starts.
 */

const RUN_TMP_PREFIX = 'enso-arena-'
const RUN_TMP_OWNER = 'owner.json'

/** The memory a run's scope may use unless `--memory-max` says otherwise (#742). */
export const ARENA_DEFAULT_MEMORY_MAX = '6G'

/** Swap the scope may use past its memory cap: enough to ride out a spike, not enough to thrash. */
const ARENA_MEMORY_SWAP_MAX = '1G'

const GIB = 2 ** 30

/** The least room a run starts with (#742): below any of these, `start` refuses and says which. */
const HEADROOM_FLOORS = { memory: 3 * GIB, temporary: 2 * GIB, runs: 5 * GIB } as const

/** Who a run's temporary directory belongs to: the process running the run, and its scope if it has one. */
interface RunTmpOwner {
  readonly pid: number
  readonly unit?: string
}

/** A new temporary directory for one run, naming its owner so a later sweep can tell it is abandoned. */
export function makeRunTmp(owner: RunTmpOwner, base: string = tmpdir()): string {
  const directory = mkdtempSync(join(base, RUN_TMP_PREFIX))
  writeFileSync(join(directory, RUN_TMP_OWNER), JSON.stringify(owner))
  return directory
}

/**
 * Is the owner a run's temporary directory names still running? Its process, or its scope: a
 * launcher killed outside leaves the run going on in its scope. ⚠ A directory whose owner does not
 * read is kept: it is not this sweep's to judge.
 */
function ownerIsRunning(directory: string): boolean {
  let owner: unknown
  try {
    owner = JSON.parse(readFileSync(join(directory, RUN_TMP_OWNER), 'utf8'))
  } catch {
    return true
  }
  if (typeof owner !== 'object' || owner === null || !('pid' in owner) || typeof owner.pid !== 'number') return true
  if (isRunning(owner.pid)) return true
  if (!('unit' in owner) || typeof owner.unit !== 'string') return false
  return spawnSync('systemctl', ['--user', 'is-active', '--quiet', owner.unit]).status === 0
}

/** Remove the temporary directories of runs whose owner is gone; the paths removed. */
export function sweepAbandonedRunTmps(base: string = tmpdir()): string[] {
  const swept: string[] = []
  for (const child of readdirSync(base)) {
    const directory = join(base, child)
    if (!child.startsWith(RUN_TMP_PREFIX) || ownerIsRunning(directory)) continue
    rmSync(directory, { recursive: true, force: true })
    swept.push(directory)
  }
  return swept
}

/** The bytes of the regular files under `path`, symlinks not followed. */
export function bytesUnder(path: string): number {
  if (!existsSync(path)) return 0
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0
  let total = 0
  for (const child of readdirSync(path)) total += bytesUnder(join(path, child))
  return total
}

/** Bytes in gigabytes or megabytes, whichever reads. */
export function sizeOf(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`
}

function memoryAvailable(): number | undefined {
  if (!existsSync('/proc/meminfo')) return undefined
  const line = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))
  return line?.[1] === undefined ? undefined : Number(line[1]) * 1024
}

function freeBytes(path: string): number | undefined {
  try {
    const stat = statfsSync(path)
    return stat.bavail * stat.bsize
  } catch {
    return undefined
  }
}

/**
 * What a run would start short of, one sentence each; empty when there is room. A measure that
 * cannot be read (no `/proc`, a path that does not exist yet) is not a refusal.
 */
export function headroomShortfalls(outDirectory: string): string[] {
  const measured = [
    { what: 'memory available', bytes: memoryAvailable(), floor: HEADROOM_FLOORS.memory },
    { what: `free in ${tmpdir()}`, bytes: freeBytes(tmpdir()), floor: HEADROOM_FLOORS.temporary },
    { what: `free on the disk under ${outDirectory}`, bytes: freeBytes(outDirectory), floor: HEADROOM_FLOORS.runs },
  ]
  return measured
    .filter((measure) => measure.bytes !== undefined && measure.bytes < measure.floor)
    .map((measure) => `only ${sizeOf(measure.bytes ?? 0)} ${measure.what}; a run needs ${sizeOf(measure.floor)}`)
}

/** Who listens on `port`: its pid and command line, when `ss` can say. */
export function portHolder(port: number): { readonly pid?: number; readonly command?: string } {
  const listed = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
  const pid = /pid=(\d+)/.exec(listed.stdout ?? '')?.[1]
  if (pid === undefined) return {}
  const command = spawnSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' }).stdout?.trim()
  return { pid: Number(pid), ...(command === undefined || command === '' ? {} : { command }) }
}

/**
 * Whether a run can have a scope of its own here, capped at `memoryMax` when one is given:
 * `systemd-run --user` answers. ⚠ systemd is the one judge of a cap: it takes `6G`,
 * `1.5G`, `50%` and `infinity`, and refuses `6g`, `6GB` and `0`. A pattern here would be a second
 * grammar, wrong in both directions as the first one was.
 */
export function canScope(memoryMax?: string): boolean {
  const cap = memoryMax === undefined ? [] : ['-p', `MemoryMax=${memoryMax}`]
  return (
    spawnSync('systemd-run', ['--user', '--scope', '--quiet', ...cap, '--', 'true'], { stdio: 'ignore' }).status === 0
  )
}

/** The command line that runs `argv` as the transient scope `unit`, its memory capped at `memoryMax`. */
export function scopedCommand(unit: string, memoryMax: string, argv: readonly string[]): string[] {
  return [
    'systemd-run',
    '--user',
    '--scope',
    '--quiet',
    `--unit=${unit}`,
    '-p',
    `MemoryMax=${memoryMax}`,
    '-p',
    `MemorySwapMax=${ARENA_MEMORY_SWAP_MAX}`,
    '--',
    ...argv,
  ]
}

/** One `systemctl --user show` property of a unit, empty when systemd has nothing to say. */
function unitProperty(unit: string, property: string): string {
  return (
    spawnSync('systemctl', ['--user', 'show', '-p', property, '--value', unit], { encoding: 'utf8' }).stdout?.trim() ??
    ''
  )
}

/**
 * End a run's scope once its main process is gone: stop what is left in it, and say how many
 * processes that was and how the scope ended (`oom-kill` when the run hit its memory cap).
 */
export function endScope(unit: string): { readonly stopped: number; readonly result: string } {
  const group = unitProperty(unit, 'ControlGroup')
  const procs = group === '' ? '' : join('/sys/fs/cgroup', group, 'cgroup.procs')
  const stopped = procs !== '' && existsSync(procs) ? readFileSync(procs, 'utf8').split('\n').filter(Boolean).length : 0
  spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
  const result = unitProperty(unit, 'Result') || 'success'
  spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' })
  return { stopped, result }
}
