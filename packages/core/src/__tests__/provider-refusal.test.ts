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
 * prefix `<Name> (<status>): <body>`, and a failure with no status at all.
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
  { message: '503: upstream unavailable', status: 503, refusalClass: 'provider error', reason: 'upstream unavailable' },
  { message: 'fetch failed', status: undefined, refusalClass: 'request failed', reason: 'fetch failed' },
]

test('each real shape of a provider error reads as its status, its class word and the provider’s own sentence', () => {
  for (const row of ROWS) {
    expect({
      status: providerStatusOf(row.message),
      refusalClass: providerRefusalClass(providerStatusOf(row.message)),
      reason: providerReasonOf(row.message),
    }).toEqual({ status: row.status, refusalClass: row.refusalClass, reason: row.reason })
  }
})

// A status is only the one pi's providers put in front — never a number from inside the prose, or
// a request id's digits would classify a refusal.
test('a number inside the message is not a status, and a long or multi-line reason is cut to its first line', () => {
  expect(providerStatusOf('request req_429abc was cancelled after 500 ms')).toBeUndefined()
  const long = `503: ${'x'.repeat(1000)}\nsecond line`
  expect(providerReasonOf(long)).toHaveLength(301)
  expect(providerReasonOf('502: <html>\n<body>bad gateway</body>')).toBe('<html>')
})
