import { expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ENSO_RUN_CONTEXT_ENTRY, type EnsoRunContext } from '@enso/core'
import type { GitResult } from '@enso/core/git'
import { createRunContext, type RunContextDependencies } from '../index.ts'

/**
 * #435's recorder over its dependency seam (PR #438 review): the branches the review rounds added,
 * each where a real run would take it — git and the config faked, pi reduced to the `on` it
 * registers with and the `appendEntry` it writes through. The real harness path (two runs, one
 * record; a changed AGENTS.md, a second) is `agent-host.test.ts`'s.
 */

type Handler = (event: unknown, context: unknown) => Promise<void>

interface Skill {
  readonly name: string
  readonly filePath: string
}

/**
 * One session under the recorder: `run` is one prompt — its `before_agent_start`, then the
 * `agent_start` pi emits for the loop; `continueRun` is a #436 Continue — the loop's `agent_start`
 * with no prompt before it (#445). The branch is pi's, entries appended in order.
 */
function session(
  dependencies: Partial<RunContextDependencies> = {},
  branch: unknown[] = [],
): {
  run: (skills?: readonly Skill[]) => Promise<void>
  continueRun: () => Promise<void>
  recorded: () => EnsoRunContext[]
} {
  const handlers = new Map<string, Handler>()
  const pi = {
    on: (event: string, registered: Handler): void => {
      handlers.set(event, registered)
    },
    appendEntry: (customType: string, data: unknown): void => {
      branch.push({ type: 'custom', customType, data })
    },
  } as unknown as ExtensionAPI
  createRunContext({
    resolveSessionConfig: () =>
      Promise.resolve({ result: { kind: 'ok', config: {} }, path: '/u/config.json', sources: [] }),
    runGit: gitAnswering({ code: 0, stdout: 'f00d\n', stderr: '' }, { code: 0, stdout: '', stderr: '' }),
    readPermissionPolicy: () => '{"permission":{"bash":"ask"}}',
    openSnapshotStore: storeTaking(HASH_A),
    ...dependencies,
  })(pi)
  const context = {
    cwd: '/work',
    sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => 'session-1' },
  }
  const emit = async (event: string, payload: unknown): Promise<void> => {
    const handler = handlers.get(event)
    if (handler === undefined) throw new Error(`the recorder registered no ${event} handler`)
    await handler(payload, context)
  }
  return {
    run: async (skills: readonly Skill[] = []): Promise<void> => {
      await emit('before_agent_start', { systemPromptOptions: { skills, contextFiles: [] } })
      await emit('agent_start', { type: 'agent_start' })
    },
    continueRun: () => emit('agent_start', { type: 'agent_start' }),
    recorded: () =>
      branch.flatMap((entry) => {
        const custom = entry as { type?: string; customType?: string; data?: EnsoRunContext }
        return custom.type === 'custom' && custom.customType === ENSO_RUN_CONTEXT_ENTRY && custom.data !== undefined
          ? [custom.data]
          : []
      }),
  }
}

/** git answering `rev-parse HEAD` with `head` and `status --porcelain` with `status`. */
function gitAnswering(head: GitResult, status: GitResult): RunContextDependencies['runGit'] {
  return (args: readonly string[]) => Promise.resolve(args[0] === 'rev-parse' ? head : status)
}

/** A store whose snapshots are the given hashes in turn, the first `changed`, the rest not; opened for `(tree, threadId)` as recorded. */
function storeTaking(
  ...hashes: string[]
): RunContextDependencies['openSnapshotStore'] & { opened: [string, string][] } {
  const opened: [string, string][] = []
  let taken = 0
  const open: RunContextDependencies['openSnapshotStore'] = (tree, threadId) => {
    opened.push([tree, threadId])
    return Promise.resolve({
      directory: `/store/${threadId}`,
      tree,
      snapshot: () => {
        const hash = hashes[Math.min(taken, hashes.length - 1)] ?? 'a'.repeat(40)
        taken += 1
        return Promise.resolve({ kind: 'taken' as const, taken: { hash, changed: taken === 1 } })
      },
    })
  }
  return Object.assign(open, { opened })
}

const HASH_A = '1'.repeat(40)
const HASH_B = '2'.repeat(40)

test("⚠ the record carries the tree's snapshot as the run began (#551): the store is opened for the session's cwd and id; a run on an unchanged tree appends nothing; an edited tree is a new record", async () => {
  const store = storeTaking(HASH_A, HASH_A, HASH_B)
  const recorder = session({ openSnapshotStore: store })
  await recorder.run()
  expect(store.opened).toEqual([['/work', 'session-1']])
  expect(recorder.recorded().map((record) => record.snapshot)).toEqual([{ hash: HASH_A }])
  // The same tree: the same hash, nothing to append.
  await recorder.run()
  expect(recorder.recorded()).toHaveLength(1)
  // The tree edited between runs: the next run's record names the new snapshot.
  await recorder.run()
  expect(recorder.recorded().map((record) => record.snapshot)).toEqual([{ hash: HASH_A }, { hash: HASH_B }])
})

test('⚠ no store, or a snapshot git that fails, records `snapshot: null` — never a thrown hook, never a stale hash', async () => {
  const noStore = session({ openSnapshotStore: () => Promise.resolve(undefined) })
  await noStore.run()
  expect(noStore.recorded()[0]?.snapshot).toBeNull()
  const refusing = session({
    openSnapshotStore: (tree) =>
      Promise.resolve({
        directory: '/store',
        tree,
        snapshot: () =>
          Promise.resolve({ kind: 'refused' as const, refused: { step: 'add', code: 128, stderr: 'fatal' } }),
      }),
  })
  await refusing.run()
  expect(refusing.recorded()[0]?.snapshot).toBeNull()
  expect(refusing.recorded()[0]?.git).toEqual({ revision: 'f00d', dirty: false })
})

test('⚠ a status git cannot answer records the tree dirty, the revision kept: it cannot say the tree is clean', async () => {
  const recorder = session({
    runGit: gitAnswering({ code: 0, stdout: 'f00d\n', stderr: '' }, { code: 1, stdout: '', stderr: '' }),
  })
  await recorder.run()
  expect(recorder.recorded()[0]?.git).toEqual({ revision: 'f00d', dirty: true })
})

test('⚠ an absent or unparseable policy records the mode unknown; a policy, a hash that moves with the mode', async () => {
  const absent = session({ readPermissionPolicy: () => undefined })
  await absent.run()
  expect(absent.recorded()[0]?.mode).toBeNull()
  const broken = session({ readPermissionPolicy: () => '{ not json' })
  await broken.run()
  expect(broken.recorded()[0]?.mode).toBeNull()

  const inDefault = session()
  await inDefault.run()
  const inPlan = session({}, [{ type: 'custom', customType: 'active_agent', data: { name: 'enso-mode-plan' } }])
  await inPlan.run()
  const defaultHash = inDefault.recorded()[0]?.mode?.rulesHash
  expect(defaultHash).toMatch(/^[0-9a-f]{64}$/)
  expect(inPlan.recorded()[0]?.mode?.rulesHash).not.toBe(defaultHash)
})

test('a config resolution that throws is recorded as unreadable, read from no file', async () => {
  const readable = session()
  await readable.run()
  const failed = session({
    resolveSessionConfig: () => Promise.reject(new Error('Invalid trust store: expected an object')),
  })
  await failed.run()
  const [config] = failed.recorded().map((record) => record.config)
  expect(config?.sources).toEqual([])
  expect(config?.hash).toMatch(/^[0-9a-f]{64}$/)
  expect(config?.hash).not.toBe(readable.recorded()[0]?.config.hash)
})

test('⚠ skills are recorded in code-point order, whatever the process locale collates', async () => {
  const recorder = session()
  await recorder.run([
    { name: 'b', filePath: '/skills/b.md' },
    { name: 'a', filePath: '/skills/a2.md' },
    { name: 'B', filePath: '/skills/B.md' },
    { name: 'a', filePath: '/skills/a1.md' },
  ])
  expect(recorder.recorded()[0]?.skills.map((skill) => skill.path)).toEqual([
    '/skills/B.md',
    '/skills/a1.md',
    '/skills/a2.md',
    '/skills/b.md',
  ])
})

test("⚠ a record this writer made that the reader's schema rejects is still compared as the last one: not appended again every run", async () => {
  const recorder = session()
  // An empty skill name — nothing pi's loader makes, and the schema's `minLength` refuses it.
  const unreadable = [{ name: '', filePath: '/skills/nameless.md' }]
  await recorder.run(unreadable)
  await recorder.run(unreadable)
  expect(recorder.recorded()).toHaveLength(1)
  // A real change still appends.
  await recorder.run([{ name: 'tdd', filePath: '/skills/tdd.md' }])
  expect(recorder.recorded()).toHaveLength(2)
})

// ⚠ A Continue (#436) runs with no `before_agent_start`; what moved since the last prompt — the
// revision, the config, the mode — must still be recorded, and the skills and context files the
// model receives are the transcript's: the last record's (#445).
test('⚠ a continued run after HEAD moved records the new revision, carrying the last prompt’s skills and context files (#445)', async () => {
  let head = 'f00d\n'
  const recorder = session({
    runGit: (args: readonly string[]) =>
      Promise.resolve(
        args[0] === 'rev-parse' ? { code: 0, stdout: head, stderr: '' } : { code: 0, stdout: '', stderr: '' },
      ),
  })
  await recorder.run([{ name: 'tdd', filePath: '/skills/tdd.md' }])
  expect(recorder.recorded()).toHaveLength(1)
  // The thread is torn, a commit lands, the operator continues.
  head = 'beef\n'
  await recorder.continueRun()
  const [first, second] = recorder.recorded()
  expect(recorder.recorded()).toHaveLength(2)
  expect(second?.git?.revision).toBe('beef')
  expect(second?.skills).toEqual(first?.skills ?? [])
  expect(second?.contextFiles).toEqual(first?.contextFiles ?? [])
  // Nothing moved: a second Continue appends nothing — and the prompt that follows it, recording as ever, neither.
  await recorder.continueRun()
  await recorder.run([{ name: 'tdd', filePath: '/skills/tdd.md' }])
  expect(recorder.recorded()).toHaveLength(2)
})

test('⚠ a continued run on a branch with no record writes none: the skills it runs under have no structured source (#445)', async () => {
  const recorder = session()
  await recorder.continueRun()
  expect(recorder.recorded()).toHaveLength(0)
})
