import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { bytesUnder, sizeOf } from './launch.ts'
import { isRunning } from './process-tree.ts'
import { readArenaControl } from './recorder.ts'

/**
 * Freeing what old runs hold that nothing reads (#742). Eighty runs took 10.5 GB, nearly all of it
 * `trace/` (Playwright zips only a human with `show-trace` opens) and `node_modules` the agent
 * installed into the scenario project and its thread trees. Both regenerate; the evidence a review
 * or `publish` reads (report, review, findings, score, manifest, screenshots, timeline, `enso/`)
 * does not, so it is never touched.
 *
 * ⚠ A run whose recorder is still running is never pruned, whatever its age: its trace is being
 * written and its trees are the agent's working copies.
 */

/** What `arena prune` frees, and from which runs (#742). */
export interface ArenaPruneOptions {
  readonly outDirectory: string
  /** Keep the newest N runs whole. */
  readonly keep?: number
  /** Prune only runs that started more than this many days before `now`. */
  readonly olderThanDays?: number
  readonly dryRun: boolean
  readonly now: Date
}

/** One directory pruned from a run, with the bytes of the files it held (#742). */
export interface ArenaPrunedPath {
  readonly path: string
  readonly bytes: number
}

/** A run that had something to free, and what was freed (or would be, on a dry run) (#742). */
export interface ArenaPrunedRun {
  readonly runDirectory: string
  readonly removed: readonly ArenaPrunedPath[]
}

interface ArenaRunOnDisk {
  readonly runDirectory: string
  readonly startedAt: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const RUN_STAMP = /-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/

/** When a run started: the stamp its directory is named with, else when its timeline was last written. */
function startedAtOf(runDirectory: string): number {
  const stamp = RUN_STAMP.exec(basename(runDirectory))
  if (stamp === null) return statSync(join(runDirectory, 'timeline.jsonl')).mtimeMs
  const [year, month, day, hour, minute, second] = stamp.slice(1).map(Number)
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, second ?? 0)
}

/** Every run under the out directory, newest first. A directory without a timeline is not a run. */
function runsNewestFirst(outDirectory: string): ArenaRunOnDisk[] {
  if (!existsSync(outDirectory)) return []
  const runs: ArenaRunOnDisk[] = []
  for (const child of readdirSync(outDirectory, { withFileTypes: true })) {
    const runDirectory = join(outDirectory, child.name)
    if (!child.isDirectory() || !existsSync(join(runDirectory, 'timeline.jsonl'))) continue
    runs.push({ runDirectory, startedAt: startedAtOf(runDirectory) })
  }
  return runs.toSorted(
    (left, right) => right.startedAt - left.startedAt || right.runDirectory.localeCompare(left.runDirectory),
  )
}

/** Is this path a real directory (a symlink to one is not followed)? */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Is this child of `directory` regenerable bulk: installed packages, or a package's build output? */
function isRegenerable(directory: string, childName: string): boolean {
  if (childName === 'node_modules') return true
  return (childName === 'dist' || childName === 'build') && existsSync(join(directory, 'package.json'))
}

/** The regenerable directories under a tree, never descending into one, into `.git`, or through a symlink. */
function regenerableUnder(directory: string, found: string[]): void {
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory() || child.name === '.git') continue
    const path = join(directory, child.name)
    if (isRegenerable(directory, child.name)) found.push(path)
    else regenerableUnder(path, found)
  }
}

/** The directories of a run's own Enso home the agent works in: `.enso/projects/<id>/trees/<thread>/`. */
function threadTreesOf(runDirectory: string): string[] {
  const projects = join(runDirectory, '.enso', 'projects')
  if (!isDirectory(projects)) return []
  const trees: string[] = []
  for (const project of readdirSync(projects)) {
    const treesDirectory = join(projects, project, 'trees')
    if (!isDirectory(treesDirectory)) continue
    for (const thread of readdirSync(treesDirectory)) {
      const tree = join(treesDirectory, thread)
      if (isDirectory(tree)) trees.push(tree)
    }
  }
  return trees
}

/** What a candidate run gives up: its traces, and the regenerable bulk in its project and thread trees. */
function removableIn(runDirectory: string): string[] {
  const found: string[] = []
  const trace = join(runDirectory, 'trace')
  if (isDirectory(trace)) found.push(trace)
  for (const root of [join(runDirectory, 'project'), ...threadTreesOf(runDirectory)]) {
    if (isDirectory(root)) regenerableUnder(root, found)
  }
  return found
}

/** Is the run's recorder still running? A run that never stopped but whose recorder died is fair game. */
function isLive(runDirectory: string): boolean {
  const control = readArenaControl(runDirectory)
  return control !== undefined && isRunning(control.pid)
}

function assertCount(value: number | undefined, label: string): void {
  if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
    throw new Error(`arena prune: ${label} must be a number of zero or more, got ${value}`)
  }
}

/** The runs the options select, before the live check: outside the newest `keep` AND older than the cutoff. */
function candidatesOf(options: ArenaPruneOptions): ArenaRunOnDisk[] {
  const { keep, olderThanDays } = options
  const cutoff = olderThanDays === undefined ? undefined : options.now.getTime() - olderThanDays * DAY_MS
  return runsNewestFirst(options.outDirectory).filter(
    (run, index) => (keep === undefined || index >= keep) && (cutoff === undefined || run.startedAt < cutoff),
  )
}

/**
 * Prunes old runs down to what a reader needs (#742): each candidate's `trace/`, and every
 * `node_modules` (and `dist`/`build` beside a `package.json`) in its project and thread trees.
 * Throws when neither `keep` nor `olderThanDays` is given, so a bare call never empties every run.
 */
export function pruneArenaRuns(options: ArenaPruneOptions): ArenaPrunedRun[] {
  if (options.keep === undefined && options.olderThanDays === undefined) {
    throw new Error('arena prune: give --keep <n>, --older-than <days>, or both')
  }
  assertCount(options.keep, 'keep')
  assertCount(options.olderThanDays, 'older-than')
  const pruned: ArenaPrunedRun[] = []
  for (const run of candidatesOf(options)) {
    if (isLive(run.runDirectory)) continue
    const removed = removableIn(run.runDirectory).map((path) => ({ path, bytes: bytesUnder(path) }))
    if (removed.length === 0) continue
    if (!options.dryRun) for (const { path } of removed) rmSync(path, { recursive: true, force: true })
    pruned.push({ runDirectory: run.runDirectory, removed })
  }
  return pruned
}

/** One line per run with what it freed (or would free, dry run), then the total (#742). */
export function renderPrunedRuns(pruned: readonly ArenaPrunedRun[], dryRun: boolean): string {
  if (pruned.length === 0) return 'Nothing to prune.'
  let total = 0
  const lines = pruned.map((run) => {
    const bytes = run.removed.reduce((sum, removed) => sum + removed.bytes, 0)
    total += bytes
    const paths = run.removed.map((removed) => relative(run.runDirectory, removed.path)).join(', ')
    return `${basename(run.runDirectory)}  ${sizeOf(bytes)}  ${paths}`
  })
  const runs = pruned.length === 1 ? '1 run' : `${pruned.length} runs`
  lines.push(`${dryRun ? 'Would free' : 'Freed'} ${sizeOf(total)} from ${runs}.`)
  return lines.join('\n')
}
