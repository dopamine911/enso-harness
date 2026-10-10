import { expect, test } from 'bun:test'
import { runGoogleProviderSearch } from '../web-search/providers/google.ts'
import { runOpenAiProviderSearch } from '../web-search/providers/openai.ts'
import type {
  FetchUrl,
  FetchUrlInit,
  ModelSearchRequest,
  ResolvedProviderAuth,
  SearchModel,
  WebSearchOutcome,
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
    query: 'what is Enso',
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
            webSearchQueries: ['Enso'],
            groundingChunks: [{ web: { uri: 'https://example.com/enso', title: 'Enso docs' } }],
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
  expect(outcome.sources).toEqual([{ title: 'Enso docs', url: 'https://example.com/enso' }])
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
  expect(headRequests.toSorted()).toEqual([redirectUrl, unresolvableUrl].toSorted())
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
  { type: 'response.output_text.delta', delta: 'Enso is a guarded pi setup.' },
  {
    type: 'response.output_text.annotation.added',
    annotation: { type: 'url_citation', url: 'https://example.com/enso', title: 'Enso docs', end_index: 34 },
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
  expect(outcome.answerText).toBe('Enso is a guarded pi setup.[1]')
  expect(outcome.sources).toEqual([{ title: 'Enso docs', url: 'https://example.com/enso' }])
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

/** The openai provider's outcome over `events`, required to be `searched`. */
async function openAiSearched(events: unknown[]): Promise<Extract<WebSearchOutcome, { kind: 'searched' }>> {
  const outcome = await runOpenAiProviderSearch(modelRequest(OPENAI_MODEL, async () => sseResponse(events)))
  if (outcome.kind !== 'searched') throw new Error(`expected a searched outcome, got ${outcome.kind}`)
  return outcome
}

test("openai: a web_search_call's sources follow the cited ones, titled by title, display_name, name, else the URL; the action's own URL is one too", async () => {
  const outcome = await openAiSearched([
    { type: 'response.output_text.delta', delta: 'Enso.' },
    {
      type: 'response.output_text.annotation.added',
      annotation: { type: 'url_citation', url: 'https://example.com/enso', title: 'Enso docs', end_index: 5 },
    },
    {
      type: 'response.output_item.done',
      item: {
        type: 'web_search_call',
        action: {
          sources: [
            { url: 'https://a.example/one', title: 'One', display_name: 'not this' },
            { url: 'https://b.example/two', display_name: 'Two', name: 'not this' },
            { url: 'https://c.example/three', name: 'Three' },
            { url: 'https://d.example/docs/four' },
            { title: 'a source with no URL' },
            { url: '', title: 'a source with an empty URL' },
            'not a source',
            // The cited page again, behind a tracking parameter: listed once, as the cited source.
            { url: 'https://example.com/enso?utm_source=search', title: 'Enso docs again' },
          ],
          url: 'https://e.example/opened',
        },
      },
    },
    { type: 'response.completed', response: { output: [] } },
  ])
  expect(outcome.answerText).toBe('Enso.[1]')
  expect(outcome.sources).toEqual([
    { title: 'Enso docs', url: 'https://example.com/enso' },
    { title: 'One', url: 'https://a.example/one' },
    { title: 'Two', url: 'https://b.example/two' },
    { title: 'Three', url: 'https://c.example/three' },
    { title: 'four', url: 'https://d.example/docs/four' },
    { title: 'opened', url: 'https://e.example/opened' },
  ])
})

test('openai: a web_search_call item with no action still makes the answer searched; any other output item does not', async () => {
  const searched = await openAiSearched([
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws1', status: 'in_progress' } },
    { type: 'response.completed', response: { output: [] } },
  ])
  expect(searched.sources).toEqual([])
  const events = [
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg1', action: { url: 'https://x.example' } } },
    { type: 'response.output_item.done', item: 'not an item' },
    { type: 'response.completed', response: { output: [{ type: 'reasoning', id: 'rs1' }] } },
  ]
  const outcome = await runOpenAiProviderSearch(modelRequest(OPENAI_MODEL, async () => sseResponse(events)))
  expect(outcome.kind).toBe('ungrounded')
})

test("openai: the final response's url_citations are read from its message items' output_text parts, and only from there", async () => {
  const cited = (url: string, endIndex: number): unknown => ({ type: 'url_citation', url, end_index: endIndex })
  const outcome = await openAiSearched([
    { type: 'response.output_text.delta', delta: 'One. Two.' },
    {
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'One.', annotations: [cited('https://a.example/one', 4)] },
              { type: 'refusal', annotations: [cited('https://x.example/refusal', 4)] },
              { type: 'output_text', text: ' Two.' },
              null,
              {
                type: 'output_text',
                annotations: [{ type: 'file_citation', file_id: 'f1' }, cited('https://b.example/two', 9)],
              },
            ],
          },
          {
            type: 'reasoning',
            content: [{ type: 'output_text', annotations: [cited('https://x.example/reason', 9)] }],
          },
          { type: 'message', content: 'not a list of parts' },
          null,
        ],
      },
    },
  ])
  expect(outcome.answerText).toBe('One.[1] Two.[2]')
  expect(outcome.sources).toEqual([
    { title: 'one', url: 'https://a.example/one' },
    { title: 'two', url: 'https://b.example/two' },
  ])
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

// --- openai: GitHub Copilot's endpoint ---

const COPILOT_MODEL = fakeModel({ provider: 'github-copilot', baseUrl: 'https://copilot.model.test.example' })

/** The URL the search was dispatched to, for `model` under the credential `auth` resolves to. */
async function dispatchedUrl(model: SearchModel, auth: ResolvedProviderAuth): Promise<string | undefined> {
  let capturedUrl: string | undefined
  await runOpenAiProviderSearch({
    ...modelRequest(model, async (url) => {
      capturedUrl = url
      return sseResponse(OPENAI_SEARCHED_EVENTS)
    }),
    resolveAuth: async () => auth,
  })
  return capturedUrl
}

test("openai copilot: the credential's own endpoint wins, and only for a github-copilot model", async () => {
  const enterprise = 'https://api.enterprise.githubcopilot.com'
  expect(await dispatchedUrl(COPILOT_MODEL, { ok: true, apiKey: 'tid=1', baseUrl: enterprise })).toBe(
    `${enterprise}/responses`,
  )
  // Another provider's credential endpoint is never followed: the model's own base URL stands.
  expect(await dispatchedUrl(OPENAI_MODEL, { ok: true, apiKey: 'k', baseUrl: enterprise })).toBe(
    'https://api.test.example/v1/responses',
  )
  // A blank endpoint is no endpoint: the token is read instead.
  expect(
    await dispatchedUrl(COPILOT_MODEL, {
      ok: true,
      apiKey: 'tid=1;proxy-ep=proxy.individual.githubcopilot.com',
      baseUrl: '  ',
    }),
  ).toBe('https://api.individual.githubcopilot.com/responses')
})

test("openai copilot: an older token's single proxy-ep maps the proxy host onto the API host", async () => {
  expect(
    await dispatchedUrl(COPILOT_MODEL, {
      ok: true,
      apiKey: 'tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;sku=free',
    }),
  ).toBe('https://api.individual.githubcopilot.com/responses')
  // Hosts are case-insensitive; the mapped one is lowercased.
  expect(await dispatchedUrl(COPILOT_MODEL, { ok: true, apiKey: 'proxy-ep=PROXY.Business.GithubCopilot.COM' })).toBe(
    'https://api.business.githubcopilot.com/responses',
  )
})

test("openai copilot: a token whose proxy-ep is missing, repeated, or not a Copilot proxy host keeps the model's base URL", async () => {
  const modelUrl = 'https://copilot.model.test.example/responses'
  const refused = [
    'tid=1;exp=2', // no proxy-ep
    'proxy-ep=proxy.a.githubcopilot.com;proxy-ep=proxy.b.githubcopilot.com', // two: ambiguous
    'proxy-ep=evil.individual.githubcopilot.com', // not a proxy. host
    'proxy-ep=proxy.githubcopilot.com', // too few labels to name a tier
    'proxy-ep=proxy.individual.githubcopilot.com.evil.example', // a Copilot-looking prefix on another domain
    'proxy-ep=proxy.individual.notcopilot.com', // the wrong second-level domain
    'proxy-ep=proxy.in_dividual.githubcopilot.com', // a character no host label holds
    'proxy-ep=proxy.-individual.githubcopilot.com', // a label may not start with a hyphen
    'proxy-ep=proxy..githubcopilot.com', // an empty label
    `proxy-ep=proxy.${'a'.repeat(64)}.githubcopilot.com`, // a label past 63 characters
    `proxy-ep=proxy.${Array.from({ length: 50 }, () => 'abcd').join('.')}.githubcopilot.com`, // a host past 253
  ]
  for (const apiKey of refused) {
    expect({ apiKey, url: await dispatchedUrl(COPILOT_MODEL, { ok: true, apiKey }) }).toEqual({ apiKey, url: modelUrl })
  }
  // A credential with no token at all (headers only) keeps it too.
  expect(await dispatchedUrl(COPILOT_MODEL, { ok: true, headers: { authorization: 'Bearer x' } })).toBe(modelUrl)
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
