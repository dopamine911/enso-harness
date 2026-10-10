import { expect, test } from 'bun:test'
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ACTIVE_AGENT_CUSTOM_TYPE, ENSO_AUTO_AUTHORIZER, modeAgentName } from '@enso/core'
import type {
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionCheckResult,
  PermissionQuery,
  PromptPermissionDetails,
} from '@gotgenes/pi-permission-system'
import {
  askClassifier,
  type ClassifierRequest,
  createPermissionModes,
  type PermissionModesDependencies,
} from '../index.ts'

/**
 * #496's permission-modes extension through its factory: pi reduced to what the extension
 * registers with and writes through, the engine's service map and the classifier model faked.
 */

type Authorize = (
  details: PromptPermissionDetails,
  query: PermissionQuery,
  log: AuthorizerLog,
) => Promise<AuthorizerVerdict>
type CommandHandler = (argument: string, ctx: unknown) => Promise<void>
type Handler = (event: unknown, ctx: unknown) => void

const SESSION_ID = 'session-a'
const AUTO_AGENT = modeAgentName('auto')

interface Harness {
  readonly entries: { customType: string; data: unknown }[]
  readonly notices: { message: string; level: string | undefined }[]
  readonly selectCalls: { title: string; options: string[] }[]
  readonly registrations: { sessionId: string; name: string; disposed: boolean }[]
  readonly reviews: { event: string; details: Record<string, unknown> | undefined }[]
  readonly classifierRequests: ClassifierRequest[]
  command: (name: string, argument?: string) => Promise<void>
  startSession: () => void
  shutdown: () => void
  beforeAgentStart: (event: unknown) => void
  emit: (channel: string, data: unknown) => void
  /** The link registered for `sessionId`, answering one ask. */
  ask: (details: PromptPermissionDetails, query?: PermissionQuery) => Promise<AuthorizerVerdict>
}

interface HarnessOptions {
  readonly reply?: (request: ClassifierRequest) => Promise<string>
  readonly underDeadline?: PermissionModesDependencies['underDeadline']
  readonly model?: unknown
  readonly auth?: unknown
  readonly picked?: string | undefined
  readonly branch?: unknown[]
}

const immediate: PermissionModesDependencies['underDeadline'] = (run) => run(new AbortController().signal)

function harness(options: HarnessOptions = {}): Harness {
  const entries: Harness['entries'] = []
  const notices: Harness['notices'] = []
  const selectCalls: Harness['selectCalls'] = []
  const registrations: Harness['registrations'] = []
  const reviews: Harness['reviews'] = []
  const classifierRequests: ClassifierRequest[] = []
  const commands = new Map<string, CommandHandler>()
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, ((data: unknown) => void)[]>()
  const links = new Map<string, Authorize>()

  const pi = {
    registerCommand: (name: string, command: { handler: CommandHandler }): void => {
      commands.set(name, command.handler)
    },
    on: (event: string, handler: Handler): void => {
      handlers.set(event, handler)
    },
    events: {
      on: (channel: string, listener: (data: unknown) => void): (() => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
        return () => undefined
      },
      emit: (): void => undefined,
    },
    appendEntry: (customType: string, data: unknown): void => {
      entries.push({ customType, data })
    },
  } as unknown as ExtensionAPI

  createPermissionModes({
    permissionsService: (sessionId) => ({
      registerAuthorizer: (name: string, authorize: Authorize): (() => void) => {
        const key = `${sessionId}/${name}`
        if (links.has(key)) throw new Error(`duplicate authorizer ${key}`)
        links.set(key, authorize)
        const registration = { sessionId, name, disposed: false }
        registrations.push(registration)
        return () => {
          registration.disposed = true
          links.delete(key)
        }
      },
    }),
    askClassifier: (request) => {
      classifierRequests.push(request)
      return options.reply === undefined
        ? Promise.resolve('{"decision":"allow","reason":"fits"}')
        : options.reply(request)
    },
    underDeadline: options.underDeadline ?? immediate,
  })(pi)

  const ui = {
    select: (title: string, selectOptions: string[]): Promise<string | undefined> => {
      selectCalls.push({ title, options: selectOptions })
      return Promise.resolve(options.picked)
    },
    notify: (message: string, level?: string): void => {
      notices.push({ message, level })
    },
  }
  const model =
    'model' in options
      ? options.model
      : { id: 'judge-1', provider: 'acme', api: 'acme-messages', baseUrl: 'https://acme.test' }
  const sessionContext = {
    hasUI: true,
    ui,
    cwd: '/work/project',
    model,
    modelRegistry: {
      getApiKeyAndHeaders: () => Promise.resolve(options.auth ?? { ok: true, apiKey: 'sk-test' }),
    },
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getBranch: () =>
        options.branch ?? [
          { type: 'message', message: { role: 'user', content: 'fix the failing test in src/parse.ts' } },
          { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } },
        ],
    },
  }

  const reviewLog: AuthorizerLog = {
    review: (event, details) => reviews.push({ event, details }),
    debug: () => undefined,
  }

  return {
    entries,
    notices,
    selectCalls,
    registrations,
    reviews,
    classifierRequests,
    command: async (name, argument = '') => {
      const handler = commands.get(name)
      if (handler === undefined) throw new Error(`no /${name} command`)
      await handler(argument, sessionContext)
    },
    startSession: () => handlers.get('session_start')?.({ type: 'session_start' }, sessionContext),
    shutdown: () => handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, sessionContext),
    beforeAgentStart: (event) => handlers.get('before_agent_start')?.(event, sessionContext),
    emit: (channel, data) => {
      for (const listener of listeners.get(channel) ?? []) listener(data)
    },
    ask: (details, query = queryAnswering({ state: 'ask' })) => {
      const link = links.get(`${SESSION_ID}/${ENSO_AUTO_AUTHORIZER}`)
      if (link === undefined) throw new Error('no enso-auto link registered for the session')
      return link(details, query, reviewLog)
    },
  }
}

function queryAnswering(result: Partial<PermissionCheckResult>): PermissionQuery {
  return {
    checkPermission: (surface) => ({ toolName: surface, state: 'ask', source: 'bash', origin: 'global', ...result }),
    getToolPermission: () => 'ask',
  }
}

function bashAsk(
  command: string,
  matchedPattern: string | null = null,
  agentName = AUTO_AGENT,
): PromptPermissionDetails {
  return {
    requestId: 'request-1',
    source: 'tool_call',
    agentName,
    toolName: 'bash',
    command,
    payload: {
      kind: 'tool',
      request: {
        requester: { agentName, forwarded: false, sessionId: null },
        surface: 'bash',
        toolName: 'bash',
        invokedToolName: null,
        value: command,
        matchedPattern,
        commandContext: null,
        executedUnit: null,
      },
    },
  } as unknown as PromptPermissionDetails
}

/** A started session whose link is registered, as after the engine's ready broadcast. */
function autoSession(options: HarnessOptions = {}): Harness {
  const session = harness(options)
  session.startSession()
  return session
}

// --- mode commands

test('each mode command appends the active_agent entry naming its mode agent, default included', async () => {
  const session = harness()
  for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const)
    await session.command(mode)
  expect(session.entries).toEqual([
    { customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { name: 'enso-mode-default' } },
    { customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { name: 'enso-mode-acceptEdits' } },
    { customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { name: 'enso-mode-plan' } },
    { customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { name: 'enso-mode-bypassPermissions' } },
    { customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { name: 'enso-mode-auto' } },
  ])
})

test('/mode with no argument offers the human titles and sets the picked mode', async () => {
  const session = harness({ picked: 'Accept edits' })
  await session.command('mode')
  expect(session.selectCalls).toEqual([
    { title: 'Select permission mode:', options: ['Default', 'Accept edits', 'Plan', 'Bypass permissions', 'Auto'] },
  ])
  expect(session.entries).toEqual([{ customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { name: 'enso-mode-acceptEdits' } }])
})

test('/mode with the menu dismissed changes nothing', async () => {
  const session = harness({ picked: undefined })
  await session.command('mode')
  expect(session.entries).toEqual([])
})

test('/mode takes a mode name in any case', async () => {
  const session = harness()
  await session.command('mode', ' BYPASSPERMISSIONS ')
  expect(session.entries).toEqual([
    { customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { name: 'enso-mode-bypassPermissions' } },
  ])
})

test('/mode with an unknown mode notifies an error and appends nothing', async () => {
  const session = harness()
  await session.command('mode', 'yolo')
  expect(session.entries).toEqual([])
  expect(session.notices).toHaveLength(1)
  expect(session.notices[0]?.level).toBe('error')
  expect(session.notices[0]?.message).toContain('yolo')
})

// --- registration

test('the link registers once for its own session, whether ready comes before or after session_start', () => {
  const session = harness()
  session.emit('permissions:ready', { sessionId: SESSION_ID, adjudicatesLocally: true })
  expect(session.registrations).toEqual([])
  session.startSession()
  session.emit('permissions:ready', { sessionId: SESSION_ID, adjudicatesLocally: true })
  expect(session.registrations).toEqual([{ sessionId: SESSION_ID, name: ENSO_AUTO_AUTHORIZER, disposed: false }])
})

test("⚠ another session's ready broadcast registers nothing under that session's id", () => {
  const session = autoSession()
  session.emit('permissions:ready', { sessionId: 'session-b', adjudicatesLocally: true })
  expect(session.registrations.map((registration) => registration.sessionId)).toEqual([SESSION_ID])
})

test('shutdown disposes the link, and the next session registers again', () => {
  const session = autoSession()
  session.shutdown()
  expect(session.registrations).toEqual([{ sessionId: SESSION_ID, name: ENSO_AUTO_AUTHORIZER, disposed: true }])
  session.startSession()
  expect(session.registrations.filter((registration) => !registration.disposed)).toHaveLength(1)
})

// --- the link's verdicts

test('outside auto the link defers without asking the classifier', async () => {
  const session = autoSession()
  expect(await session.ask(bashAsk('npm test', null, modeAgentName('acceptEdits')))).toEqual({ kind: 'defer' })
  expect(await session.ask(bashAsk('npm test', null, modeAgentName('default')))).toEqual({ kind: 'defer' })
  expect(session.classifierRequests).toEqual([])
})

test("an allow runs the action; the classifier saw the user's request, the action and the directory", async () => {
  const session = autoSession()
  expect(await session.ask(bashAsk('bun test src/parse.test.ts', '**'))).toEqual({ kind: 'allow' })
  const request = session.classifierRequests[0]
  expect(request?.apiKey).toBe('sk-test')
  expect(request?.prompt).toContain('fix the failing test in src/parse.ts')
  expect(request?.prompt).toContain('bun test src/parse.test.ts')
  expect(request?.prompt).toContain('/work/project')
  expect(session.reviews.map((review) => review.details?.decision)).toEqual(['allow'])
})

test("a block denies with the classifier's reason, told to the agent", async () => {
  const session = autoSession({
    reply: () =>
      Promise.resolve('```json\n{"decision":"block","reason":"It pushes to a remote the user never named."}\n```'),
  })
  const verdict = await session.ask(bashAsk('git push origin main --force'))
  expect(verdict.kind).toBe('deny')
  expect(verdict.kind === 'deny' ? verdict.reason : undefined).toContain('It pushes to a remote the user never named.')
})

test('the link defers when the classifier cannot answer', async () => {
  const cases: HarnessOptions[] = [
    { reply: () => Promise.resolve('I think this is fine.') },
    { reply: () => Promise.resolve('{"decision":"maybe","reason":"?"}') },
    { reply: () => Promise.reject(new Error('rate limited')) },
    { model: undefined },
    { auth: { ok: false, error: 'no API key for acme' } },
  ]
  for (const options of cases) {
    const session = autoSession(options)
    expect(await session.ask(bashAsk('curl https://example.test'))).toEqual({ kind: 'defer' })
    expect(session.reviews.map((review) => review.event)).toEqual(['enso_auto_deferred'])
  }
})

test('⚠ a classifier that outlives its deadline defers, even when the model call ignores the abort', async () => {
  const session = autoSession({
    reply: () => new Promise<string>(() => undefined),
    underDeadline: (run) => {
      const controller = new AbortController()
      const running = run(controller.signal)
      controller.abort(new Error('deadline passed'))
      return running
    },
  })
  expect(await session.ask(bashAsk('make deploy'))).toEqual({ kind: 'defer' })
  expect(session.reviews[0]?.details?.cause).toBe('deadline passed')
})

test("⚠ a rule the user wrote reaches the user, a surface-wide `*` included; Enso's `**` catch-all and the engine sentinels go to the classifier (#498)", async () => {
  const session = autoSession()
  expect(await session.ask(bashAsk('git push origin main', 'git push *'))).toEqual({ kind: 'defer' })
  // `bash: 'ask'` or `bash: { '*': 'ask' }`, as the engine reports either: the user's own rule.
  expect(await session.ask(bashAsk('npm run build', '*'))).toEqual({ kind: 'defer' })
  // The gate recorded no pattern, but the engine, asked again, names a rule the user wrote.
  expect(await session.ask(bashAsk('rm -rf build'), queryAnswering({ state: 'ask', matchedPattern: 'rm *' }))).toEqual({
    kind: 'defer',
  })
  expect(await session.ask(bashAsk('make'), queryAnswering({ state: 'ask', matchedPattern: '*' }))).toEqual({
    kind: 'defer',
  })
  expect(session.classifierRequests).toEqual([])

  expect(await session.ask(bashAsk('npm run lint', '**'))).toEqual({ kind: 'allow' })
  expect(await session.ask(bashAsk("bash -c 'make'", '<indirection-bash-wrapper>'))).toEqual({ kind: 'allow' })
  expect(await session.ask(bashAsk('make test'), queryAnswering({ state: 'ask', matchedPattern: '**' }))).toEqual({
    kind: 'allow',
  })
  // No pattern at all: the engine's synthesised universal fallback, Enso's too.
  expect(await session.ask(bashAsk('make docs'), queryAnswering({ state: 'ask' }))).toEqual({
    kind: 'allow',
  })
  expect(session.classifierRequests).toHaveLength(4)
})

test('a forwarded ask, whose rule is not visible, reaches the user', async () => {
  const session = autoSession()
  const forwarded = { ...bashAsk('npm test'), forwarding: { requesterAgentName: 'child', requesterSessionId: 'c' } }
  expect(await session.ask(forwarded)).toEqual({ kind: 'defer' })
  expect(session.classifierRequests).toEqual([])
})

test('an ask whose payload does not read reaches the user, never the classifier', async () => {
  const session = autoSession()
  // As if an engine upgrade moved the request facts: the rule behind the ask cannot be seen.
  const moved = { ...bashAsk('rm -rf build'), payload: { kind: 'tool' } } as unknown as PromptPermissionDetails
  expect(await session.ask(moved)).toEqual({ kind: 'defer' })
  expect(session.classifierRequests).toEqual([])
})

// --- what the classifier is told the user asked

/** The text between the prompt's `<user-request>` tags, as the classifier reads it. */
async function userRequestSeen(branch: unknown[]): Promise<string | undefined> {
  const session = autoSession({ branch })
  await session.ask(bashAsk('npm test'))
  return /<user-request>\n([\s\S]*)\n<\/user-request>/.exec(session.classifierRequests[0]?.prompt ?? '')?.[1]
}

test("the classifier is told the LAST user message, whatever came after it and whatever isn't a message", async () => {
  expect(
    await userRequestSeen([
      { type: 'message', message: { role: 'user', content: 'an older request' } },
      { type: 'message', message: { role: 'user', content: 'the latest request' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } },
      { type: 'custom', customType: 'active_agent', data: { name: AUTO_AGENT } },
      { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } },
    ]),
  ).toBe('the latest request')
})

test("a user message in parts is its text parts joined by lines; an image or a part with no text isn't in it", async () => {
  expect(
    await userRequestSeen([
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'rename the parser' },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            { type: 'text' },
            null,
            { type: 'text', text: 'and keep the old name exported' },
          ],
        },
      },
    ]),
  ).toBe('rename the parser\nand keep the old name exported')
})

test('⚠ an entry that does not read as a user message is passed over for an earlier one that does', async () => {
  expect(
    await userRequestSeen([
      { type: 'message', message: { role: 'user', content: 'the request that reads' } },
      { type: 'message', message: { role: 'user', content: { text: 'content of a shape pi never writes' } } },
      { type: 'message', message: { role: 'user' } },
      { type: 'message', message: null },
      { type: 'message' },
      { message: { role: 'user', content: 'no entry type' } },
      null,
      'not an entry',
    ]),
  ).toBe('the request that reads')
})

test('a session with no user message yet tells the classifier so, rather than an empty request', async () => {
  expect(await userRequestSeen([{ type: 'message', message: { role: 'assistant', content: 'hello' } }])).toBe(
    '(no user message in this session yet)',
  )
  expect(await userRequestSeen([])).toBe('(no user message in this session yet)')
})

// --- the real classifier call, over pi-ai's completion

const CLASSIFIER_MODEL = {
  id: 'judge-1',
  provider: 'acme',
  api: 'acme-messages',
  baseUrl: 'https://acme.test',
} as unknown as Model<Api>

interface CompletionCall {
  readonly model: Model<Api>
  readonly context: Context
  readonly options: SimpleStreamOptions | undefined
}

function classifierRequest(overrides: Partial<ClassifierRequest> = {}): ClassifierRequest {
  return {
    model: CLASSIFIER_MODEL,
    apiKey: undefined,
    headers: undefined,
    environment: undefined,
    systemPrompt: 'you review one action',
    prompt: '<user-request>\nfix it\n</user-request>',
    signal: new AbortController().signal,
    ...overrides,
  }
}

function assistantReply(reply: Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage'>): AssistantMessage {
  return {
    role: 'assistant',
    api: 'acme-messages',
    provider: 'acme',
    model: 'judge-1',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
    ...reply,
  }
}

/** A completion that records what it was sent and answers `reply`. */
function completion(
  reply: AssistantMessage,
  calls: CompletionCall[],
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage> {
  return (model, context, options) => {
    calls.push({ model, context, options })
    return Promise.resolve(reply)
  }
}

test("the classifier call sends the session's model, the system prompt and the prompt as one user message, capped at 400 tokens", async () => {
  const calls: CompletionCall[] = []
  const request = classifierRequest()
  await askClassifier(request, completion(assistantReply({ content: [], stopReason: 'stop' }), calls))
  expect(calls).toHaveLength(1)
  const [call] = calls
  expect(call?.model).toBe(CLASSIFIER_MODEL)
  expect(call?.context.systemPrompt).toBe('you review one action')
  expect(call?.context.messages).toEqual([
    { role: 'user', content: '<user-request>\nfix it\n</user-request>', timestamp: expect.any(Number) },
  ])
  // No key, headers or environment: the options carry none, so pi-ai resolves its own.
  expect(call?.options).toEqual({ signal: request.signal, maxTokens: 400 })
})

test("the session's key, headers and environment reach the call as copies, the headers' nulls included", async () => {
  const calls: CompletionCall[] = []
  const headers = { 'x-team': 'enso', 'x-drop': null }
  const environment = { AZURE_RESOURCE: 'acme-east' }
  await askClassifier(
    classifierRequest({ apiKey: 'sk-test', headers, environment }),
    completion(assistantReply({ content: [], stopReason: 'stop' }), calls),
  )
  const options = calls[0]?.options
  expect(options?.apiKey).toBe('sk-test')
  expect(options?.headers).toEqual(headers)
  expect(options?.headers).not.toBe(headers)
  expect(options?.env).toEqual(environment)
  expect(options?.env).not.toBe(environment)
})

test("the reply is its text parts joined as written; thinking and tool calls aren't part of it", async () => {
  const reply = assistantReply({
    stopReason: 'stop',
    content: [
      { type: 'thinking', thinking: 'the user asked for a test run' },
      { type: 'text', text: '{"decision":"allow",' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
      { type: 'text', text: '"reason":"fits"}' },
    ],
  })
  expect(await askClassifier(classifierRequest(), completion(reply, []))).toBe('{"decision":"allow","reason":"fits"}')
})

test("⚠ a call that ended in error or was aborted throws with the provider's message, never reads as an answer", async () => {
  const failed = assistantReply({
    stopReason: 'error',
    errorMessage: '429 rate limited',
    content: [{ type: 'text', text: '{"decision":"allow","reason":"partial"}' }],
  })
  await expect(askClassifier(classifierRequest(), completion(failed, []))).rejects.toThrow(
    'the classifier call ended with error: 429 rate limited',
  )
  const aborted = assistantReply({ stopReason: 'aborted', content: [] })
  await expect(askClassifier(classifierRequest(), completion(aborted, []))).rejects.toThrow(
    'the classifier call ended with aborted: no message',
  )
})

// --- the forced system prompt (#443)

test("⚠ a prompt forced by an earlier before_agent_start handler is cleared, the run's sections kept", () => {
  const session = harness()
  const systemPromptOptions: Record<string, unknown> = {
    forceSystemPrompt: 'the engine-relocated prompt',
    selectedTools: ['read', 'bash'],
    sections: { environment: 'cwd: /work/project' },
  }
  session.beforeAgentStart({ type: 'before_agent_start', prompt: 'hi', systemPromptOptions })
  expect(systemPromptOptions).toEqual({
    selectedTools: ['read', 'bash'],
    sections: { environment: 'cwd: /work/project' },
  })
})
