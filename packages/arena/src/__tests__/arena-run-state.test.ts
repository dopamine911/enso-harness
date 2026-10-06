import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectEnsoEvidence } from '../evidence.ts'
import { foldArenaManifest } from '../manifest.ts'
import { ensoBuildOf, sampleWorkspaces, threadHistoriesIn, turnAt } from '../run-state.ts'
import { type ArenaClock, openTimeline, pagePlace, readTimeline } from '../timeline.ts'

/**
 * The run's state beside the UI's (#608): the build Enso ran from, the work at each sample, and the
 * turn each screenshot shows. The turn join rests on one measured fact — every message of `/history`
 * carries its own millisecond `createdAt` — so a screenshot lands on one step of one turn.
 */

const THREAD = '4465dc39-7bd9-4cd3-83fd-d20af4fa2aa6'

/** git in a fixture repository; the identity a commit needs comes as flags, not from the machine. */
function gitIn(directory: string, ...args: string[]): void {
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: directory,
  })
}

test('⚠ the build record says when the checkout was dirty, and two dirty trees at one commit differ by their hash (#608 A12)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'arena-build-'))
  gitIn(repo, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '--quiet', '-m', 'first')

  const clean = ensoBuildOf(repo)
  expect(clean).toEqual({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: false })

  writeFileSync(join(repo, 'a.ts'), 'export const a = 2\n')
  const edited = ensoBuildOf(repo)
  expect(edited).toMatchObject({
    commit: clean?.commit,
    dirty: true,
    diffHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
  // An untracked file is uncommitted work too, and changes the hash.
  writeFileSync(join(repo, 'b.ts'), 'export const b = 1\n')
  expect(ensoBuildOf(repo)?.diffHash).not.toBe(edited?.diffHash)
  // A directory that is no repository has no build to record.
  expect(ensoBuildOf(mkdtempSync(join(tmpdir(), 'arena-nogit-')))).toBeUndefined()
})

test('⚠ a workspace sample moves when a file is written, and not when nothing is (#608 A8)', () => {
  const run = mkdtempSync(join(tmpdir(), 'arena-sample-'))
  const project = join(run, 'project')
  mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, 'index.html'), '<canvas></canvas>')
  writeFileSync(join(project, 'node_modules', 'dep', 'x.js'), 'skipped')
  writeFileSync(join(project, '.git', 'HEAD'), 'skipped')
  utimesSync(join(project, 'index.html'), 1, 1)

  const [first] = sampleWorkspaces(run, [project, join(run, 'gone')])
  expect(first).toEqual({ path: 'project', files: 1, bytes: 17, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) })
  expect(sampleWorkspaces(run, [project])[0]?.fingerprint).toBe(first?.fingerprint)

  writeFileSync(join(project, 'index.html'), '<canvas id="board"></canvas>')
  const [second] = sampleWorkspaces(run, [project])
  expect(second?.fingerprint).not.toBe(first?.fingerprint)
  expect(second?.bytes).toBe(28)
})

/** A thread's history as `GET …/history` answers it: messages with an id, a role and `createdAt`. */
function writeHistory(evidence: string, threadId: string, messages: readonly [string, string, string][]): void {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(
    join(evidence, `thread-${threadId}-history.json`),
    JSON.stringify({
      threadId,
      messages: messages.map(([id, role, createdAt]) => ({ id, role, parts: [], createdAt })),
    }),
  )
}

test('a moment falls in the turn of the last prompt before it, at the last message before it', () => {
  const history = [
    { id: 'u1', role: 'user', atMs: 1000 },
    { id: 'a1', role: 'assistant', atMs: 5000 },
    { id: 'u2', role: 'user', atMs: 9000 },
    { id: 'a2', role: 'assistant', atMs: 12_000 },
  ]
  expect(turnAt(history, 500)).toBeUndefined()
  expect(turnAt(history, 1000)).toEqual({ turnId: 'u1', messageId: 'u1' })
  expect(turnAt(history, 7000)).toEqual({ turnId: 'u1', messageId: 'a1' })
  expect(turnAt(history, 9500)).toEqual({ turnId: 'u2', messageId: 'u2' })
  expect(turnAt(history, 60_000)).toEqual({ turnId: 'u2', messageId: 'a2' })
})

test('⚠ the manifest places each screenshot on its thread’s turn, from the collected history (#608 A7)', () => {
  const run = mkdtempSync(join(tmpdir(), 'arena-turn-join-'))
  const evidence = join(run, 'enso', 'evidence')
  // The reference run's shape: one prompt, the assistant's first reply, its first tool round.
  writeHistory(evidence, THREAD, [
    ['8fd10ac1', 'user', '2026-10-05T23:23:04.914Z'],
    ['39d2404a', 'assistant', '2026-10-05T23:24:10.487Z'],
  ])
  let tick = 0
  const clock: ArenaClock = {
    wallNow: () => new Date(Date.parse('2026-10-05T23:23:00.000Z') + tick++ * 40_000),
    monotonicNow: () => tick * 40_000,
  }
  const timeline = openTimeline(join(run, 'timeline.jsonl'), clock)
  const inThread = pagePlace(`http://127.0.0.1:5178/?thread=${THREAD}`)
  timeline.record({ kind: 'screenshot', cause: 'sample', path: 's0.png' }, inThread) // 23:23:00, before the prompt
  timeline.record({ kind: 'screenshot', cause: 'sample', path: 's1.png' }, inThread) // 23:23:40, the prompt
  timeline.record({ kind: 'screenshot', cause: 'sample', path: 's2.png' }, inThread) // 23:24:20, the reply
  timeline.record({ kind: 'screenshot', cause: 'sample', path: 's3.png' }, pagePlace('http://127.0.0.1:5178/'))

  const manifest = foldArenaManifest({
    runId: 'r',
    events: readTimeline(join(run, 'timeline.jsonl')),
    evidence: [],
    histories: threadHistoriesIn(evidence),
  })
  expect(manifest.screenshots.map((shot) => [shot.path, shot.turn])).toEqual([
    ['s0.png', undefined],
    ['s1.png', { turnId: '8fd10ac1', messageId: '8fd10ac1' }],
    ['s2.png', { turnId: '8fd10ac1', messageId: '39d2404a' }],
    ['s3.png', undefined],
  ])
})

test('every read route of a thread is collected, or missing with its reason, one row each (#608 A2)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-routes-'))
  mkdirSync(join(root, 'project'))
  const asked: string[] = []
  const rows = await collectEnsoEvidence({
    serverOrigin: 'http://enso',
    directory: join(root, 'evidence'),
    threadIds: [THREAD],
    home: join(root, 'home'),
    project: join(root, 'project'),
    secretValues: [],
    fetchText: (url) => {
      asked.push(url.replace('http://enso', ''))
      return Promise.resolve(url.endsWith('/judge-cases') ? { status: 404, text: 'off' } : { status: 200, text: '{}' })
    },
  })
  const routes = ['history', 'stats', 'context', 'incidents', 'judge-cases', 'manifest', 'git', 'changes']
  for (const route of routes) expect(asked).toContain(`/api/threads/${THREAD}/${route}`)
  expect(asked).toContain('/api/trees')
  const byKind = new Map(rows.map((row) => [row.kind, row]))
  expect(byKind.get(`thread ${THREAD} history`)).toMatchObject({ status: 'collected' })
  expect(byKind.get(`thread ${THREAD} judge cases`)).toMatchObject({
    status: 'missing',
    reason: expect.stringContaining('404'),
  })
  expect(byKind.get('thread trees')).toMatchObject({ status: 'collected' })
})
