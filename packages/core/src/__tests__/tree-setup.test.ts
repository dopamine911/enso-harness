import { expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoProjectThreadSettings } from '../project-settings.ts'
import { prepareThreadTree } from '../tree-setup.ts'

/**
 * Preparing a new tree (#754): the project's gitignored files copied in, its setup commands run in
 * the tree, in order, bounded in time and output, redacted.
 */

function places(): { project: string; tree: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'enso-tree-setup-'))
  const places = { project: join(root, 'project'), tree: join(root, 'tree'), outside: join(root, 'outside') }
  for (const directory of Object.values(places)) mkdirSync(directory)
  return places
}

function settings(lists: { setup?: string[]; copy?: string[] }): EnsoProjectThreadSettings {
  return {
    tree: { value: 'worktree', tier: 'default' },
    setup: { value: lists.setup ?? [], tier: 'shared' },
    copy: { value: lists.copy ?? [], tier: 'local' },
  }
}

const PATH_ONLY = { PATH: '/usr/bin:/bin' }

test('nothing configured: nothing done, nothing to record', async () => {
  const { project, tree } = places()
  const threads = settings({})
  expect(await prepareThreadTree({ project, tree, threads, environment: PATH_ONLY, secretValues: [] })).toBeUndefined()
})

test('a file and a directory are copied into the tree, symlinks kept as links; a path the project lacks is missing', async () => {
  const { project, tree } = places()
  writeFileSync(join(project, '.env'), 'PORT=1')
  mkdirSync(join(project, 'config', 'deep'), { recursive: true })
  writeFileSync(join(project, 'config', 'deep', 'local.json'), '{}')
  symlinkSync('deep/local.json', join(project, 'config', 'link.json'))
  const threads = settings({ copy: ['.env', 'config', 'absent.txt'] })
  const outcome = await prepareThreadTree({ project, tree, threads, environment: PATH_ONLY, secretValues: [] })
  expect(outcome).toEqual({
    ok: false,
    copied: ['.env', 'config'],
    missing: ['absent.txt'],
    steps: [],
    tiers: { setup: 'shared', copy: 'local' },
  })
  expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('PORT=1')
  expect(readFileSync(join(tree, 'config', 'deep', 'local.json'), 'utf8')).toBe('{}')
  expect(lstatSync(join(tree, 'config', 'link.json')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(tree, 'config', 'link.json'))).toBe('deep/local.json')
})

test('⚠ a path that leaves the project is never copied: ../, absolute, or through a symlinked directory', async () => {
  const { project, tree, outside } = places()
  writeFileSync(join(outside, 'secret.txt'), 'not the project')
  writeFileSync(join(project, 'inside.txt'), 'the project')
  symlinkSync(outside, join(project, 'escape'))
  // An absolute path is refused even when it lands inside the project (PR #756 review): paths are relative.
  const paths = [
    '../outside/secret.txt',
    join(outside, 'secret.txt'),
    join(project, 'inside.txt'),
    'escape/secret.txt',
    '.',
  ]
  const outcome = await prepareThreadTree({
    project,
    tree,
    threads: settings({ copy: paths }),
    environment: PATH_ONLY,
    secretValues: [],
  })
  expect(outcome?.copied).toEqual([])
  expect(outcome?.missing).toEqual(paths)
  expect(existsSync(join(tree, 'escape'))).toBe(false)
  expect(existsSync(join(tree, 'secret.txt'))).toBe(false)
  expect(existsSync(join(tree, 'inside.txt'))).toBe(false)
})

test('commands run in the tree in order and stop at the first failure, with its exit code and output', async () => {
  const { project, tree } = places()
  const threads = settings({
    setup: ['pwd > first.txt; echo one', 'echo out; echo err >&2; exit 3', 'touch never.txt'],
  })
  const outcome = await prepareThreadTree({ project, tree, threads, environment: PATH_ONLY, secretValues: [] })
  expect(outcome?.ok).toBe(false)
  expect(outcome?.steps.map((step) => [step.command, step.exitCode, step.output, step.truncated])).toEqual([
    ['pwd > first.txt; echo one', 0, 'one\n', false],
    ['echo out; echo err >&2; exit 3', 3, 'out\nerr\n', false],
  ])
  expect(readFileSync(join(tree, 'first.txt'), 'utf8').trim()).toBe(tree)
  expect(existsSync(join(tree, 'never.txt'))).toBe(false)
  expect(existsSync(join(project, 'first.txt'))).toBe(false)
})

test('every command succeeding is ok', async () => {
  const { project, tree } = places()
  const threads = settings({ setup: ['true', 'echo done'] })
  const outcome = await prepareThreadTree({ project, tree, threads, environment: PATH_ONLY, secretValues: [] })
  expect(outcome?.ok).toBe(true)
  expect(outcome?.steps.map((step) => step.exitCode)).toEqual([0, 0])
})

test('⚠ long output keeps its tail, starting at a whole line, and says it was cut', async () => {
  const { project, tree } = places()
  // 20 000 numbered lines, about 130 KB: twice the bound.
  const threads = settings({ setup: ['seq 1 20000 | sed "s/^/line /"'] })
  const outcome = await prepareThreadTree({ project, tree, threads, environment: PATH_ONLY, secretValues: [] })
  const step = outcome?.steps[0]
  expect(step?.truncated).toBe(true)
  expect(step?.output.endsWith('line 20000\n')).toBe(true)
  expect(step?.output.startsWith('line ')).toBe(true)
  expect(step?.output.length).toBeLessThanOrEqual(64 * 1024)
  expect(step?.output).not.toContain('line 1\n')
})

test('⚠ a command past its time limit is killed: no exit code, said in its output, and the rest do not run', async () => {
  const { project, tree } = places()
  const threads = settings({ setup: ['echo started; sleep 30', 'touch never.txt'] })
  const outcome = await prepareThreadTree({
    project,
    tree,
    threads,
    environment: PATH_ONLY,
    secretValues: [],
    timeLimitMs: 300,
  })
  expect(outcome?.ok).toBe(false)
  expect(outcome?.steps).toHaveLength(1)
  expect(outcome?.steps[0]?.exitCode).toBeNull()
  expect(outcome?.steps[0]?.output).toContain('started')
  expect(outcome?.steps[0]?.output).toContain('time limit')
  expect(outcome?.steps[0]?.durationMs).toBeLessThan(10_000)
  expect(existsSync(join(tree, 'never.txt'))).toBe(false)
})

test('⚠ a known secret value in the output is redacted, and the command gets only the environment it is given', async () => {
  const { project, tree } = places()
  const threads = settings({ setup: ['echo "key is sk-live-0123456789abcdef"; echo "home=[$HOME]"'] })
  const outcome = await prepareThreadTree({
    project,
    tree,
    threads,
    environment: PATH_ONLY,
    secretValues: ['sk-live-0123456789abcdef'],
  })
  const output = outcome?.steps[0]?.output ?? ''
  expect(output).not.toContain('sk-live-0123456789abcdef')
  expect(output).toContain('home=[]')
})
