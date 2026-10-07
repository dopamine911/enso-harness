import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pruneArenaRuns, renderPrunedRuns } from '../prune.ts'
import { controlFilePath } from '../recorder.ts'

/**
 * What `arena prune` frees and what it must leave (#742): only regenerable bulk (traces, installed
 * packages, a package's build output) from runs outside the newest N or older than the cutoff, and
 * never anything from a run whose recorder still runs, nor the evidence `publish` and a review read.
 */

const NOW = new Date(Date.UTC(2026, 9, 7, 12, 0, 0))
const THREAD = '0f6c1c4e-5a3b-4c55-9d43-6c1f0a8e2b71'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function outDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'arena-prune-'))
  roots.push(root)
  return root
}

function writeFile(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x'.repeat(bytes))
}

/** A finished run with evidence, a 1000-byte trace, and 200 bytes of `node_modules` in its project. */
function runAt(out: string, stamp: string): string {
  const runDirectory = join(out, `snake-${stamp}`)
  writeFile(join(runDirectory, 'timeline.jsonl'), 10)
  for (const file of ['manifest.json', 'report.md', 'review.md', 'findings.json', 'score.md', 'brief.md']) {
    writeFile(join(runDirectory, file), 5)
  }
  writeFile(join(runDirectory, 'screenshots', '001.png'), 5)
  writeFile(join(runDirectory, 'enso', 'stack.log'), 5)
  writeFile(join(runDirectory, 'trace', 'context-1.zip'), 600)
  writeFile(join(runDirectory, 'trace', '.work', 'part'), 400)
  writeFile(join(runDirectory, 'project', 'package.json'), 2)
  writeFile(join(runDirectory, 'project', 'node_modules', 'left-pad', 'index.js'), 200)
  return runDirectory
}

const prunedNames = (out: string, options: { keep?: number; olderThanDays?: number }): string[] =>
  pruneArenaRuns({ outDirectory: out, dryRun: true, now: NOW, ...options }).map((run) => basename(run.runDirectory))

test('keep N leaves exactly the newest N runs whole', () => {
  const out = outDirectory()
  for (const day of ['01', '02', '03', '04']) runAt(out, `2026-10-${day}T10-00-00Z`)
  expect(prunedNames(out, { keep: 2 }).toSorted()).toEqual(['snake-2026-10-01T10-00-00Z', 'snake-2026-10-02T10-00-00Z'])
  expect(prunedNames(out, { keep: 4 })).toEqual([])
})

test('older than N days prunes only runs that started before the cutoff', () => {
  const out = outDirectory()
  runAt(out, '2026-10-04T11-59-59Z') // 3 days and one second before NOW
  runAt(out, '2026-10-04T12-00-00Z') // exactly 3 days: not older
  runAt(out, '2026-10-06T12-00-00Z')
  expect(prunedNames(out, { olderThanDays: 3 })).toEqual(['snake-2026-10-04T11-59-59Z'])
})

test('a run named without a stamp is dated by its timeline', () => {
  const out = outDirectory()
  const runDirectory = join(out, 'hand-made')
  writeFile(join(runDirectory, 'timeline.jsonl'), 10)
  writeFile(join(runDirectory, 'trace', 'context-1.zip'), 10)
  const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)
  utimesSync(join(runDirectory, 'timeline.jsonl'), twoDaysAgo, twoDaysAgo)
  expect(prunedNames(out, { olderThanDays: 3 })).toEqual([])
  expect(prunedNames(out, { olderThanDays: 1 })).toEqual(['hand-made'])
})

test('keep and older-than together prune only runs that meet both', () => {
  const out = outDirectory()
  for (const day of ['01', '02', '05', '06']) runAt(out, `2026-10-${day}T10-00-00Z`)
  // Newest 3 kept and older than 3 days: only the 1st. Newest 1 kept and older than 3 days: the 1st and 2nd.
  expect(prunedNames(out, { keep: 3, olderThanDays: 3 })).toEqual(['snake-2026-10-01T10-00-00Z'])
  expect(prunedNames(out, { keep: 1, olderThanDays: 3 }).toSorted()).toEqual([
    'snake-2026-10-01T10-00-00Z',
    'snake-2026-10-02T10-00-00Z',
  ])
})

test('⚠ a run whose recorder is running is never pruned, however old', () => {
  const out = outDirectory()
  const live = runAt(out, '2026-09-01T10-00-00Z')
  writeFileSync(controlFilePath(live), JSON.stringify({ pid: process.pid, runDirectory: live, driver: 'agent' }))
  const pruned = pruneArenaRuns({ outDirectory: out, keep: 0, olderThanDays: 1, dryRun: false, now: NOW })
  expect(pruned).toEqual([])
  expect(existsSync(join(live, 'trace', 'context-1.zip'))).toBe(true)
  expect(existsSync(join(live, 'project', 'node_modules'))).toBe(true)
})

test('⚠ pruning removes traces and installed packages, and leaves every file publish and a review read', () => {
  const out = outDirectory()
  const runDirectory = runAt(out, '2026-10-01T10-00-00Z')
  const tree = join(runDirectory, '.enso', 'projects', 'daed77413f852d26', 'trees', THREAD)
  writeFile(join(tree, 'package.json'), 2)
  writeFile(join(tree, 'node_modules', 'react', 'index.js'), 300)
  writeFile(join(tree, 'dist', 'bundle.js'), 50)
  writeFile(join(tree, 'src', 'dist', 'kept.js'), 7) // no package.json beside it: source, kept
  writeFile(join(tree, '.git', 'node_modules', 'odd'), 7) // never entered
  writeFile(join(runDirectory, '.enso', 'sessions', 'session.jsonl'), 5)
  writeFile(join(runDirectory, '.enso', 'snapshots', 'snapshot.json'), 5)

  const [pruned] = pruneArenaRuns({ outDirectory: out, keep: 0, dryRun: false, now: NOW })
  expect(
    pruned?.removed.map((removed) => [removed.path.slice(runDirectory.length + 1), removed.bytes]).toSorted(),
  ).toEqual([
    [`.enso/projects/daed77413f852d26/trees/${THREAD}/dist`, 50],
    [`.enso/projects/daed77413f852d26/trees/${THREAD}/node_modules`, 300],
    ['project/node_modules', 200],
    ['trace', 1000],
  ])
  for (const gone of ['trace', 'project/node_modules', `${tree}/node_modules`, `${tree}/dist`]) {
    expect(existsSync(gone.startsWith('/') ? gone : join(runDirectory, gone))).toBe(false)
  }
  for (const kept of [
    'timeline.jsonl',
    'manifest.json',
    'report.md',
    'review.md',
    'findings.json',
    'score.md',
    'brief.md',
    'screenshots/001.png',
    'enso/stack.log',
    'project/package.json',
    '.enso/sessions/session.jsonl',
    '.enso/snapshots/snapshot.json',
  ]) {
    expect(existsSync(join(runDirectory, kept))).toBe(true)
  }
  expect(existsSync(join(tree, 'src', 'dist', 'kept.js'))).toBe(true)
  expect(existsSync(join(tree, '.git', 'node_modules', 'odd'))).toBe(true)
})

test('a dry run deletes nothing and reports the same bytes a real run frees', () => {
  const out = outDirectory()
  const runDirectory = runAt(out, '2026-10-01T10-00-00Z')
  const dry = pruneArenaRuns({ outDirectory: out, keep: 0, dryRun: true, now: NOW })
  expect(existsSync(join(runDirectory, 'trace', 'context-1.zip'))).toBe(true)
  expect(existsSync(join(runDirectory, 'project', 'node_modules'))).toBe(true)
  const real = pruneArenaRuns({ outDirectory: out, keep: 0, dryRun: false, now: NOW })
  expect(real).toEqual(dry)
  expect(renderPrunedRuns(dry, true)).toBe(
    ['snake-2026-10-01T10-00-00Z  0 MB  trace, project/node_modules', 'Would free 0 MB from 1 run.'].join('\n'),
  )
  // Pruned once, a run has nothing left to free and is no longer listed.
  expect(pruneArenaRuns({ outDirectory: out, keep: 0, dryRun: false, now: NOW })).toEqual([])
  expect(renderPrunedRuns([], false)).toBe('Nothing to prune.')
})

test('⚠ neither keep nor older-than throws instead of pruning every run', () => {
  const out = outDirectory()
  const runDirectory = runAt(out, '2026-10-01T10-00-00Z')
  expect(() => pruneArenaRuns({ outDirectory: out, dryRun: false, now: NOW })).toThrow(/--keep/)
  expect(existsSync(join(runDirectory, 'trace'))).toBe(true)
})
