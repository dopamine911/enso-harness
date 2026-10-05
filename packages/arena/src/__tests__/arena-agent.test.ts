import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFauxCore,
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { arenaAgentDriver, arenaToolResult, arenaUiTool, parseModelReference } from '../agent.ts'
import { type ArenaActOutcome, type ArenaDriverSession, awaitDriverEnd } from '../recorder.ts'
import type { ArenaEventBody } from '../timeline.ts'

/**
 * Dogfood Arena's agent runner (#556, #584): the agent under test has one tool, and that tool is
 * the recorder's page. A scripted model (pi-ai's faux provider) asks for what a coding agent
 * would — a shell, a file write — and for the UI; only the UI call reaches the recorder.
 */

const SECRET = 'sk-ant-arena-test-0123456789abcdef'

interface FakeSession extends ArenaDriverSession {
  readonly sent: unknown[]
  readonly recorded: ArenaEventBody[]
  stop(reason: string): void
}

function fakeSession(answer: (request: unknown) => ArenaActOutcome = () => ({ ok: true, result: {} })): FakeSession {
  const sent: unknown[] = []
  const recorded: ArenaEventBody[] = []
  let stop: (reason: string) => void = () => undefined
  const stopped = new Promise<string>((resolve) => {
    stop = resolve
  })
  return {
    sent,
    recorded,
    stopped,
    stop: (reason) => stop(reason),
    runDirectory: mkdtempSync(join(tmpdir(), 'arena-agent-')),
    record: (body) => {
      recorded.push(body)
    },
    act: async (request) => {
      sent.push(request)
      const outcome = answer(request)
      if (typeof request === 'object' && request !== null && 'action' in request && request.action === 'stop') {
        stop('the agent stopped the run')
      }
      return outcome
    },
  }
}

function scripted(
  steps: FauxResponseStep[],
  input: ('text' | 'image')[] = ['text'],
): ReturnType<typeof createFauxCore> {
  const core = createFauxCore({ models: [{ id: 'arena-test', input }] })
  core.setResponses(steps)
  return core
}

const toolUse = (name: string, parameters: Parameters<typeof fauxToolCall>[1]): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall(name, parameters)], { stopReason: 'toolUse' })

test('the agent has one tool: a shell or a file write is refused and runs nothing; the UI call reaches the page', async () => {
  const core = scripted([
    toolUse('bash', { command: 'curl http://127.0.0.1:5179/api/threads' }),
    toolUse('write', { path: 'snake.js', content: 'game()' }),
    toolUse('act', { action: 'read' }),
    toolUse('act', { action: 'note', note: 'friction', trying: 'find the prompt box', happened: `pasted ${SECRET}` }),
    toolUse('act', { action: 'stop', reason: 'done' }),
    fauxAssistantMessage([fauxText('unreachable: the stop ends the turn')]),
  ])
  const session = fakeSession()
  const reason = await arenaAgentDriver({
    model: core.getModel(),
    streamFn: core.streamSimple,
    thinking: 'off',
    brief: 'the brief',
    secretValues: [SECRET],
  })(session)

  expect(reason).toBe('it stopped the run')
  // Only the UI calls reached the recorder; the shell and the write never ran anywhere.
  expect(session.sent).toEqual([
    { action: 'read' },
    { action: 'note', note: 'friction', trying: 'find the prompt box', happened: `pasted ${SECRET}` },
    { action: 'stop', reason: 'done' },
  ])
  expect(session.recorded).toEqual([
    { kind: 'agent-start', provider: core.provider, model: 'arena-test', thinking: 'off', tools: ['act'] },
    { kind: 'agent-tool-refused', tool: 'bash' },
    { kind: 'agent-tool-refused', tool: 'write' },
  ])
  // The model's own transcript is kept beside the run, redacted.
  const transcript = readFileSync(join(session.runDirectory, 'agent', 'transcript.jsonl'), 'utf8')
  expect(transcript).toContain('Tool bash not found')
  expect(transcript).toContain('find the prompt box')
  expect(transcript).not.toContain(SECRET)
  expect(core.getPendingResponseCount()).toBe(1)
})

test('a turn that ends without stopping is nudged, and a runner that never stops gives up and says so', async () => {
  const core = scripted([
    fauxAssistantMessage([fauxText('I think I am done.')]),
    toolUse('act', { action: 'read' }),
    fauxAssistantMessage([fauxText('Still done.')]),
    fauxAssistantMessage([fauxText('Done.')]),
  ])
  const session = fakeSession()
  const reason = await arenaAgentDriver({
    model: core.getModel(),
    streamFn: core.streamSimple,
    thinking: 'off',
    brief: 'the brief',
    secretValues: [],
    maxNudges: 2,
  })(session)
  expect(reason).toBe('it ended its turn 3 times without stopping the run')
  expect(session.sent).toEqual([{ action: 'read' }])
})

test('when the run stops — the budget, a signal — the runner ends with it', async () => {
  const session = fakeSession()
  const core = scripted([
    toolUse('act', { action: 'read' }),
    (): ReturnType<typeof fauxAssistantMessage> => {
      session.stop('budget: 1 minutes')
      return fauxAssistantMessage([fauxText('working…')])
    },
  ])
  const reason = await arenaAgentDriver({
    model: core.getModel(),
    streamFn: core.streamSimple,
    thinking: 'off',
    brief: 'the brief',
    secretValues: [],
  })(session)
  expect(reason).toBe('the run stopped (budget: 1 minutes)')
})

test('a screenshot reaches a model that takes images as the picture, and an error is an error result', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-shot-'))
  const shot = join(directory, 'shot.png')
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const outcome: ArenaActOutcome = { ok: true, result: { url: 'http://x/', screenshot: shot } }

  expect(arenaToolResult(outcome, true).content).toEqual([
    { type: 'text', text: JSON.stringify(outcome, null, 2) },
    { type: 'image', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' },
  ])
  expect(arenaToolResult(outcome, false).content).toHaveLength(1)
  expect(arenaToolResult({ ok: false, error: 'no such button' }, true)).toMatchObject({ isError: true })
  expect(arenaUiTool(fakeSession(), false, () => undefined).name).toBe('act')
})

test('a model reference is provider/model-id, split at the first slash', () => {
  expect(parseModelReference('anthropic/claude-test')).toEqual({ provider: 'anthropic', id: 'claude-test' })
  expect(parseModelReference('openrouter/vendor/model')).toEqual({ provider: 'openrouter', id: 'vendor/model' })
  expect(parseModelReference('anthropic')).toBeUndefined()
  expect(parseModelReference('/m')).toBeUndefined()
  expect(parseModelReference('anthropic/')).toBeUndefined()
})

test('a runner still going after the stop is recorded as such; one that ends in time is not', async () => {
  const recorded: ArenaEventBody[] = []
  const timeline = { record: (body: ArenaEventBody) => recorded.push(body) }
  await awaitDriverEnd(new Promise<void>(() => undefined), timeline, 20)
  expect(recorded).toEqual([
    { kind: 'agent-end', reason: 'still running 0.02 s after the run stopped: its end is unknown' },
  ])
  recorded.length = 0
  await awaitDriverEnd(Promise.resolve(), timeline, 1000)
  expect(recorded).toEqual([])
})
