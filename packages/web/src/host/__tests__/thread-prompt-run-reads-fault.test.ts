import { afterEach, expect, mock, test } from 'bun:test'
import { ENSO_RUN_CONTEXT_ENTRY, type EnsoTranscriptEntry } from '@enso/core'
import { GitReadError } from '@enso/core/git'

/**
 * The Diff Viewer's changes read (#553) refuses git's failure alone: a snapshot read that fails for
 * any other reason is a fault, and throws. bun keeps a replaced module for the whole run, so the
 * replacement reads the real store unless a test here names a failure.
 */

// Dynamic imports: the store module must be read before it is replaced, and the host read after.
let failure: Error | undefined
afterEach(() => {
  failure = undefined
})
const actual = await import('@enso/core/snapshot-store')
const realReadSnapshotChanges = actual.readSnapshotChanges
void mock.module('@enso/core/snapshot-store', () => ({
  ...actual,
  readSnapshotChanges: (options: Parameters<typeof realReadSnapshotChanges>[0]) =>
    failure === undefined ? realReadSnapshotChanges(options) : Promise.reject(failure),
}))
const { createThreadPromptRunReads } = await import('../thread-prompt-run-reads.ts')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const runContext = (id: string, hash: string): EnsoTranscriptEntry => ({
  kind: 'custom',
  id,
  customType: ENSO_RUN_CONTEXT_ENTRY,
  data: {
    git: null,
    config: { hash: 'c'.repeat(64), sources: [] },
    skills: [],
    contextFiles: [],
    mode: null,
    snapshot: { hash },
  },
})
const user = (id: string): EnsoTranscriptEntry => ({
  kind: 'message',
  id,
  role: 'user',
  parts: [{ type: 'text', text: id }],
})
const transcript = [runContext('rc1', A), user('u1'), runContext('rc2', B), user('u2')]
const reads = createThreadPromptRunReads({
  environment: {},
  liveLogs: new Map([['t', { cwd: '/t', transcript: () => transcript }]]),
  storedSession: () => Promise.resolve(undefined),
  storeOf: () => '/store',
})

test('⚠ a snapshot read that fails outside git throws, a fault and not a refusal that blames git', async () => {
  failure = new TypeError('the diff could not be parsed')
  await expect(reads.readPromptRunChanges('t', A, B)).rejects.toThrow('the diff could not be parsed')
})

test("git's failure to compare is a refusal with git's words", async () => {
  failure = new GitReadError(`fatal: bad object ${B}`)
  expect(await reads.readPromptRunChanges('t', A, B)).toEqual({
    kind: 'refused',
    reason: `git could not compare the snapshots: fatal: bad object ${B}`,
  })
})
