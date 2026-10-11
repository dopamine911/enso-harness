import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFauxCore,
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { parseArenaAction } from '../actions.ts'
import {
  ARENA_IMAGE_STEP,
  arenaAgentDriver,
  arenaToolResult,
  arenaUiTool,
  DROPPED_IMAGE_TEXT,
  pacedAct,
  parseModelReference,
  resolveArenaModel,
  supersededReadText,
} from '../agent.ts'
import type { ArenaActOutcome } from '../perform.ts'
import { createRegionReads, readMarkOf } from '../read-regions.ts'
import { type ArenaDriverSession, awaitDriverEnd } from '../recorder.ts'
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
    {
      kind: 'agent-start',
      provider: core.provider,
      model: 'arena-test',
      thinking: 'off',
      tools: ['act'],
      actionGapMs: 0,
    },
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
  const shot = join(directory, 'shot.jpg')
  writeFileSync(shot, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
  const outcome: ArenaActOutcome = { ok: true, result: { url: 'http://x/', screenshot: shot } }

  expect(arenaToolResult(outcome, true).content).toEqual([
    { type: 'text', text: JSON.stringify(outcome, null, 2) },
    { type: 'image', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'), mimeType: 'image/jpeg' },
  ])
  expect(arenaToolResult(outcome, false).content).toHaveLength(1)
  expect(arenaToolResult({ ok: false, error: 'no such button' }, true)).toMatchObject({ isError: true })
  expect(arenaUiTool(fakeSession(), false, () => undefined).name).toBe('act')
})

// ⚠ #724, from Opus's snake run: every screenshot the agent took stayed in its conversation and went
// with every call — 68 of them, ~41 MB — until the API refused the request (413) at 43 minutes. And
// PR #725 review: dropped one at a time, the request changed near its end on every call, so the
// provider's cached prefix never held; dropped in steps, it holds for a step's worth of calls.
test('⚠ a model call carries at most twice the step of screenshots, the oldest dropped a whole step at a time and each said, not sent (#724)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-shots-'))
  const taking = 3 * ARENA_IMAGE_STEP + 1
  const shots = Array.from({ length: taking }, (_, index) => {
    const path = join(directory, `${index + 1}.png`)
    writeFileSync(path, `${index + 1}`)
    return path
  })
  // Each call's images, as their bytes, and how many were said instead of sent.
  const calls: Array<{ readonly sent: string[]; readonly said: number }> = []
  const recording =
    (next: FauxResponseStep): FauxResponseStep =>
    (context, options, state, model) => {
      const parts = context.messages.flatMap((message) =>
        message.role === 'toolResult' && Array.isArray(message.content) ? message.content : [],
      )
      calls.push({
        sent: parts.flatMap((part) =>
          part.type === 'image' ? [Buffer.from(part.data, 'base64').toString('utf8')] : [],
        ),
        said: parts.filter((part) => part.type === 'text' && part.text === DROPPED_IMAGE_TEXT).length,
      })
      return typeof next === 'function' ? next(context, options, state, model) : next
    }
  const core = scripted(
    [
      ...shots.map(() => recording(toolUse('act', { action: 'screenshot' }))),
      recording(toolUse('act', { action: 'stop', reason: 'done' })),
    ],
    ['text', 'image'],
  )
  let taken = 0
  const session = fakeSession((request) => {
    const isShot =
      typeof request === 'object' && request !== null && 'action' in request && request.action === 'screenshot'
    return isShot ? { ok: true, result: { screenshot: shots[taken++] } } : { ok: true, result: {} }
  })
  const agentRun = arenaAgentDriver({
    model: core.getModel(),
    streamFn: core.streamSimple,
    thinking: 'off',
    brief: 'b',
    secretValues: [],
  })
  expect(await agentRun(session)).toBe('it stopped the run')

  // Shots `from`..`to` sent, and each one before `from` said instead.
  const span = (from: number, to: number): { sent: string[]; said: number } => ({
    sent: Array.from({ length: to - from + 1 }, (_, index) => String(from + index)),
    said: from - 1,
  })
  const step = ARENA_IMAGE_STEP
  expect(calls).toEqual([
    // None, then each one, up to twice the step: all of them go.
    ...Array.from({ length: 2 * step + 1 }, (_, count) => span(1, count)),
    // Past it, the oldest step goes, and the same ones stay gone until the next whole step.
    ...Array.from({ length: step - 1 }, (_, index) => span(step + 1, 2 * step + 1 + index)),
    span(2 * step + 1, 3 * step),
    span(2 * step + 1, 3 * step + 1),
  ])
})

/** Enso's page as a read sees it (#740): the rail, and the thread view saying `said`. */
const ensoPage = (said: string): string =>
  [
    '- navigation "threads":',
    '  - button "New Thread"',
    '- tabpanel "Chat":',
    '  - log:',
    ...Array.from({ length: 8 }, (_, turn) => `    - paragraph: earlier reply ${turn + 1} about the game`),
    `    - paragraph: ${said}`,
    '- textbox "ask pi something"',
  ].join('\n')

// ⚠ #740: every read stayed in the conversation — Opus's 16 were 313 KB, most of what each call
// re-sent. A newer whole read of a region replaces the older ones; but a diff is useless without
// the read it is against, so a region's reads since its last whole one all stay.
test('⚠ a model call carries a region’s reads from its newest whole one on: older ones are said, another region’s stay, and a diff’s base is always there (#740)', async () => {
  const steps: { readonly request: Parameters<typeof fauxToolCall>[1]; readonly page: string }[] = [
    { request: { action: 'read' }, page: ensoPage('working') },
    { request: { action: 'read' }, page: ensoPage('done') },
    { request: { action: 'read', region: 'threads' }, page: ensoPage('done') },
    { request: { action: 'read', full: true }, page: ensoPage('done') },
    { request: { action: 'read' }, page: ensoPage('done') },
  ]
  // Each call's read results: `read N` when sent, the line it was replaced by when not.
  const calls: string[][] = []
  // Each call's diffs whose base was not sent with them.
  const baseless: number[][] = []
  const recording =
    (next: FauxResponseStep): FauxResponseStep =>
    (context, options, state, model) => {
      const texts = context.messages.flatMap((message) =>
        message.role === 'toolResult' && message.content[0]?.type === 'text' ? [message.content[0].text] : [],
      )
      const marks = texts.map((text) =>
        text.startsWith('[') ? undefined : readMarkOf((JSON.parse(text) as ArenaActOutcome).result),
      )
      const sent = new Set(marks.flatMap((mark) => (mark === undefined ? [] : [mark.read])))
      calls.push(texts.map((text, index) => (marks[index] === undefined ? text : `read ${marks[index]?.read}`)))
      baseless.push(marks.flatMap((mark) => (mark?.against === undefined || sent.has(mark.against) ? [] : [mark.read])))
      return typeof next === 'function' ? next(context, options, state, model) : next
    }
  const core = scripted([
    ...steps.map(({ request }) => recording(toolUse('act', request))),
    recording(toolUse('act', { action: 'stop', reason: 'done' })),
  ])
  // The recorder's reads over each step's page, asked what the agent's call asked.
  const reads = createRegionReads()
  let taken = 0
  const session = fakeSession((request) => {
    const step = steps[taken++]
    const parsed = parseArenaAction(request)
    if (step === undefined || !parsed.ok || parsed.action.action !== 'read') return { ok: true, result: {} }
    return { ok: true, result: reads.read(step.page, parsed.action, 0) }
  })
  const agentRun = arenaAgentDriver({
    model: core.getModel(),
    streamFn: core.streamSimple,
    thinking: 'off',
    brief: 'b',
    secretValues: [],
  })
  expect(await agentRun(session)).toBe('it stopped the run')

  const replaced = (read: number): string => supersededReadText({ read, region: 'transcript' }, 4)
  expect(calls).toEqual([
    [],
    ['read 1'],
    // Read 2 is a diff against read 1: both go.
    ['read 1', 'read 2'],
    ['read 1', 'read 2', 'read 3'],
    // Read 4 has the thread view whole: the chain before it is said, the rail's read stays.
    [replaced(1), replaced(2), 'read 3', 'read 4'],
    [replaced(1), replaced(2), 'read 3', 'read 4', 'read 5'],
  ])
  expect(baseless).toEqual(calls.map(() => []))
})

// ⚠ #680: a visual agent knows the page only by the view each answer carries. A failed action is
// the moment it most needs to see what happened, so the view comes with an error too.
test('⚠ a visual answer carries its view as the picture — before a screenshot it also names, and on a failure too', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-view-'))
  const view = join(directory, 'view.jpg')
  const requested = join(directory, 'requested.jpg')
  writeFileSync(view, 'the view')
  writeFileSync(requested, 'the full shot')
  const pictureOf = (outcome: ArenaActOutcome): unknown =>
    arenaToolResult(outcome, true).content.find((part) => part.type === 'image')
  expect(pictureOf({ ok: true, result: { screenshot: requested }, view })).toEqual({
    type: 'image',
    data: Buffer.from('the view').toString('base64'),
    mimeType: 'image/jpeg',
  })
  expect(pictureOf({ ok: false, error: 'click: Timeout 15000ms exceeded.', view })).toMatchObject({
    data: Buffer.from('the view').toString('base64'),
  })
  expect(arenaToolResult({ ok: true, result: {}, view }, false).content).toHaveLength(1)
})

test('a model reference is provider/model-id, split at the first slash', () => {
  expect(parseModelReference('anthropic/claude-test')).toEqual({ provider: 'anthropic', id: 'claude-test' })
  expect(parseModelReference('openrouter/vendor/model')).toEqual({ provider: 'openrouter', id: 'vendor/model' })
  expect(parseModelReference('anthropic')).toBeUndefined()
  expect(parseModelReference('/m')).toBeUndefined()
  expect(parseModelReference('anthropic/')).toBeUndefined()
})

/** A home whose agent dir lists one provider of its own, `arena-test`, with a model that sees and one that only reads. */
function homeWithProvider(): { readonly home: string; readonly agentDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'arena-models-'))
  const agentDir = join(home, 'pi-agent')
  mkdirSync(agentDir)
  const models = [{ id: 'seer', input: ['text', 'image'] }, { id: 'reader' }]
  const provider = { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', models }
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'arena-test': provider } }))
  return { home, agentDir }
}

test('the agent’s model resolves from the home’s agent dir only when it is known and its provider has a login', async () => {
  const { home, agentDir } = homeWithProvider()
  await expect(resolveArenaModel(home, 'arena-test')).rejects.toThrow(
    '--agent takes provider/model-id, not "arena-test"',
  )
  // An unknown model names the provider's models; an unknown provider has none to name.
  await expect(resolveArenaModel(home, 'arena-test/oracle')).rejects.toThrow(
    'no model "oracle" for provider "arena-test" — known: seer, reader',
  )
  await expect(resolveArenaModel(home, 'nobody/oracle')).rejects.toThrow(/^no model "oracle" for provider "nobody"$/)
  await expect(resolveArenaModel(home, 'arena-test/seer')).rejects.toThrow(
    `provider "arena-test" has no login in ${agentDir} — log in through Enso first`,
  )

  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ 'arena-test': { type: 'api_key', key: 'test-key' } }))
  const { model } = await resolveArenaModel(home, 'arena-test/seer')
  expect(model).toMatchObject({ provider: 'arena-test', id: 'seer', input: ['text', 'image'] })
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

test('⚠ a paced runner’s actions in one turn reach the page at least the gap apart, and its start says the gap (#848)', async () => {
  const core = scripted([
    fauxAssistantMessage(
      [
        fauxToolCall('act', { action: 'press', key: 'ArrowRight' }),
        fauxToolCall('act', { action: 'press', key: 'p' }),
        fauxToolCall('act', { action: 'stop', reason: 'done' }),
      ],
      { stopReason: 'toolUse' },
    ),
  ])
  const spans: { started: number; ended: number }[] = []
  const session = fakeSession()
  const unpaced = session.act
  const timed = {
    ...session,
    act: async (request: unknown): Promise<ArenaActOutcome> => {
      const started = performance.now()
      const outcome = await unpaced(request)
      spans.push({ started, ended: performance.now() })
      return outcome
    },
  }
  await arenaAgentDriver({
    model: core.getModel(),
    streamFn: core.streamSimple,
    thinking: 'off',
    brief: 'the brief',
    secretValues: [],
    actionGapMs: 60,
  })(timed)

  expect(session.sent).toEqual([
    { action: 'press', key: 'ArrowRight' },
    { action: 'press', key: 'p' },
    { action: 'stop', reason: 'done' },
  ])
  const gaps = spans.slice(1).map((span, index) => span.started - (spans[index]?.ended ?? 0))
  // Bun's timer may fire a fraction of a millisecond early against performance.now().
  expect(gaps.every((gap) => gap >= 59)).toBe(true)
  expect(session.recorded[0]).toMatchObject({ kind: 'agent-start', actionGapMs: 60 })
})

test('pacing waits only the rest of the gap, counted from the end of the last action, a failed one too (#848)', async () => {
  let now = 0
  const slept: number[] = []
  const clock = {
    now: (): number => now,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms)
      now += ms
      return Promise.resolve()
    },
  }
  const durations = [40, 10, 0, 0]
  const act = pacedAct(
    (request) => {
      now += durations.shift() ?? 0
      return request === 'fails'
        ? Promise.reject(new Error('no such control'))
        : Promise.resolve({ ok: true, result: {} })
    },
    250,
    clock,
  )
  await act('first')
  expect(slept).toEqual([])
  now += 100 // the model's own time between two calls of one turn
  await act('second')
  expect(slept).toEqual([150])
  now += 400 // a new turn: the model took longer than the gap
  await expect(act('fails')).rejects.toThrow('no such control')
  expect(slept).toEqual([150])
  await act('after the failure')
  expect(slept).toEqual([150, 250])

  const unpaced = (): Promise<ArenaActOutcome> => Promise.resolve({ ok: true, result: {} })
  expect(pacedAct(unpaced, 0, clock)).toBe(unpaced)
})
