import { expect, test } from 'bun:test'
import { EXTERNAL_WEB_CONTENT_NOTICE, WEB_SEARCH_TOOL_NAME } from '@enso/core'
import { auditRecords, recordEnsoLogs, releaseEnsoLogs } from '@enso/core/log-recorder'
import type { LogRecord } from '@logtape/logtape'
import type { DeepseekSearchRequest, TavilySearchRequest, WebSearchOutcome } from '../../../core/index.ts'
import { WebSearchProviderError } from '../../../core/index.ts'
import { createWebSearch, fallbackReasonFor, type WebSearchDependencies } from '../index.ts'

/**
 * The web_search extension (#63) against injected seams — the SELECTION and FALLBACK
 * policy, and the ACCURATE rendering contract. No test here touches the network or the
 * real config file; the provider wire parsing has its own fixture suites in
 * `core/__tests__/web-search-*.test.ts`.
 */

interface CapturedTool {
  name: string
  description: string
  /** pi's five positional execute arguments, named as a tuple — the gate caps declared parameters at four. */
  execute: (
    ...executeArguments: [
      toolCallId: string,
      params: { query: string },
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      extensionContext: unknown,
    ]
  ) => Promise<{ content: { type: string; text: string }[] }>
}

const QUERY = 'what changed in enso'
const SEARCHED: WebSearchOutcome = {
  kind: 'searched',
  providerId: 'anthropic',
  answerText: 'enso gained web_search[1].',
  sources: [{ title: 'Enso docs', url: 'https://example.com/enso' }],
}
const UNGROUNDED: WebSearchOutcome = {
  kind: 'ungrounded',
  providerId: 'anthropic',
  answerText: 'I believe enso gained web_search.',
}
const TAVILY_RESULTS: WebSearchOutcome = {
  kind: 'searched',
  providerId: 'tavily',
  sources: [{ title: 'Enso docs', url: 'https://example.com/enso' }],
  snippets: [{ title: 'Enso docs', url: 'https://example.com/enso', snippet: 'web_search landed' }],
}

/** A model whose api routes to the anthropic provider. */
const ANTHROPIC_MODEL = { id: 'claude-test', provider: 'anthropic', api: 'anthropic-messages', maxTokens: 8192 }
/** pi registers DeepSeek chat models like this — routable to NOTHING (#63). */
const UNROUTED_MODEL = { id: 'deepseek-v4-flash', provider: 'deepseek', api: 'openai-completions', maxTokens: 8192 }

interface LoadedWebSearch {
  /** Run the extension's `session_start`, as pi does when the session begins. */
  startSession: () => Promise<void>
  tool: CapturedTool
  calls: { anthropic: number; deepseek: number; tavily: number }
  tavilyRequests: { apiKey: string; includeDomains?: readonly string[] | undefined }[]
  deepseekKeys: (string | undefined)[]
}

function loadWebSearch(
  overrides: Partial<WebSearchDependencies> = {},
  environment: Record<string, string> = {},
): LoadedWebSearch {
  const calls = { anthropic: 0, deepseek: 0, tavily: 0 }
  const tavilyRequests: LoadedWebSearch['tavilyRequests'] = []
  const deepseekKeys: (string | undefined)[] = []
  const dependencies: WebSearchDependencies = {
    locateConfigFile: () => '/home/u/.enso/config.json',
    readConfigText: () => JSON.stringify({ webFetch: { allowedHosts: [] } }),
    readEnvironmentVariable: (variableName: string) => environment[variableName],
    runProviders: {
      anthropic: async () => {
        calls.anthropic += 1
        return SEARCHED
      },
      google: async () => {
        throw new Error('google fake not expected in this test')
      },
      openai: async () => {
        throw new Error('openai fake not expected in this test')
      },
      deepseek: async (request: DeepseekSearchRequest) => {
        calls.deepseek += 1
        deepseekKeys.push(request.apiKey)
        return { ...SEARCHED, providerId: 'deepseek' }
      },
      tavily: async (request: TavilySearchRequest) => {
        calls.tavily += 1
        tavilyRequests.push({ apiKey: request.apiKey, includeDomains: request.includeDomains })
        return TAVILY_RESULTS
      },
    },
    fetchUrl: async () => {
      throw new Error('no test reaches the network')
    },
    resolveSessionConfig: () =>
      Promise.resolve({ result: { kind: 'ok', config: {} }, path: '/home/u/.enso/config.json' }),
    ...overrides,
  }
  let captured: CapturedTool | undefined
  let sessionStart: ((event: unknown, context: unknown) => Promise<void>) | undefined
  createWebSearch(dependencies)({
    registerTool: (tool: CapturedTool) => (captured = tool),
    on: (event: string, handler: typeof sessionStart) => {
      if (event === 'session_start') sessionStart = handler
    },
    events: {},
  } as never)
  if (captured === undefined) throw new Error('web-search did not register a tool')
  return {
    get tool(): CapturedTool {
      if (captured === undefined) throw new Error('web-search did not register a tool')
      return captured
    },
    startSession: async () => {
      await sessionStart?.({ type: 'session_start' }, { cwd: '/work/project', hasUI: true, ui: {} })
    },
    calls,
    tavilyRequests,
    deepseekKeys,
  }
}

async function run(loaded: LoadedWebSearch, extensionContext: unknown): Promise<string> {
  const result = await loaded.tool.execute('t', { query: QUERY }, undefined, undefined, extensionContext)
  const text = result.content[0]?.text
  if (text === undefined) throw new Error('the tool returned no text')
  return text
}

/** Capture the audit records for one call (#132: records, not stderr lines). */
async function withAuditCapture<T>(action: () => Promise<T>): Promise<{ value: T; audits: readonly LogRecord[] }> {
  const logs = await recordEnsoLogs()
  try {
    const value = await action()
    return { value, audits: auditRecords(logs, 'web-search') }
  } finally {
    await releaseEnsoLogs()
  }
}

test('a searched primary renders the via-line, the notice, the answer, and the sources', async () => {
  const loaded = loadWebSearch()
  const { value: text, audits } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('Searched the web via anthropic.')).toBe(true)
  expect(text).toContain(EXTERNAL_WEB_CONTENT_NOTICE)
  expect(text).toContain('enso gained web_search[1].')
  expect(text).toContain('1. [Enso docs](https://example.com/enso)')
  expect(loaded.calls.tavily).toBe(0)
  // One audit record, naming provider and outcome, never any key material.
  expect(audits).toHaveLength(1)
  expect(audits[0]?.properties).toMatchObject({ provider: 'anthropic', outcome: 'searched' })
})

// ⚠ THE ACCURACY CONTRACT (#63): an ungrounded answer with no fallback armed is returned
// LABELED, never rendered as a search result, and never carries the web-content notice
// (it is the model's own output, not external content).
test('ungrounded with no Tavily key: labeled as NOT a search result, no notice, no via-line', async () => {
  const loaded = loadWebSearch({
    runProviders: {
      anthropic: async () => UNGROUNDED,
      google: async () => UNGROUNDED,
      openai: async () => UNGROUNDED,
      deepseek: async () => UNGROUNDED,
      tavily: async () => TAVILY_RESULTS,
    },
  })
  const { value: text } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('No web search was performed')).toBe(true)
  expect(text).toContain('NOT a search result')
  expect(text).toContain('I believe enso gained web_search.')
  expect(text).not.toContain(EXTERNAL_WEB_CONTENT_NOTICE)
  expect(text).not.toContain('Searched the web')
})

test('ungrounded WITH Tavily armed falls back, and the render says why', async () => {
  const loaded = loadWebSearch(
    {
      runProviders: {
        anthropic: async () => UNGROUNDED,
        google: async () => UNGROUNDED,
        openai: async () => UNGROUNDED,
        deepseek: async () => UNGROUNDED,
        tavily: async () => TAVILY_RESULTS,
      },
    },
    { TAVILY_API_KEY: 'tv-key' },
  )
  const { value: text, audits } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('Searched the web via tavily (fallback')).toBe(true)
  expect(text).toContain('answered WITHOUT searching')
  expect(text).toContain('## Results')
  expect(text).toContain('web_search landed')
  expect(text).toContain(EXTERNAL_WEB_CONTENT_NOTICE)
  expect(audits.map((record) => record.properties.provider)).toEqual(['tavily'])
  // The key must never appear in the rendered text or any audit record.
  expect(text).not.toContain('tv-key')
  expect(JSON.stringify(audits.map((record) => record.properties))).not.toContain('tv-key')
})

test('a primary failure AFTER dispatch falls back and admits it may have billed', async () => {
  const loaded = loadWebSearch(
    {
      runProviders: {
        anthropic: async () => {
          throw new WebSearchProviderError('anthropic', 'HTTP 500', { requestDispatched: true })
        },
        google: async () => SEARCHED,
        openai: async () => SEARCHED,
        deepseek: async () => SEARCHED,
        tavily: async () => TAVILY_RESULTS,
      },
    },
    { TAVILY_API_KEY: 'tv-key' },
  )
  const { value: text } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('Searched the web via tavily (fallback')).toBe(true)
  expect(text).toContain('it may have billed')
  expect(text).toContain('HTTP 500')
})

// ── routing, through the EXTENSION (docs/flows/web-search-call.md, stated gap) ──
// `routedProviderIdForModel` is pinned in isolation; these drive the google and openai
// branches through the tool itself, so the selection the model sees is the one asserted.
// A wrong branch fails by name: the fake for the wrong provider throws.

test('a Gemini model routes to the google provider through the tool, and the audit names it', async () => {
  const calls = { google: 0 }
  const loaded = loadWebSearch({
    runProviders: {
      anthropic: async () => {
        throw new Error('anthropic must not run for a Gemini model')
      },
      google: async () => {
        calls.google += 1
        return { ...SEARCHED, providerId: 'google' }
      },
      openai: async () => {
        throw new Error('openai must not run for a Gemini model')
      },
      deepseek: async () => {
        throw new Error('deepseek is config-pinned, never routed')
      },
      tavily: async () => {
        throw new Error('the fallback must not fire on a searched primary')
      },
    },
  })
  const GEMINI_MODEL = {
    id: 'gemini-test',
    provider: 'google-generative-ai',
    api: 'google-generative-ai',
    maxTokens: 8192,
  }
  const { audits } = await withAuditCapture(() => run(loaded, { model: GEMINI_MODEL }))
  expect(calls.google).toBe(1)
  expect(audits[0]?.properties).toMatchObject({ provider: 'google', outcome: 'searched' })
})

test('every Responses-family api routes to the openai provider through the tool: openai, azure, codex', async () => {
  for (const api of ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']) {
    const calls = { openai: 0 }
    const loaded = loadWebSearch({
      runProviders: {
        anthropic: async () => {
          throw new Error(`anthropic must not run for ${api}`)
        },
        google: async () => {
          throw new Error(`google must not run for ${api}`)
        },
        openai: async () => {
          calls.openai += 1
          return { ...SEARCHED, providerId: 'openai' }
        },
        deepseek: async () => {
          throw new Error('deepseek is config-pinned, never routed')
        },
        tavily: async () => {
          throw new Error('the fallback must not fire on a searched primary')
        },
      },
    })
    const model = { id: `model-for-${api}`, provider: 'openai', api, maxTokens: 8192 }
    const { audits } = await withAuditCapture(() => run(loaded, { model }))
    expect(calls.openai).toBe(1)
    expect(audits[0]?.properties).toMatchObject({ provider: 'openai', outcome: 'searched' })
  }
})

test('an unrouted model with no Tavily key refuses, naming the arming env var', async () => {
  const loaded = loadWebSearch()
  const { value: text } = await withAuditCapture(() => run(loaded, { model: UNROUTED_MODEL }))
  expect(text.startsWith('Not searched:')).toBe(true)
  expect(text).toContain('has no native web search')
  expect(text).toContain('TAVILY_API_KEY')
  expect(loaded.calls.anthropic).toBe(0)
})

test('an unrouted model WITH Tavily armed searches through the fallback', async () => {
  const loaded = loadWebSearch({}, { TAVILY_API_KEY: 'tv-key' })
  const { value: text } = await withAuditCapture(() => run(loaded, { model: UNROUTED_MODEL }))
  expect(text.startsWith('Searched the web via tavily (fallback')).toBe(true)
  expect(loaded.tavilyRequests[0]?.apiKey).toBe('tv-key')
})

test('config backend=deepseek pins the dedicated backend and hands it ITS env key', async () => {
  const loaded = loadWebSearch(
    {
      readConfigText: () => JSON.stringify({ webFetch: { allowedHosts: [] }, webSearch: { backend: 'deepseek' } }),
    },
    { DEEPSEEK_API_KEY: 'ds-key' },
  )
  const { value: text } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('Searched the web via deepseek.')).toBe(true)
  expect(loaded.calls.deepseek).toBe(1)
  expect(loaded.calls.anthropic).toBe(0)
  expect(loaded.deepseekKeys).toEqual(['ds-key'])
})

test('config tavily domain filters reach the fallback request', async () => {
  const loaded = loadWebSearch(
    {
      readConfigText: () =>
        JSON.stringify({
          webFetch: { allowedHosts: [] },
          webSearch: { tavily: { includeDomains: ['example.com'] } },
        }),
    },
    { TAVILY_API_KEY: 'tv-key' },
  )
  await withAuditCapture(() => run(loaded, { model: UNROUTED_MODEL }))
  expect(loaded.tavilyRequests[0]?.includeDomains).toEqual(['example.com'])
})

test('both backends failing renders BOTH reasons', async () => {
  const loaded = loadWebSearch(
    {
      runProviders: {
        anthropic: async () => {
          throw new WebSearchProviderError('anthropic', 'primary broke', { requestDispatched: false })
        },
        google: async () => SEARCHED,
        openai: async () => SEARCHED,
        deepseek: async () => SEARCHED,
        tavily: async () => {
          throw new WebSearchProviderError('tavily', 'fallback broke too', { requestDispatched: true })
        },
      },
    },
    { TAVILY_API_KEY: 'tv-key' },
  )
  const { value: text } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('Not searched:')).toBe(true)
  expect(text).toContain('primary broke')
  expect(text).toContain('fallback broke too')
})

// #421: the session's config — a trusted project's pin over the user's none — takes over at its
// start: the project pinned the DeepSeek backend, so that is what runs, and the description says so.
test("⚠ at session start the session's config replaces the user's: a project's backend pin takes effect (#421)", async () => {
  const loaded = loadWebSearch(
    {
      resolveSessionConfig: () =>
        Promise.resolve({
          result: { kind: 'ok', config: { webSearch: { backend: 'deepseek' } } },
          path: '/work/project/.enso/config.json',
        }),
    },
    { DEEPSEEK_API_KEY: 'sk-deepseek' },
  )
  expect(loaded.tool.description).not.toContain('DeepSeek backend')
  await loaded.startSession()
  await run(loaded, { model: ANTHROPIC_MODEL })
  expect(loaded.calls.deepseek).toBe(1)
  expect(loaded.calls.anthropic).toBe(0)
  expect(loaded.tool.description).toContain('DeepSeek backend')
})

test('an unreadable config fails CLOSED: every call refuses, no provider runs', async () => {
  const loaded = loadWebSearch({
    readConfigText: () => '{ not json',
  })
  const { value: text } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('Not searched:')).toBe(true)
  expect(text).toContain('/home/u/.enso/config.json')
  expect(loaded.calls.anthropic).toBe(0)
  expect(loaded.calls.tavily).toBe(0)
})

test('the ABSENT webSearch section is the working default — current-model routing runs', async () => {
  // A config with no webSearch section; the tool must work anyway (#63:
  // a required section would have made every existing config unreadable).
  const loaded = loadWebSearch()
  const { value: text } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  expect(text.startsWith('Searched the web via anthropic.')).toBe(true)
})

test("the tool's self-description names the accuracy contract", () => {
  const loaded = loadWebSearch()
  expect(loaded.tool.name).toBe(WEB_SEARCH_TOOL_NAME)
  expect(loaded.tool.description).toContain('names')
  expect(loaded.tool.description).toContain('WITHOUT searching')
})

// ── one deadline for the whole call (#99) ────────────────────────────────────
// Per-attempt deadlines let primary + fallback run 2× the budget with nothing crossing to
// the browser; the server's no-progress guard read that as a hung run and cut it (#98).

/** A provider that never answers: it rejects only when its deadline signal aborts it. */
function stalledUntilAborted(providerId: 'anthropic') {
  return (request: { signal?: AbortSignal | undefined }): Promise<WebSearchOutcome> =>
    new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () =>
        reject(new WebSearchProviderError(providerId, String(request.signal?.reason), { requestDispatched: true })),
      )
    })
}

test('⚠ a primary that stalls for the whole budget leaves the fallback NO time — it is refused with the deadline, not run for another budget', async () => {
  const tavilySignals: boolean[] = []
  const loaded = loadWebSearch(
    {
      timeoutMs: 30,
      runProviders: {
        anthropic: stalledUntilAborted('anthropic'),
        google: async () => {
          throw new Error('unexpected')
        },
        openai: async () => {
          throw new Error('unexpected')
        },
        deepseek: async () => {
          throw new Error('unexpected')
        },
        tavily: async (request: TavilySearchRequest) => {
          tavilySignals.push(request.signal?.aborted === true)
          if (request.signal?.aborted === true) throw request.signal.reason
          return TAVILY_RESULTS
        },
      },
    },
    { TAVILY_API_KEY: 'tvly-test' },
  )
  const startedAt = Date.now()
  const { value: text } = await withAuditCapture(() => run(loaded, { model: ANTHROPIC_MODEL }))
  // Bounded by ONE budget, not two: well under 2 × 30ms even with scheduling slack.
  expect(Date.now() - startedAt).toBeLessThan(55)
  // The fallback was handed an already-dead signal, so it never really searched.
  expect(tavilySignals).toEqual([true])
  expect(text.startsWith('Not searched:')).toBe(true)
  expect(text).toContain('passed its deadline')
  expect(text).toContain('the Tavily fallback then failed too')
})

test('a primary that fails FAST leaves the fallback the rest of the budget, and the fallback is announced as progress', async () => {
  const progress: string[] = []
  const loaded = loadWebSearch(
    {
      timeoutMs: 500,
      runProviders: {
        anthropic: async () => {
          throw new WebSearchProviderError('anthropic', 'HTTP 529 overloaded', { requestDispatched: true })
        },
        google: async () => {
          throw new Error('unexpected')
        },
        openai: async () => {
          throw new Error('unexpected')
        },
        deepseek: async () => {
          throw new Error('unexpected')
        },
        tavily: async (request: TavilySearchRequest) => {
          expect(request.signal?.aborted).toBe(false)
          return TAVILY_RESULTS
        },
      },
    },
    { TAVILY_API_KEY: 'tvly-test' },
  )
  const onUpdate = (update: { content: { type: string; text: string }[] }): void => {
    const first = update.content[0]
    if (first !== undefined) progress.push(first.text)
  }
  const { value: result } = await withAuditCapture(() =>
    loaded.tool.execute('t', { query: QUERY }, undefined, onUpdate as never, { model: ANTHROPIC_MODEL }),
  )
  expect(result.content[0]?.text.startsWith('Searched the web via tavily')).toBe(true)
  // The one otherwise-silent moment in the chain now reports itself — the server's no-progress
  // guard counts a tool update as progress (#99).
  expect(progress.some((text) => text.includes('trying the Tavily fallback'))).toBe(true)
})

/**
 * ⚠ THE FALLBACK DECISION IS A DISCRIMINANT, NOT A STRING THE CALL SITE RE-READS (#227).
 * `fallbackReasonFor` used to take the whole `WebSearchOutcome | PrimaryFailure` union and
 * return `string | undefined`, with `undefined` meaning "the primary stands" — so the call
 * site needed two `as` casts, and the plausible edit "do not fall back when the request
 * already billed" (return `undefined` for a `PrimaryFailure`) compiled and sent a failure
 * record down the `searched` path: `Searched the web via undefined.` and then a `TypeError`
 * reading `.sources` off an object that has none, thrown out of the tool's `execute`.
 *
 * Both claims below are compile-time; a red line here is tsc, not bun. The directive going
 * UNUSED means the parameter was widened back; the `: string` annotations failing means
 * `undefined` became expressible as a reason again.
 */
test('⚠ a searched primary cannot be handed to the fallback reason builder, and a reason is never undefined', () => {
  // Asserted as a TYPE, not with the type checker's expect-error directive: that directive is
  // a suppression and the gate bans the whole family (#82). It is not needed here — a
  // `searched` outcome is simply not assignable to the parameter, so this alias is `true` and
  // the annotation compiles. Widen the parameter back and the alias is `never`, which tsc refuses.
  type SearchedIsNotAFallbackPrimary =
    Extract<WebSearchOutcome, { kind: 'searched' }> extends Parameters<typeof fallbackReasonFor>[0] ? never : true
  const searchedIsNotAFallbackPrimary: SearchedIsNotAFallbackPrimary = true
  expect(searchedIsNotAFallbackPrimary).toBe(true)

  const billed: string = fallbackReasonFor({ providerId: 'openai', reason: 'boom', requestDispatched: true })
  expect(billed).toContain('it may have billed')
  const ungrounded: string = fallbackReasonFor({ kind: 'ungrounded', providerId: 'anthropic', answerText: 'guess' })
  expect(ungrounded).toContain('WITHOUT searching')
})
