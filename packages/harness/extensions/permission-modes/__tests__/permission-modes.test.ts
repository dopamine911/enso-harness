import { expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ACTIVE_AGENT_CUSTOM_TYPE, ENSO_AUTO_AUTHORIZER, ENSO_OPERATOR_DENIAL_ENTRY, modeAgentName } from '@enso/core'
import type {
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionCheckResult,
  PermissionQuery,
  PromptPermissionDetails,
} from '@gotgenes/pi-permission-system'
import { type ClassifierRequest, createPermissionModes, type PermissionModesDependencies } from '../index.ts'

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
  /** The run's abort signal, as pi's context carries it while the agent runs. */
  readonly signal?: AbortSignal
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
    signal: options.signal,
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

// --- the operator's No (#441)

test("a person's No on this session's prompt is recorded as an operator denial", () => {
  const session = harness()
  session.emit('permissions:decision', {
    requestId: 'request-7',
    surface: 'bash',
    value: 'rm -rf dist',
    result: 'deny',
    resolution: 'user_denied',
    origin: null,
    agentName: null,
    matchedPattern: '*',
  })
  expect(session.entries).toEqual([
    { customType: ENSO_OPERATOR_DENIAL_ENTRY, data: { requestId: 'request-7', surface: 'bash', value: 'rm -rf dist' } },
  ])
})

test('⚠ a Stop is not a No: a denial while the run is aborting records nothing', () => {
  const stopped = new AbortController()
  stopped.abort()
  const session = harness({ signal: stopped.signal })
  session.startSession()
  // What the engine broadcasts when the host settles its open question unanswered on Stop.
  session.emit('permissions:decision', {
    requestId: 'request-9',
    surface: 'bash',
    value: 'npm test',
    result: 'deny',
    resolution: 'user_denied',
  })
  expect(session.entries).toEqual([])
})

test('decisions a person did not deny here, and malformed ones, record nothing', () => {
  const session = harness()
  const decision = { requestId: 'request-8', surface: 'bash', value: 'ls', result: 'deny', origin: null }
  session.emit('permissions:decision', { ...decision, result: 'allow', resolution: 'user_approved' })
  session.emit('permissions:decision', { ...decision, resolution: 'policy_deny' })
  session.emit('permissions:decision', { ...decision, resolution: 'authorizer_denied' })
  session.emit('permissions:decision', {
    ...decision,
    resolution: 'user_denied',
    forwarding: { requesterAgentName: 'child', requesterSessionId: 'c' },
  })
  session.emit('permissions:decision', { resolution: 'user_denied', surface: 'bash' })
  session.emit('permissions:decision', null)
  expect(session.entries).toEqual([])
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
