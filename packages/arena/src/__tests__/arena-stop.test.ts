import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitChildEnvironment } from '@enso/core/git'
import { ensoProjectsDir, projectIdOf, projectSnapshotsDir, realpathOrSelf } from '@enso/core/paths'
import type { Subprocess } from 'bun'
import { collectEnsoEvidence } from '../evidence.ts'
import type { ArenaEvidence } from '../manifest.ts'
import { collectAfterRecorderDied, controlFilePath, createShooter, isRunStack, makeProject } from '../recorder.ts'
import { type ArenaClock, openTimeline, pagePlace, readTimeline } from '../timeline.ts'

/**
 * What an arena run keeps when something on its way out has failed (#584 A1, A3, A9, A13; #607):
 * Enso down at the stop, a screenshot that cannot be taken, a recorder that died before its stop.
 * The recorder's browser half (the crash listener, the budget timer) is proven by a live run; what
 * each of those paths HANDS ON — the evidence rows, the timeline lines — is proven here.
 */

const THREAD = '0f6c1c4e-5a3b-4c55-9d43-6c1f0a8e2b71'
const SECRET = 'sk-live-notarealsecret-0123456789'

/** A clock one second further on at each event. */
function steppingClock(): ArenaClock {
  let tick = 0
  return {
    wallNow: () => new Date(Date.UTC(2026, 9, 5, 12, 0, ++tick)),
    monotonicNow: () => tick * 1000,
  }
}

/** A home whose project has a snapshot store holding one thread, with one file in it. */
function homeWithStore(root: string, project: string): { readonly home: string; readonly store: string } {
  const home = join(root, 'home')
  const store = projectSnapshotsDir(ensoProjectsDir(home), projectIdOf(realpathOrSelf(project)))
  mkdirSync(join(store, THREAD), { recursive: true })
  writeFileSync(join(store, THREAD, 'snapshot.json'), '{"turn":1}')
  return { home, store }
}

/** A pid that is certainly not running: a process that has already exited. */
function exitedPid(): number {
  return spawnSync('true').pid
}

const byKind = (rows: readonly ArenaEvidence[]): Map<string, ArenaEvidence> =>
  new Map(rows.map((row) => [row.kind, row]))

test('⚠ Enso down at the stop: each route is its own missing row, nothing is fetched, and the disk side is still kept (#584 A1, A3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-stop-'))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  const { home, store } = homeWithStore(root, project)
  let fetched = 0
  const rows = await collectEnsoEvidence({
    serverOrigin: 'http://enso',
    directory: join(root, 'evidence'),
    threadIds: [THREAD],
    home,
    project,
    secretValues: [],
    serverDown: 'Enso was not running when the run stopped',
    fetchText: () => {
      fetched += 1
      return Promise.resolve({ status: 200, text: '[]' })
    },
  })
  expect(fetched).toBe(0)
  const found = byKind(rows)
  for (const kind of [
    'live threads',
    'stored threads',
    'stats',
    'about',
    `thread ${THREAD}`,
    `thread ${THREAD} events`,
    `thread ${THREAD} eval`,
    `thread ${THREAD} log bundle`,
  ]) {
    expect(found.get(kind)).toEqual({ kind, status: 'missing', reason: 'Enso was not running when the run stopped' })
  }
  // Before #607 the store's row was dropped whenever the server was down, and when kept it named the home.
  const copy = join(root, 'evidence', 'snapshot-store')
  expect(found.get('snapshot store')).toEqual({ kind: 'snapshot store', status: 'collected', path: copy })
  expect(found.get('diff viewer')).toMatchObject({ status: 'missing' })

  // The copy is the run's: pruning the home's store after the fact costs the run nothing.
  rmSync(store, { recursive: true })
  expect(readFileSync(join(copy, THREAD, 'snapshot.json'), 'utf8')).toBe('{"turn":1}')
})

test('⚠ a screenshot that fails is a recorder-error line naming its cause, redacted — not a silent gap (#584 A9)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-shot-'))
  const timeline = openTimeline(join(root, 'timeline.jsonl'), steppingClock())
  const redact = (text: string): string => text.replaceAll(SECRET, '[redacted]')
  // The second try's pause (#665) is the test's: a camera that fails twice, with no real wait.
  const shooter = createShooter({ directory: root, timeline, redact, sleep: (): Promise<void> => Promise.resolve() })
  const url = `http://127.0.0.1:5178/?thread=${THREAD}`

  // No page yet: nothing taken, nothing said — the run has no picture to miss.
  expect(await shooter.shoot('enso-exit')).toBeUndefined()
  expect(readTimeline(timeline.path)).toEqual([])

  shooter.show({
    screenshot: () => Promise.reject(new Error(`Target crashed ${SECRET}\n    at Page.screenshot`)),
    url: () => url,
  })
  expect(await shooter.shoot('page-crash')).toBeUndefined()
  shooter.show({ screenshot: () => Promise.resolve(Buffer.alloc(0)), url: () => url })
  const taken = await shooter.shoot('sample')

  expect(readTimeline(timeline.path)).toEqual([
    expect.objectContaining({
      kind: 'recorder-error',
      during: 'screenshot (page-crash)',
      error: 'Target crashed [redacted]',
      page: pagePlace(url),
    }),
    expect.objectContaining({ kind: 'screenshot', cause: 'sample', path: taken, page: pagePlace(url) }),
  ])
})

// ⚠ #665: a capture racing a reload failed once, and as one recorder error it failed a whole run.
test('⚠ a screenshot that fails once and then works is a shot, after one pause — no recorder error (#665)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-shot-retry-'))
  const timeline = openTimeline(join(root, 'timeline.jsonl'), steppingClock())
  const paused: number[] = []
  const shooter = createShooter({
    directory: root,
    timeline,
    redact: (text: string): string => text,
    sleep: (ms: number): Promise<void> => {
      paused.push(ms)
      return Promise.resolve()
    },
  })
  const url = `http://127.0.0.1:5178/?thread=${THREAD}`
  let tries = 0
  shooter.show({
    screenshot: (): Promise<Uint8Array> => {
      tries += 1
      return tries === 1
        ? Promise.reject(new Error('Protocol error (Page.captureScreenshot): Unable to capture screenshot'))
        : Promise.resolve(Buffer.alloc(0))
    },
    url: () => url,
  })
  const taken = await shooter.shoot('navigation')
  expect(taken).toBeDefined()
  expect(tries).toBe(2)
  expect(paused).toHaveLength(1)
  expect(readTimeline(timeline.path)).toEqual([
    expect.objectContaining({ kind: 'screenshot', cause: 'navigation', path: taken }),
  ])
})

// #740: 39% of samples repeated the one before. A sample that shows nothing new is a line, not a file.
test('a sample with the same picture and workspaces writes no file and says so; a change writes a JPEG; an event shot is never skipped (#740)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-shot-sample-'))
  const timeline = openTimeline(join(root, 'timeline.jsonl'), steppingClock())
  const shooter = createShooter({ directory: root, timeline, redact: (text: string): string => text })
  const url = `http://127.0.0.1:5178/?thread=${THREAD}`
  let picture = Buffer.from('the page')
  const encodings = new Set<string>()
  shooter.show({
    screenshot: (options) => {
      encodings.add(options.type)
      return Promise.resolve(picture)
    },
    url: () => url,
  })

  const first = await shooter.sample('project:aa')
  expect(await shooter.sample('project:aa')).toBeUndefined()
  const workspaceMoved = await shooter.sample('project:bb')
  picture = Buffer.from('the page, changed')
  const pageMoved = await shooter.sample('project:bb')
  const navigation = await shooter.shoot('navigation')

  // Each shot written holds the page's bytes, as a JPEG; the skipped sample left no file.
  const written = [first, workspaceMoved, pageMoved, navigation]
  for (const path of written) expect(readFileSync(path ?? '', 'utf8')).toStartWith('the page')
  expect(readdirSync(root).filter((name) => name !== 'timeline.jsonl')).toHaveLength(written.length)
  expect([...encodings]).toEqual(['jpeg'])
  expect(readTimeline(timeline.path).map((event) => event.kind)).toEqual([
    'screenshot',
    'sample-skipped',
    'screenshot',
    'screenshot',
    'screenshot',
  ])
  expect(readTimeline(timeline.path)[1]).toMatchObject({ kind: 'sample-skipped', same: first, page: pagePlace(url) })
})

test('the scenario project is a working git repository with no sample hooks (#740)', () => {
  const project = join(mkdtempSync(join(tmpdir(), 'arena-project-')), 'project')
  makeProject(project)
  const hooks = join(project, '.git', 'hooks')
  expect(existsSync(hooks) ? readdirSync(hooks).filter((name) => name.endsWith('.sample')) : []).toEqual([])
  writeFileSync(join(project, 'index.html'), '<canvas></canvas>')
  // ⚠ Without the hook's GIT_INDEX_FILE: under `git commit -a` it is absolute, and `git add` here
  // would stage this file into the commit being made (#807).
  const git = (...args: string[]): number =>
    spawnSync('git', ['-c', 'user.name=arena', '-c', 'user.email=arena@example.invalid', ...args], {
      cwd: project,
      env: gitChildEnvironment(),
    }).status ?? -1
  expect(git('add', '.')).toBe(0)
  expect(git('commit', '--quiet', '-m', 'first')).toBe(0)
})

/** A run directory as a recorder killed outright leaves it: a timeline with no stop, and its control record. */
function deadRun(
  root: string,
  control: { readonly pid: number; readonly stackPid?: number; readonly home: string },
): {
  readonly runDirectory: string
  readonly project: string
} {
  const runDirectory = join(root, 'snake-dead')
  const project = join(runDirectory, 'project')
  mkdirSync(project, { recursive: true })
  const timeline = openTimeline(join(runDirectory, 'timeline.jsonl'), steppingClock())
  timeline.record({ kind: 'run-start', scenario: 'snake', project })
  timeline.record({ kind: 'navigation' }, pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`))
  writeFileSync(
    controlFilePath(runDirectory),
    JSON.stringify({ port: 1, driver: 'control', runDirectory, ...control }, null, 2),
  )
  return { runDirectory, project }
}

test('⚠ a recorder that died: the evidence is collected after the fact, from disk when its stack is gone, and the control record is cleared (#584 A13)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-dead-'))
  const { runDirectory, project } = deadRun(root, { pid: exitedPid(), stackPid: exitedPid(), home: join(root, 'home') })
  homeWithStore(root, project)

  const rows = await collectAfterRecorderDied(runDirectory, join(root, 'not-this-home'))
  const found = byKind(rows)
  // The thread the URL named is known from the timeline alone, and said missing on its own row.
  expect(found.get(`thread ${THREAD}`)).toMatchObject({
    status: 'missing',
    reason: expect.stringContaining('the recorder died'),
  })
  // The home is the control record's, not the fallback: its store is the one copied.
  expect(found.get('snapshot store')).toEqual({
    kind: 'snapshot store',
    status: 'collected',
    path: join(runDirectory, 'enso', 'evidence', 'snapshot-store'),
  })
  expect(existsSync(controlFilePath(runDirectory))).toBe(false)
})

test('a run whose recorder is still running is refused, and its control record kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-live-'))
  const { runDirectory } = deadRun(root, { pid: process.pid, home: join(root, 'home') })
  await expect(collectAfterRecorderDied(runDirectory, root)).rejects.toThrow(/is live/)
  expect(existsSync(controlFilePath(runDirectory))).toBe(true)
})

let decoy: Subprocess | undefined
afterEach(() => {
  decoy?.kill('SIGKILL')
  decoy = undefined
})

test('⚠ only `bun run dev <the run’s project>` counts as the run’s stack: the one check before a process is stopped', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-stack-'))
  const project = join(root, 'project')
  // The script blocks on its stdin, which this test holds open: alive until killed, no timer.
  // `bun run dev <project>` appends the project to the script, so `; true` takes it, not `cat`.
  const blockOnStdin = 'cat > /dev/null; true'
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: blockOnStdin } }))
  decoy = Bun.spawn(['bun', 'run', 'dev', project], { cwd: root, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
  const stack = decoy.pid

  expect(isRunStack(stack, project)).toBe(true)
  expect(isRunStack(stack, join(root, 'another-project'))).toBe(false)
  expect(isRunStack(process.pid, project)).toBe(false)
  expect(isRunStack(exitedPid(), project)).toBe(false)
})
