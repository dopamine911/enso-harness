import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FeatureModelScript, featureModelHandler, scriptedToolCallId } from '../docs/feature-model.ts'

/**
 * The scripted model the Features screenshots run against (#437), driven over `Request`s: which
 * thread's queue a request takes from, what an auxiliary call and a request past the script get,
 * the Anthropic stream a reply is framed as, and the cache usage derived from the requests.
 */

const MAIN: FeatureModelScript = {
  name: 'main',
  replies: [
    [
      { kind: 'thinking', thinking: 'look first' },
      { kind: 'text', text: 'Reading it.' },
      { kind: 'tool', tool: 'read', input: { path: 'README.md' } },
    ],
    [{ kind: 'text', text: 'Done.' }],
  ],
  summary: 'the main summary',
}

const INCIDENTS: FeatureModelScript = {
  name: 'incidents',
  opening: 'INCIDENT DRILL',
  replies: [[{ kind: 'text', text: 'Incident reply.' }]],
  summary: 'the incidents summary',
}

const TOOLS = [{ name: 'read', input_schema: { type: 'object' } }]

let scratch = ''
let log = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'feature-model-test-'))
  log = join(scratch, 'model.log')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

interface MessagesBody {
  readonly model?: string
  readonly tools?: readonly unknown[]
  readonly messages: readonly unknown[]
}

function messages(body: MessagesBody, path = '/v1/messages'): Request {
  return new Request(`http://127.0.0.1:5199${path}`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-test', system: 'you are scripted', ...body }),
  })
}

const user = (text: string): unknown => ({ role: 'user', content: text })
const assistant = (text: string): unknown => ({ role: 'assistant', content: text })

/** The usage `message_start` reports: what the provider charges the prompt as. */
interface PromptUsage {
  readonly input_tokens: number
  readonly cache_creation_input_tokens: number
  readonly cache_read_input_tokens: number
}

interface StreamEvent {
  readonly type: string
  readonly index?: number
  readonly message?: { readonly id: string; readonly model: string; readonly usage: PromptUsage }
  readonly content_block?: {
    readonly type: string
    readonly id?: string
    readonly name?: string
    readonly input?: unknown
  }
  readonly delta?: Record<string, unknown>
  readonly usage?: { readonly output_tokens: number }
}

/** The stream's events, in order, each the `data:` of one server-sent event. */
async function streamEvents(response: Response): Promise<StreamEvent[]> {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n')
      const parsed = JSON.parse(dataLine?.slice('data: '.length) ?? '') as StreamEvent
      expect(eventLine).toBe(`event: ${parsed.type}`)
      return parsed
    })
}

/** The text of every `text_delta` in a stream, joined. */
function streamedText(events: readonly StreamEvent[]): string {
  return events.flatMap((event) => (event.delta?.type === 'text_delta' ? [String(event.delta.text)] : [])).join('')
}

/** The prompt usage of the reply `answer` streams for `body`. */
async function usageOf(answer: (request: Request) => Promise<Response>, body: MessagesBody): Promise<PromptUsage> {
  const usage = (await streamEvents(await answer(messages(body))))[0]?.message?.usage
  if (usage === undefined) throw new Error('the stream did not open with message_start')
  return usage
}

test('the model refuses scripts none of which answers the threads no opening names', () => {
  expect(() => featureModelHandler([INCIDENTS], log)).toThrow(/one script must answer the threads no opening names/)
})

test('anything but a POST to …/messages is a 404, and the log names it', async () => {
  const answer = featureModelHandler([MAIN], log)
  const get = await answer(new Request('http://127.0.0.1:5199/v1/models'))
  expect(get.status).toBe(404)
  const wrongPath = await answer(messages({ tools: TOOLS, messages: [user('hi')] }, '/v1/complete'))
  expect(wrongPath.status).toBe(404)
  expect(readFileSync(log, 'utf8')).toBe('unhandled GET /v1/models\nunhandled POST /v1/complete\n')
})

test("a request takes its thread's next reply: by the opening in its FIRST user message, else the fallback's", async () => {
  const answer = featureModelHandler([MAIN, INCIDENTS], log)
  const first = await streamEvents(await answer(messages({ tools: TOOLS, messages: [user('INCIDENT DRILL: go')] })))
  expect(streamedText(first)).toBe('Incident reply.')

  // The opening in a LATER message does not move a thread: its first prompt is what names it.
  const main = await streamEvents(
    await answer(messages({ tools: TOOLS, messages: [user('start'), assistant('ok'), user('INCIDENT DRILL')] })),
  )
  expect(streamedText(main)).toBe('Reading it.')

  // Each script is its own queue: the incidents reply did not advance main's.
  const mainAgain = await streamEvents(await answer(messages({ tools: TOOLS, messages: [user('start')] })))
  expect(streamedText(mainAgain)).toBe('Done.')
  expect(readFileSync(log, 'utf8')).toBe(
    'reply 0 · incidents · claude-test\nreply 0 · main · claude-test\nreply 1 · main · claude-test\n',
  )
})

test("a request with no tools is an auxiliary call: it gets the script's summary and leaves the queue where it was", async () => {
  const answer = featureModelHandler([MAIN], log)
  const summary = await streamEvents(await answer(messages({ messages: [user('summarize')] })))
  expect(streamedText(summary)).toBe('the main summary')
  expect(summary.at(-2)?.delta?.stop_reason).toBe('end_turn')

  const reply = await streamEvents(await answer(messages({ tools: [], messages: [user('start')] })))
  expect(streamedText(reply)).toBe('the main summary')
  const real = await streamEvents(await answer(messages({ tools: TOOLS, messages: [user('start')] })))
  expect(streamedText(real)).toBe('Reading it.')
  expect(readFileSync(log, 'utf8')).toBe(
    'auxiliary · main · claude-test\nauxiliary · main · claude-test\nreply 0 · main · claude-test\n',
  )
})

test('a request past the end of its script is a 400 naming the missing reply, never a silent extra turn', async () => {
  const answer = featureModelHandler([MAIN, INCIDENTS], log)
  const opening = { tools: TOOLS, messages: [user('INCIDENT DRILL')] }
  await answer(messages(opening))
  const past = await answer(messages(opening))
  expect(past.status).toBe(400)
  expect(await past.json()).toEqual({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'feature model: no reply 1 scripted for incidents' },
  })
  // Still refused the next time: a refusal does not advance the queue past the gap.
  const again = await answer(messages({ tools: TOOLS, messages: [user('INCIDENT DRILL')] }))
  expect(again.status).toBe(400)
  expect(readFileSync(log, 'utf8')).toBe(
    'reply 0 · incidents · claude-test\nreply 1 · incidents · claude-test\nreply 1 · incidents · claude-test\n',
  )
})

test('a reply streams as Anthropic frames it: one block per part, the tool call under its scripted id, then the stop', async () => {
  const answer = featureModelHandler([MAIN], log)
  const events = await streamEvents(await answer(messages({ tools: TOOLS, messages: [user('start')] })))
  const block = (type: string, index: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    type,
    index,
    ...fields,
  })
  expect(events).toMatchObject([
    { type: 'message_start', message: { id: 'msg_main_0', model: 'claude-test', role: 'assistant' } },
    block('content_block_start', 0, { content_block: { type: 'thinking' } }),
    block('content_block_delta', 0, { delta: { type: 'thinking_delta', thinking: 'look first' } }),
    block('content_block_delta', 0, { delta: { type: 'signature_delta' } }),
    block('content_block_stop', 0),
    block('content_block_start', 1, { content_block: { type: 'text' } }),
    block('content_block_delta', 1, { delta: { type: 'text_delta', text: 'Reading it.' } }),
    block('content_block_stop', 1),
    block('content_block_start', 2, {
      content_block: { type: 'tool_use', id: scriptedToolCallId('main', 0, 2), name: 'read', input: {} },
    }),
    block('content_block_delta', 2, { delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } }),
    block('content_block_stop', 2),
    // A reply that calls a tool stops for it.
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: expect.any(Number) } },
    { type: 'message_stop' },
  ])

  // One that only speaks ends the turn.
  const textOnly = await streamEvents(await answer(messages({ tools: TOOLS, messages: [user('start')] })))
  expect(textOnly.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
})

test('the cache read is the prefix a request shares with an earlier one TO THE SAME MODEL; a summary call evicts nothing', async () => {
  const script: FeatureModelScript = {
    ...MAIN,
    replies: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }], [{ kind: 'text', text: 'three' }]],
  }
  const opening = { tools: TOOLS, messages: [user('start')] }
  const turn = { tools: TOOLS, messages: [user('start'), assistant('one'), user('and then')] }

  const withSummary = featureModelHandler([script], log)
  const cold = await usageOf(withSummary, opening)
  expect(cold.cache_read_input_tokens).toBe(0)
  expect(cold.input_tokens).toBe(6)
  expect(cold.cache_creation_input_tokens).toBeGreaterThan(0)
  // The compaction's summary call to the same model, a different prompt, between the turns…
  await withSummary(messages({ messages: [user('summarize everything so far')] }))
  const warm = await usageOf(withSummary, turn)
  expect(warm.cache_read_input_tokens).toBeGreaterThan(0)

  // …reads exactly as if it had not been made: the conversation's entry is still there.
  const withoutSummary = featureModelHandler([script], log)
  await usageOf(withoutSummary, opening)
  expect(await usageOf(withoutSummary, turn)).toEqual(warm)

  // A model switch starts cold, however much the prompt shares with the other model's.
  const switched = await usageOf(withSummary, { ...turn, model: 'claude-other' })
  expect(switched.cache_read_input_tokens).toBe(0)
})
