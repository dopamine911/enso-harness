import { expect, test } from 'bun:test'
import { runGoogleProviderSearch } from '../web-search/providers/google.ts'
import { runOpenAiProviderSearch } from '../web-search/providers/openai.ts'
import type {
  FetchUrl,
  FetchUrlInit,
  ModelSearchRequest,
  ResolvedProviderAuth,
  SearchModel,
} from '../web-search/vocabulary.ts'
import { WebSearchProviderError } from '../web-search/vocabulary.ts'

/**
 * The google and openai providers (#63) against synthetic wire fixtures.
 *
 * ⚠ NAMED NON-COVERAGE RECORD (#63): these two providers have NO LIVE RECEIPT — this
 * install holds no Google, OpenAI, Azure, or Copilot key, so the fixtures encode the
 * wire shapes as documented and as consumed from pi-web-search 1.4.0, unverified against
 * the real APIs. If a key ever exists here, run one live search per provider, capture
 * the secret-free transcript, extend these fixtures from it, and delete this paragraph.
 */

/** Await a provider run that MUST reject; returns the typed provider error. */
async function expectProviderRejection(promise: Promise<unknown>): Promise<WebSearchProviderError> {
  let caught: unknown = 'the run resolved instead of rejecting'
  try {
    await promise
  } catch (error) {
    caught = error
  }
  if (caught instanceof WebSearchProviderError) return caught
  throw new Error(`expected a WebSearchProviderError rejection, got: ${String(caught)}`)
}

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const TEST_AUTH: ResolvedProviderAuth = { ok: true, apiKey: 'model-key' }

// The provider seam's own model (L6): what the providers read, nothing of the runtime's.
function fakeModel(overrides: Partial<SearchModel>): SearchModel {
  return {
    id: 'test-model',
    provider: 'test-provider',
    api: 'openai-responses',
    baseUrl: 'https://api.test.example/v1',
    maxTokens: 8192,
    reasoning: false,
    ...overrides,
  }
}

function modelRequest(model: SearchModel, fetchUrl: FetchUrl): ModelSearchRequest {
  return {
    query: 'what is zen-harness',
    model,
    resolveAuth: async () => TEST_AUTH,
    fetchUrl,
    signal: undefined,
  }
}

// --- google ---

const GOOGLE_MODEL = fakeModel({
  provider: 'google-generative-ai',
  api: 'google-generative-ai',
  id: 'gemini-test',
  baseUrl: 'https://generativelanguage.test.example/v1beta',
})

// ⚠ Multi-byte answer text, deliberately: groundingSupports index by BYTE, and this
// fixture is red if the citation applier ever inserts by character.
const GOOGLE_ANSWER = '禅ハーネスはguarded piセットアップ。'

function googleGroundedEvents(): unknown[] {
  const answerByteLength = new TextEncoder().encode(GOOGLE_ANSWER).length
  return [
    {
      candidates: [{ content: { parts: [{ text: GOOGLE_ANSWER }] } }],
    },
    {
      candidates: [
        {
          content: { parts: [] },
          groundingMetadata: {
            webSearchQueries: ['zen-harness'],
            groundingChunks: [{ web: { uri: 'https://example.com/zen', title: 'Zen docs' } }],
            groundingSupports: [{ segment: { endIndex: answerByteLength }, groundingChunkIndices: [0] }],
          },
        },
      ],
    },
  ]
}

test('google: grounded stream → searched, byte-safe citation markers, chunk-ordered sources', async () => {
  const outcome = await runGoogleProviderSearch(
    modelRequest(GOOGLE_MODEL, async () => sseResponse(googleGroundedEvents())),
  )
  expect(outcome.kind).toBe('searched')
  if (outcome.kind !== 'searched') throw new Error('unreachable')
  expect(outcome.answerText).toBe(`${GOOGLE_ANSWER}[1]`)
  expect(outcome.sources).toEqual([{ title: 'Zen docs', url: 'https://example.com/zen' }])
})

test('google: an answer with NO grounding metadata is `ungrounded`', async () => {
  const events = [{ candidates: [{ content: { parts: [{ text: 'From training.' }] } }] }]
  const outcome = await runGoogleProviderSearch(modelRequest(GOOGLE_MODEL, async () => sseResponse(events)))
  expect(outcome.kind).toBe('ungrounded')
})

test('google: grounding-redirect URLs resolve through a HEAD and keep originals on failure', async () => {
  const redirectUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc123'
  const unresolvableUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/broken'
  const events = [
    {
      candidates: [
        {
          content: { parts: [{ text: 'answer' }] },
          groundingMetadata: {
            webSearchQueries: ['q'],
            groundingChunks: [{ web: { uri: redirectUrl, title: 'Unknown' } }, { web: { uri: unresolvableUrl } }],
            groundingSupports: [],
          },
        },
      ],
    },
  ]
  const headRequests: string[] = []
  const fetchUrl: FetchUrl = async (url: string, init: FetchUrlInit) => {
    if (init.method === 'HEAD') {
      headRequests.push(url)
      if (url === redirectUrl) {
        return new Response(null, { status: 302, headers: { location: 'https://real.example/page' } })
      }
      throw new Error('HEAD failed')
    }
    return sseResponse(events)
  }
  const outcome = await runGoogleProviderSearch(modelRequest(GOOGLE_MODEL, fetchUrl))
  expect(headRequests.sort()).toEqual([redirectUrl, unresolvableUrl].sort())
  if (outcome.kind !== 'searched') throw new Error('expected searched')
  expect(outcome.sources[0]).toEqual({ title: 'page', url: 'https://real.example/page' })
  expect(outcome.sources[1]?.url).toBe(unresolvableUrl)
})

test('google: an in-stream error chunk throws with the API message', async () => {
  const events = [{ error: { message: 'quota exceeded', code: 429 } }]
  const thrown = await expectProviderRejection(
    runGoogleProviderSearch(modelRequest(GOOGLE_MODEL, async () => sseResponse(events))),
  )
  expect(thrown).toBeInstanceOf(WebSearchProviderError)
  expect(thrown.message).toContain('quota exceeded')
  expect(thrown.requestDispatched).toBe(true)
})

// --- openai ---

const OPENAI_MODEL = fakeModel({ provider: 'openai', api: 'openai-responses', id: 'gpt-test' })

const OPENAI_SEARCHED_EVENTS = [
  { type: 'response.web_search_call.searching', item_id: 'ws1' },
  { type: 'response.output_text.delta', delta: 'zen-harness is a guarded pi setup.' },
  {
    type: 'response.output_text.annotation.added',
    annotation: { type: 'url_citation', url: 'https://example.com/zen', title: 'Zen docs', end_index: 34 },
  },
  { type: 'response.completed', response: { output: [] } },
]

test('openai: a stream with web_search_call activity → searched with index-inserted markers', async () => {
  let capturedUrl: string | undefined
  const outcome = await runOpenAiProviderSearch(
    modelRequest(OPENAI_MODEL, async (url) => {
      capturedUrl = url
      return sseResponse(OPENAI_SEARCHED_EVENTS)
    }),
  )
  expect(capturedUrl).toBe('https://api.test.example/v1/responses')
  expect(outcome.kind).toBe('searched')
  if (outcome.kind !== 'searched') throw new Error('unreachable')
  // end_index 34 is the string's end — the marker inserts at that character offset.
  expect(outcome.answerText).toBe('zen-harness is a guarded pi setup.[1]')
  expect(outcome.sources).toEqual([{ title: 'Zen docs', url: 'https://example.com/zen' }])
})

test('openai: text with no search activity and no citations is `ungrounded`', async () => {
  const events = [
    { type: 'response.output_text.delta', delta: 'From training.' },
    { type: 'response.completed', response: { output: [] } },
  ]
  const outcome = await runOpenAiProviderSearch(modelRequest(OPENAI_MODEL, async () => sseResponse(events)))
  expect(outcome.kind).toBe('ungrounded')
})

test("openai: response.failed throws with the wire's message", async () => {
  const events = [{ type: 'response.failed', response: { error: { message: 'insufficient_quota' } } }]
  const thrown = await expectProviderRejection(
    runOpenAiProviderSearch(modelRequest(OPENAI_MODEL, async () => sseResponse(events))),
  )
  expect(thrown).toBeInstanceOf(WebSearchProviderError)
  expect(thrown.message).toContain('insufficient_quota')
})

// A minimal fake ChatGPT OAuth JWT whose payload carries the account id claim.
function fakeCodexToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

test('openai codex: /codex/responses URL, account-id header from the token, early stream stop', async () => {
  const codexModel = fakeModel({
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    id: 'codex-test',
    baseUrl: 'https://chatgpt.test.example/backend-api',
  })
  let capturedUrl: string | undefined
  let capturedHeaders: Record<string, string> | undefined
  const request: ModelSearchRequest = {
    ...modelRequest(codexModel, async (url, init) => {
      capturedUrl = url
      capturedHeaders = init.headers
      // Two final events: the stream must stop at the FIRST response.completed (the
      // Codex stream never closes on its own) — a second event would double-collect.
      return sseResponse([
        { type: 'response.output_text.delta', delta: 'answer' },
        { type: 'response.completed', response: { output: [{ type: 'web_search_call', id: 'ws1', action: {} }] } },
        { type: 'response.completed', response: { output: [{ type: 'web_search_call', id: 'ws2', action: {} }] } },
      ])
    }),
    resolveAuth: async () => ({ ok: true, apiKey: fakeCodexToken() }),
  }
  const outcome = await runOpenAiProviderSearch(request)
  expect(capturedUrl).toBe('https://chatgpt.test.example/backend-api/codex/responses')
  expect(capturedHeaders?.['chatgpt-account-id']).toBe('acct-42')
  expect(capturedHeaders?.originator).toBe('codex_cli_rs')
  expect(outcome.kind).toBe('searched')
})

test('openai codex: a credential that is not a parseable JWT refuses before dispatch', async () => {
  const codexModel = fakeModel({ provider: 'openai-codex', api: 'openai-codex-responses' })
  let fetchCalls = 0
  const request: ModelSearchRequest = {
    ...modelRequest(codexModel, async () => {
      fetchCalls += 1
      return sseResponse([])
    }),
    resolveAuth: async () => ({ ok: true, apiKey: 'not-a-jwt' }),
  }
  const thrown = await expectProviderRejection(runOpenAiProviderSearch(request))
  expect(thrown).toBeInstanceOf(WebSearchProviderError)
  expect(thrown.requestDispatched).toBe(false)
  expect(fetchCalls).toBe(0)
})

test('both model providers surface a failed credential resolution without dispatching', async () => {
  let fetchCalls = 0
  const countingFetch: FetchUrl = async () => {
    fetchCalls += 1
    return sseResponse([])
  }
  for (const run of [runGoogleProviderSearch, runOpenAiProviderSearch]) {
    const request: ModelSearchRequest = {
      ...modelRequest(run === runGoogleProviderSearch ? GOOGLE_MODEL : OPENAI_MODEL, countingFetch),
      resolveAuth: async () => ({ ok: false, error: 'no credential for provider' }),
    }
    const thrown = await expectProviderRejection(run(request))
    expect(thrown).toBeInstanceOf(WebSearchProviderError)
    expect(thrown.message).toContain('no credential for provider')
    expect(thrown.requestDispatched).toBe(false)
  }
  expect(fetchCalls).toBe(0)
})

test("google: a trailing slash on the model's baseUrl never emits a double-slash URL — PR #64 review", async () => {
  const slashModel = fakeModel({
    provider: 'google-generative-ai',
    api: 'google-generative-ai',
    id: 'gemini-test',
    baseUrl: 'https://generativelanguage.test.example/v1beta/',
  })
  let capturedUrl: string | undefined
  await runGoogleProviderSearch(
    modelRequest(slashModel, async (url) => {
      capturedUrl = url
      return sseResponse(googleGroundedEvents())
    }),
  )
  expect(capturedUrl).toBe(
    'https://generativelanguage.test.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
  )
})
