import { expect, test } from 'bun:test'
import {
  type ProviderRefusalClass,
  providerReasonOf,
  providerRefusalClass,
  providerStatusOf,
} from '../provider-refusal.ts'

/**
 * A provider's refusal, read the way pi's providers write it (#340): the status pi puts in front,
 * the class word a person glances at, and the provider's own sentence out of its JSON. Each row is
 * a real shape — the Anthropic SDK's `<status> <json>`, pi's generic `<status>: <body>`, a named
 * prefix `<Name> (<status>): <body>`, Gemini's bare `{"error":{"code":…}}`, and a failure with no
 * status at all.
 */

const ROWS: ReadonlyArray<{
  message: string
  status: number | undefined
  refusalClass: ProviderRefusalClass
  reason: string
}> = [
  {
    message:
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
    status: 429,
    refusalClass: 'rate-limited',
    reason: "This request would exceed your account's rate limit.",
  },
  {
    message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    status: 401,
    refusalClass: 'not logged in',
    reason: 'invalid x-api-key',
  },
  {
    message:
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required"}}',
    status: 400,
    refusalClass: 'model refused',
    reason: 'Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required',
  },
  {
    // #341: a local proxy that says "server error" for a missing login — the class follows the
    // status it chose, and the sentence beside it is what tells a person to log in.
    message:
      'OpenAI API error (500): {"message":"No Cursor account is logged in for this request. Run /login and pick a cursor slot.","type":"server_error"}',
    status: 500,
    refusalClass: 'provider error',
    reason: 'No Cursor account is logged in for this request. Run /login and pick a cursor slot.',
  },
  {
    message: '503: upstream unavailable',
    status: 503,
    refusalClass: 'provider error',
    reason: 'upstream unavailable',
  },
  {
    // #380 review: `@google/genai` puts the whole body in the message and pi's Gemini provider adds
    // no prefix — the status is the body's numeric `code`, or a Gemini rate limit reads as a
    // network failure.
    message:
      '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
    status: 429,
    refusalClass: 'rate-limited',
    reason: 'Resource has been exhausted (e.g. check quota).',
  },
  {
    // OpenAI's `code` is a word, not a status: the class stays unknown rather than borrowing it.
    message: '{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached"}}',
    status: undefined,
    refusalClass: 'request failed',
    reason: 'Rate limit reached',
  },
  {
    message: 'fetch failed',
    status: undefined,
    refusalClass: 'request failed',
    reason: 'fetch failed',
  },
]

test('each real shape of a provider error reads as its status, its class word and the provider’s own sentence', () => {
  for (const row of ROWS) {
    const status = providerStatusOf(row.message)
    expect({
      status,
      refusalClass: providerRefusalClass(status === undefined ? {} : { status }),
      reason: providerReasonOf(row.message),
    }).toEqual({
      status: row.status,
      refusalClass: row.refusalClass,
      reason: row.reason,
    })
  }
})

// #384: a policy stop arrives on a response that already succeeded — no status — and pi keeps the
// provider's own stop reason. Those class as the provider's policy, ahead of any status; any other
// stop reason (a network failure, a malformed tool call) is not a policy and falls back to the status.
test('a provider policy stop classes as `provider policy` from its stop reason; any other stop reason falls back to the status', () => {
  // The test's OWN list, not the set it checks (PR #402 review): iterating the set would miss an
  // entry dropped from it. Each API's policy stops, as pi records them in `rawStopReason`
  // (`@earendil-works/pi-ai/dist/api/…`).
  const policyStops: Record<string, readonly string[]> = {
    // `anthropic-messages.js` `mapStopReason`: `refusal` and `sensitive` → error
    anthropic: ['refusal', 'sensitive'],
    // `openai-completions.js`: `content_filter` → error; `openai-responses-shared.js`: `${status}.${incompleteReason}`
    openai: ['content_filter', 'incomplete.content_filter'],
    // `bedrock-converse-stream.js`: every stop reason pi does not name → error, with the reason kept
    bedrock: ['guardrail_intervened', 'content_filtered'],
    // `google-shared.js` `mapStopReason`, for Gemini and Vertex alike
    google: [
      'SAFETY',
      'PROHIBITED_CONTENT',
      'BLOCKLIST',
      'SPII',
      'RECITATION',
      'IMAGE_SAFETY',
      'IMAGE_PROHIBITED_CONTENT',
      'IMAGE_RECITATION',
    ],
  }
  for (const [api, stops] of Object.entries(policyStops)) {
    for (const providerStopReason of stops) {
      expect({
        api,
        providerStopReason,
        refusalClass: providerRefusalClass({ providerStopReason }),
      }).toEqual({
        api,
        providerStopReason,
        refusalClass: 'provider policy',
      })
    }
  }
  expect(providerRefusalClass({ providerStopReason: 'refusal', status: 429 })).toBe('provider policy')
  expect(providerRefusalClass({ providerStopReason: 'network_error' })).toBe('request failed')
  expect(
    providerRefusalClass({
      providerStopReason: 'MALFORMED_FUNCTION_CALL',
      status: 400,
    }),
  ).toBe('model refused')
})

// A status is only the one pi's providers put in front — never a number from inside the prose, or
// a request id's digits would classify a refusal.
test('a number inside the message is not a status, and a long or multi-line reason is cut to its first line', () => {
  expect(providerStatusOf('request req_429abc was cancelled after 500 ms')).toBeUndefined()
  // Four leading digits are not a status — and the reason keeps them whole, in step (#380 review).
  expect(providerStatusOf('5000 tokens exceeded the limit')).toBeUndefined()
  expect(providerReasonOf('5000 tokens exceeded the limit')).toBe('5000 tokens exceeded the limit')
  const long = `503: ${'x'.repeat(1000)}\nsecond line`
  expect(providerReasonOf(long)).toHaveLength(301)
  expect(providerReasonOf('502: <html>\n<body>bad gateway</body>')).toBe('<html>')
})
