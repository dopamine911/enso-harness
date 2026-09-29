import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { type SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import { parseLibraryPrompt, serializeLibraryPrompt } from '@enso/core'
import { branchContext, branchRequestDetail } from '../branch-context.ts'
import { branchStats } from '../branch-stats.ts'
import { foldSystem } from '../context-elements.ts'

/**
 * #361: a thread's context, request by request, off pi's own entries — built here with pi's real
 * session manager, so the entries read are the ones pi writes and the assembly is pi's own
 * (`buildContextEntries`, compaction included).
 */

type RecordedUsage = Extract<SessionEntry, { type: 'usage' }>['usage']

const usage = (input: number, cacheRead: number): RecordedUsage => ({
  input,
  output: 7,
  cacheRead,
  cacheWrite: 3,
  totalTokens: input + cacheRead + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
})

function assistant(parts: unknown[]): never {
  return {
    role: 'assistant',
    content: parts,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-test',
    usage: usage(100, 50),
    stopReason: 'stop',
    timestamp: Date.now(),
  } as never
}

const TOOL = { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }
const tokens = (characters: number): number => Math.ceil(characters / 4)

/** A leading system message as pi writes one: its own sections, a project file, one tool. */
function systemPrompt(): never {
  return {
    role: 'system',
    content: '',
    sections: { preamble: 'p'.repeat(40), tools: 't'.repeat(40), project_context: 'a'.repeat(80) },
    toolsAdded: [TOOL],
    timestamp: Date.now(),
  } as never
}

function threadWithACompaction(): SessionManager {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage(systemPrompt())
  session.appendMessage({ role: 'user', content: 'list files', timestamp: Date.now() })
  session.appendMessage(assistant([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls -la' } }]))
  session.appendMessage({
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'a b' }],
    isError: false,
    timestamp: Date.now(),
  } as never)
  session.appendCustomMessageEntry('reminder', 'r'.repeat(40), false)
  session.appendMessage(assistant([{ type: 'text', text: '\ntwo files\nand more' }]))
  const kept = session.appendMessage({ role: 'user', content: 'again', timestamp: Date.now() })
  session.appendCompaction('s'.repeat(20), kept, 9000)
  session.appendMessage(assistant([{ type: 'text', text: 'done' }]))
  return session
}

test("a request's makeup: pi's own sections are the system prompt, a project file is injected, tools are their definitions", () => {
  const [first] = branchContext(threadWithACompaction().getBranch()).requests
  expect(first?.estimated).toEqual({
    system: tokens(80),
    tools: tokens(JSON.stringify(TOOL).length),
    user: tokens('list files'.length),
    injected: tokens(80),
    assistant: 0,
    toolResults: 0,
  })
  expect(first?.actual).toEqual({ prompt: 153, output: 7, cacheRead: 50 })
  expect(first?.brief).toMatchObject({
    prompt: 'list files',
    added: [
      { category: 'system', label: 'system prompt' },
      { category: 'user', label: 'list files' },
    ],
    moreAdded: 0,
    reply: '',
    toolCalls: ['bash'],
  })
})

test('the brief names what entered since the previous request: a result by its call, a custom message by its type', () => {
  const [, second] = branchContext(threadWithACompaction().getBranch()).requests
  expect(second?.brief.added).toMatchObject([
    { category: 'toolResults', label: 'bash ls -la' },
    { category: 'injected', label: 'reminder' },
  ])
  expect(second?.brief.reply).toBe('two files')
  expect(second?.estimated.injected).toBe(tokens(80) + tokens(40))
  expect(second?.compaction).toBeUndefined()
})

// ⚠ pi's assembly, compaction included: after one, a request holds the prompt pi re-issues with
// the compaction, the summary and the kept entries — not what the summary replaced.
test("after a compaction a request holds the re-issued prompt, the summary and the kept entries, marked with pi's figure", () => {
  const branch = threadWithACompaction().getBranch()
  const { requests, next } = branchContext(branch)
  const third = requests[2]
  expect(third?.compaction).toEqual({ tokensBefore: 9000 })
  expect(third?.estimated).toEqual({
    system: tokens(80),
    tools: tokens(JSON.stringify(TOOL).length),
    user: tokens('again'.length),
    injected: tokens(80) + tokens(20),
    assistant: 0,
    toolResults: 0,
  })
  expect(next).toEqual({ ...third?.estimated, assistant: tokens('done'.length) } as typeof next)
  // The numbering is the stats' numbering: turn N here is turn N in the Stats view.
  expect(requests.map((request) => [request.turn, request.prompt])).toEqual(
    branchStats(branch).turnStats.map((turn) => [turn.turn, turn.prompt]),
  )
})

// An extension may prune a tool result from later requests (`context_edit`) — pi's projection
// applies it, so the makeup is what was sent, not what is stored.
test('a tool result an extension pruned no longer counts in the requests after the prune', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage(systemPrompt())
  session.appendMessage({ role: 'user', content: 'read it', timestamp: Date.now() })
  session.appendMessage(assistant([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'cat big' } }]))
  const result = session.appendMessage({
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'x'.repeat(400) }],
    isError: false,
    timestamp: Date.now(),
  } as never)
  session.appendMessage(assistant([{ type: 'text', text: 'read' }]))
  session.appendContextEdit(result, null)
  session.appendMessage({ role: 'user', content: 'go on', timestamp: Date.now() })
  session.appendMessage(assistant([{ type: 'text', text: 'ok' }]))
  const { requests } = branchContext(session.getBranch())
  expect(requests.map((request) => request.estimated.toolResults)).toEqual([0, tokens(400), 0])
})

// #361 phase 3: the browser's rows are the bars' makeup, split — the two are one computation.
test("a request's elements sum to its bar's makeup, each entered since the request before marked", () => {
  const branch = threadWithACompaction().getBranch()
  const { requests } = branchContext(branch)
  for (const request of requests) {
    const summed = { system: 0, tools: 0, user: 0, injected: 0, assistant: 0, toolResults: 0 }
    for (const element of branchRequestDetail(branch, request.turn)?.elements ?? [])
      summed[element.category] += element.tokens
    expect(summed).toEqual(request.estimated)
  }
  const first = branchRequestDetail(branch, 1)
  expect(first?.elements.map((element) => [element.category, element.label, element.entered])).toEqual([
    ['system', 'preamble', true],
    ['system', 'tools', true],
    ['injected', 'project_context', true],
    ['tools', 'bash', true],
    ['user', 'list files', true],
  ])
  const second = branchRequestDetail(branch, 2)
  const result = second?.elements.find((element) => element.category === 'toolResults')
  expect(result).toMatchObject({ label: 'bash ls -la', entered: true })
  expect(result?.body).toEqual({
    kind: 'toolResult',
    toolName: 'bash',
    arguments: { command: 'ls -la' },
    isError: false,
    text: 'a b',
    images: [],
  })
  expect(second?.elements.find((element) => element.label === 'list files')?.entered).toBe(false)
})

// `left` is against the request before — which held neither its own reply nor anything after it.
// A compaction re-issues the SAME folded prompt under its own entry: not entered, not left.
test('after a compaction, what the summary replaced is listed as left and the re-issued prompt is neither', () => {
  const branch = threadWithACompaction().getBranch()
  const third = branchRequestDetail(branch, 3)
  expect(third?.left.map((gone) => gone.label)).toEqual(['list files', 'calls bash', 'bash ls -la', 'reminder'])
  expect(
    third?.elements
      .filter((element) => ['system', 'tools'].includes(element.category) || element.label === 'project_context')
      .map((element) => [element.label, element.entered]),
  ).toEqual([
    ['preamble', false],
    ['tools', false],
    ['project_context', false],
    ['bash', false],
  ])
  expect(branchContext(branch).requests[2]?.brief.added.map((addition) => addition.label)).toEqual([
    'compaction summary',
    'again',
  ])
  expect(
    branchRequestDetail(branch, 'next')
      ?.elements.filter((element) => element.entered)
      .map((element) => element.label),
  ).toEqual(['done'])
  expect(branchRequestDetail(branch, 9)).toBeUndefined()
})

// A later system message is a DELTA pi folds into one head (pi-ai `getCurrentSystemMessage`):
// a section replaced by name, one deleted by `null`, a tool removed — counted as pi sends them.
test('a later system message patches the prompt: a section replaced counts once, a deleted one and a removed tool retire', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage(systemPrompt())
  session.appendMessage({ role: 'user', content: 'go', timestamp: Date.now() })
  session.appendMessage(assistant([{ type: 'text', text: 'ok' }]))
  session.appendMessage({
    role: 'system',
    content: '',
    sections: { project_context: 'b'.repeat(20), tools: null },
    toolsRemoved: [{ name: 'bash' }],
    timestamp: Date.now(),
  } as never)
  session.appendMessage({ role: 'user', content: 'again', timestamp: Date.now() })
  session.appendMessage(assistant([{ type: 'text', text: 'done' }]))
  const branch = session.getBranch()
  const { requests, events } = branchContext(branch)
  expect(requests[1]?.estimated).toMatchObject({ system: tokens(40), tools: 0, injected: tokens(20) })
  // The brief names what changed in the prompt, not the delta's entry.
  expect(requests[1]?.brief.added.map((addition) => addition.label)).toEqual(['system: project_context', 'again'])
  const second = branchRequestDetail(branch, 2)
  expect(
    second?.elements
      .filter((element) => element.key.startsWith('system:'))
      .map((element) => [element.label, element.entered]),
  ).toEqual([
    ['preamble', false],
    ['project_context', true],
  ])
  expect(second?.left.map((gone) => gone.label)).toEqual(['system: tools', 'tool bash'])
  // The delta shrank the prompt: its event says so, signed.
  const delta = events.find((event) => event.label.startsWith('system:'))
  expect(delta?.tokens).toBe(tokens(20) - tokens(80) - tokens(40) - tokens(JSON.stringify(TOOL).length))
})

// ⚠ pi projects a compaction by POSITION: the latest one sends its summary, an older one inside
// its kept range sends nothing (`buildSessionProjection`). Two `/compact`s close together are
// enough — and the trend, the browser and the event must all say what pi sent.
test('a second compaction that keeps the first: its summary alone counts, in the trend, the detail and the event', () => {
  const session = SessionManager.inMemory(tmpdir())
  session.appendMessage({ role: 'user', content: 'one', timestamp: Date.now() })
  session.appendMessage(assistant([{ type: 'text', text: 'a1' }]))
  const kept = session.appendMessage({ role: 'user', content: 'two', timestamp: Date.now() })
  session.appendCompaction('s'.repeat(400), kept, 9000)
  session.appendMessage(assistant([{ type: 'text', text: 'a2' }]))
  session.appendMessage({ role: 'user', content: 'three', timestamp: Date.now() })
  session.appendMessage(assistant([{ type: 'text', text: 'a3' }]))
  session.appendCompaction('t'.repeat(40), kept, 9000)
  session.appendMessage(assistant([{ type: 'text', text: 'a4' }]))
  const branch = session.getBranch()
  const { requests, next, events } = branchContext(branch)
  expect(requests.map((request) => request.estimated.injected)).toEqual([0, tokens(400), tokens(400), tokens(40)])
  expect(next.injected).toBe(tokens(40))
  const fourth = branchRequestDetail(branch, 4)
  expect(
    fourth?.elements.filter((element) => element.category === 'injected').map((element) => element.tokens),
  ).toEqual([tokens(40)])
  // The first summary is no longer sent: it left.
  expect(fourth?.left.map((gone) => gone.label)).toEqual(['compaction summary'])
  const compactions = events.filter((event) => event.kind === 'compact')
  expect(compactions[1]?.tokens).toBe(tokens(40) - tokens(400))
})

test("#443: a library prompt's estimate is the Context tab's for the same text — one function prices both", () => {
  const body = '# Reviewer\n\nRead the diff; say what breaks. ✓ ünïcode counts as characters, not bytes.'
  const parsed = parseLibraryPrompt(
    'reviewer',
    serializeLibraryPrompt({ name: 'R', description: '', category: 'system', body }),
  )
  if (parsed.kind !== 'prompt') throw new Error(parsed.reason)
  const message = { role: 'system', content: '', sections: { preamble: body }, timestamp: 0 } as never
  const [preamble] = foldSystem([{ message, at: '' }])
  expect(preamble?.item.key).toBe('system:section:preamble')
  expect(preamble?.item.tokens).toBe(parsed.prompt.tokens)
})
