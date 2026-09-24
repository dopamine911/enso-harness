import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { branchContext } from '../branch-context.ts'

/**
 * #361 phase 4: Context Events and File Activity, off pi's own entries — built with pi's real
 * session manager, so every entry kind is one pi writes.
 */

let clock = Date.parse('2026-09-24T10:00:00.000Z')
const now = (): number => {
  clock += 1000
  return clock
}

function assistant(parts: unknown[]): never {
  return {
    role: 'assistant',
    content: parts,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: now(),
  } as never
}

const call = (id: string, name: string, args: Record<string, unknown>): unknown => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
})

interface StoredResult {
  readonly toolCallId: string
  readonly toolName: string
  readonly text: string
  readonly isError?: boolean
}

function result(session: SessionManager, { toolCallId, toolName, text, isError = false }: StoredResult): string {
  return session.appendMessage({
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: now(),
  } as never)
}

const tokens = (characters: number): number => Math.ceil(characters / 4)

test('events: an injected prompt section, a custom message, a prune and a compaction, each with the change it made', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendModelChange('anthropic', 'claude-a')
  session.appendMessage({
    role: 'system',
    content: '',
    sections: { preamble: 'p'.repeat(40), project_context: 'a'.repeat(80) },
    timestamp: now(),
  } as never)
  session.appendMessage({ role: 'user', content: 'go', timestamp: now() })
  session.appendMessage(assistant([call('c1', 'read', { path: 'big.txt' })]))
  const big = result(session, { toolCallId: 'c1', toolName: 'read', text: 'x'.repeat(400) })
  session.appendMessage(assistant([{ type: 'text', text: 'read it' }]))
  session.appendCustomMessageEntry('reminder', 'r'.repeat(40), false)
  session.appendContextEdit(big, null)
  session.appendModelChange('anthropic', 'claude-b')
  const kept = session.appendMessage({ role: 'user', content: 'again', timestamp: now() })
  session.appendCompaction('s'.repeat(20), kept, 9000)
  const { events } = branchContext(session.getBranch())
  expect(events.map((event) => [event.kind, event.label, event.turn])).toEqual([
    ['inject', 'project_context', 1],
    ['inject', 'reminder', 3],
    ['prune', 'pruned read result', 3],
    ['switch', 'model anthropic/claude-b', 3],
    ['compact', 'compacted: a summary replaced the context before it', 3],
  ])
  const [section, reminder, prune, switched, compaction] = events
  expect(section?.tokens).toBe(tokens(80))
  expect(reminder?.tokens).toBe(tokens(40))
  expect(prune?.tokens).toBe(-tokens(400))
  expect(switched?.tokens).toBe(0)
  // What the compaction reclaimed, by the trend's own measure: every message before `again` gone
  // (the pruned result already counted nothing), the summary in their place. The prompt is
  // re-issued with the compaction, so it is not reclaimed.
  const replaced =
    tokens('go'.length) +
    tokens('read'.length + JSON.stringify({ path: 'big.txt' }).length) +
    tokens('read it'.length) +
    tokens(40)
  expect(compaction?.tokens).toBe(tokens(20) - replaced)
})

// A session opening on its default model writes no `model_change` (pi writes one from `setModel`
// only); the model that answered is the one in use, as pi's `getSessionContextSettings` reads it.
test('a /model naming the model already answering is no switch; naming another is', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({ role: 'user', content: 'go', timestamp: now() })
  session.appendMessage(assistant([{ type: 'text', text: 'ok' }]))
  session.appendModelChange('anthropic', 'claude-test')
  session.appendMessage({ role: 'user', content: 'again', timestamp: now() })
  session.appendMessage(assistant([{ type: 'text', text: 'ok' }]))
  session.appendModelChange('anthropic', 'claude-other')
  const { events } = branchContext(session.getBranch())
  expect(events.map((event) => [event.kind, event.label])).toEqual([['switch', 'model anthropic/claude-other']])
})

// pi-agent-core writes a tools-only system message whenever the tools it can run differ from the
// ones the transcript declared (`declareToolChanges`): it changes tools, not instructions.
test('a later system message is named by what it changed: its sections, its tools, its instructions', () => {
  const session = SessionManager.inMemory(tmpdir())
  const tool = (name: string): unknown => ({ name, description: name, parameters: { type: 'object', properties: {} } })
  session.appendMessage({
    role: 'system',
    content: '',
    sections: { preamble: 'p' },
    toolsAdded: [tool('bash')],
    timestamp: now(),
  } as never)
  session.appendMessage({ role: 'user', content: 'go', timestamp: now() })
  session.appendMessage(assistant([{ type: 'text', text: 'ok' }]))
  session.appendMessage({
    role: 'system',
    content: '',
    toolsAdded: [tool('grep')],
    toolsRemoved: [{ name: 'bash' }],
    timestamp: now(),
  } as never)
  session.appendMessage({ role: 'system', content: 'be brief', sections: { docs: 'd' }, timestamp: now() } as never)
  const { events } = branchContext(session.getBranch())
  expect(events.map((event) => event.label)).toEqual(['system: tools +grep −bash', 'system: docs, instructions'])
})

test('settings: a thinking level or mode set after the first request is a switch; a malformed mode entry is no event', () => {
  const session = SessionManager.inMemory(tmpdir())
  // Where the thread began: set before the first request, so not events.
  session.appendThinkingLevelChange('medium')
  session.appendCustomEntry('modes', { mode: 'default' })
  session.appendMessage({ role: 'user', content: 'go', timestamp: now() })
  session.appendMessage(assistant([{ type: 'text', text: 'ok' }]))
  session.appendThinkingLevelChange('high')
  // The same level again changes nothing.
  session.appendThinkingLevelChange('high')
  session.appendCustomEntry('modes', { mode: 'plan' })
  // `modes` written by something that is not picc's shape names no mode: skipped, not `mode [object Object]`.
  session.appendCustomEntry('modes', { mode: { nested: true } })
  session.appendCustomEntry('modes', { mode: 'plan' })
  const { events } = branchContext(session.getBranch())
  expect(events.map((event) => [event.kind, event.label, event.turn, event.tokens])).toEqual([
    ['switch', 'thinking high', 2, 0],
    ['mode', 'mode plan', 2, 0],
  ])
})

test('files: reads with their range, writes and edits with their footprint, searches with each matched file', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({ role: 'user', content: 'work', timestamp: now() })
  session.appendMessage(
    assistant([
      call('r1', 'read', { path: 'src/a.ts', offset: 10, limit: 5 }),
      call('w1', 'write', { path: 'src/b.ts', content: 'one\ntwo\n' }),
      call('e1', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y\nz' }] }),
      call('g1', 'grep', { pattern: 'TODO', path: 'src' }),
      call('b1', 'bash', { command: 'ls' }),
      call('i1', 'read', { path: 'shot.png' }),
      call('i2', 'read', { path: 'shot.png' }),
    ]),
  )
  const read = result(session, { toolCallId: 'r1', toolName: 'read', text: 'text' })
  result(session, { toolCallId: 'w1', toolName: 'write', text: 'ok' })
  result(session, { toolCallId: 'e1', toolName: 'edit', text: 'boom', isError: true })
  result(session, {
    toolCallId: 'g1',
    toolName: 'grep',
    text: 'a.ts:3: TODO one\na.ts:9: TODO two\nc.ts:1: TODO three\n[2 files]',
  })
  result(session, { toolCallId: 'b1', toolName: 'bash', text: 'a.ts' })
  const { files } = branchContext(session.getBranch())
  expect(
    files.map((operation) => [
      operation.path,
      operation.kind,
      operation.subject,
      operation.added,
      operation.removed,
      operation.hits,
      operation.isError,
      operation.image,
    ]),
  ).toEqual([
    ['src/a.ts', 'read', 'lines 10–14', 0, 0, 0, false, false],
    ['src/b.ts', 'write', '', 2, 0, 0, false, false],
    ['src/a.ts', 'write', '', 2, 1, 0, true, false],
    ['src', 'search', 'TODO', 0, 0, 3, false, false],
    ['src/a.ts', 'search', 'TODO', 0, 0, 2, false, false],
    ['src/c.ts', 'search', 'TODO', 0, 0, 1, false, false],
    ['shot.png', 'read', '', 0, 0, 0, false, true],
    ['shot.png', 'read', '', 0, 0, 0, false, true],
  ])
  expect(files[0]).toMatchObject({ tool: 'read', turn: 1, resultKey: `${read}#0` })
  // The last reads have no result yet: nothing to open in the browser.
  expect(files.at(-1)?.resultKey).toBeUndefined()
  // Two identical calls in one reply, neither answered (an aborted run leaves them so): the same
  // path, kind, subject and time — and still two operations, each its own key.
  const [first, second] = files.slice(-2)
  expect(first?.key).not.toBe(second?.key)
  expect(new Set(files.map((operation) => operation.key)).size).toBe(files.length)
})

// pi normalises an edit's arguments only when it runs the call (`prepareEditArguments`); the
// branch keeps what the model sent.
test('an edit counts its footprint in every argument shape pi runs', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({ role: 'user', content: 'edit', timestamp: now() })
  const replacement = { oldText: 'x', newText: 'y\nz' }
  session.appendMessage(
    assistant([
      call('s1', 'edit', { path: 'as-text.ts', edits: JSON.stringify([replacement]) }),
      call('s2', 'edit', { path: 'one-object.ts', edits: replacement }),
      call('s3', 'edit', { path: 'legacy.ts', ...replacement }),
      call('s4', 'edit', { path: 'both.ts', edits: [replacement], ...replacement }),
      call('s5', 'edit', { path: 'not-json.ts', edits: '[{' }),
    ]),
  )
  const { files } = branchContext(session.getBranch())
  expect(files.map((operation) => [operation.path, operation.added, operation.removed])).toEqual([
    ['as-text.ts', 2, 1],
    ['one-object.ts', 2, 1],
    ['legacy.ts', 2, 1],
    ['both.ts', 4, 2],
    ['not-json.ts', 0, 0],
  ])
})

test("a search's hits: a file as grep's path is that file; a context line is no match; a path may hold spaces; find's 'none' is none", () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({ role: 'user', content: 'search', timestamp: now() })
  session.appendMessage(
    assistant([
      call('f1', 'grep', { pattern: 'TODO', path: 'src/foo.ts' }),
      call('c1', 'grep', { pattern: 'TODO', path: 'src', context: 1 }),
      call('n1', 'find', { pattern: '*.zig', path: 'src' }),
    ]),
  )
  // pi names a match by its basename when the searched path is a file (grep.js `formatPath`).
  result(session, { toolCallId: 'f1', toolName: 'grep', text: 'foo.ts:3: TODO one\nfoo.ts:9: TODO two' })
  result(session, {
    toolCallId: 'c1',
    toolName: 'grep',
    text: 'a.ts-2- const url = "host:8080: up"\na.ts:3: TODO\n--\nmy dir/b.ts:4: TODO: see a.ts-1- x',
  })
  // find answers "nothing" with a sentence (tools/find.js), not a file.
  result(session, { toolCallId: 'n1', toolName: 'find', text: 'No files found matching pattern' })
  const { files } = branchContext(session.getBranch())
  expect(files.map((operation) => [operation.path, operation.hits])).toEqual([
    ['src/foo.ts', 2],
    ['src', 2],
    ['src/a.ts', 1],
    ['src/my dir/b.ts', 1],
    ['src', 0],
  ])
})

test('every event has its own key — two alike in one moment, and each section of one prompt', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({
    role: 'system',
    content: '',
    sections: { preamble: 'p', project_context: 'a', memory: 'm' },
    timestamp: now(),
  } as never)
  session.appendMessage({ role: 'user', content: 'go', timestamp: now() })
  session.appendCustomMessageEntry('reminder', 'first', false)
  session.appendCustomMessageEntry('reminder', 'second', false)
  const { events } = branchContext(session.getBranch())
  expect(events.map((event) => event.label)).toEqual(['project_context', 'memory', 'reminder', 'reminder'])
  expect(new Set(events.map((event) => event.key)).size).toBe(events.length)
})
