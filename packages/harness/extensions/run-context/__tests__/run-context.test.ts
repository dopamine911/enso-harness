import { expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ENSO_RUN_CONTEXT_ENTRY, type EnsoRunContext } from '@enso/core'
import { createRunContext, type GitResult, type RunContextDependencies } from '../index.ts'

/**
 * #435's recorder over its dependency seam (PR #438 review): the branches the review rounds added,
 * each where a real run would take it — git and the config faked, pi reduced to the `on` it
 * registers with and the `appendEntry` it writes through. The real harness path (two runs, one
 * record; a changed AGENTS.md, a second) is `agent-host.test.ts`'s.
 */

type BeforeAgentStart = (event: unknown, context: unknown) => Promise<void>

interface Skill {
  readonly name: string
  readonly filePath: string
}

/** One session under the recorder: `run` is one prompt's `before_agent_start`; the branch is pi's, entries appended in order. */
function session(
  dependencies: Partial<RunContextDependencies> = {},
  branch: unknown[] = [],
): { run: (skills?: readonly Skill[]) => Promise<void>; recorded: () => EnsoRunContext[] } {
  let handler: BeforeAgentStart | undefined
  const pi = {
    on: (event: string, registered: BeforeAgentStart): void => {
      if (event === 'before_agent_start') handler = registered
    },
    appendEntry: (customType: string, data: unknown): void => {
      branch.push({ type: 'custom', customType, data })
    },
  } as unknown as ExtensionAPI
  createRunContext({
    resolveSessionConfig: () =>
      Promise.resolve({ result: { kind: 'ok', config: {} }, path: '/u/config.json', sources: [] }),
    runGit: gitAnswering({ code: 0, stdout: 'f00d\n' }, { code: 0, stdout: '' }),
    ...dependencies,
  })(pi)
  return {
    run: async (skills: readonly Skill[] = []): Promise<void> => {
      if (handler === undefined) throw new Error('the recorder registered no before_agent_start handler')
      await handler(
        { systemPromptOptions: { skills, contextFiles: [] } },
        { cwd: '/work', sessionManager: { getBranch: () => branch } },
      )
    },
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
  return (args: string[]) => Promise.resolve(args[0] === 'rev-parse' ? head : status)
}

test('⚠ a status git cannot answer records the tree dirty, the revision kept: it cannot say the tree is clean', async () => {
  const recorder = session({ runGit: gitAnswering({ code: 0, stdout: 'f00d\n' }, { code: 1, stdout: '' }) })
  await recorder.run()
  expect(recorder.recorded()[0]?.git).toEqual({ revision: 'f00d', dirty: true })
})

test("⚠ a picc modes entry with none of picc's rule fields records the mode unknown; one with them, a hash", async () => {
  const moved = session({}, [{ type: 'custom', customType: 'modes', data: { mode: 'default', rules: [] } }])
  await moved.run()
  expect(moved.recorded()[0]?.mode).toBeNull()

  const current = session({}, [
    { type: 'custom', customType: 'modes', data: { mode: 'default', alwaysAllowRules: [] } },
  ])
  await current.run()
  expect(current.recorded()[0]?.mode).toEqual({ rulesHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
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
