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
  ])
  expect(files[0]).toMatchObject({ tool: 'read', turn: 1, resultKey: `${read}#0` })
  // The last read has no result yet: nothing to open in the browser.
  expect(files.at(-1)?.resultKey).toBeUndefined()
})
