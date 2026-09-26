import { type Static, Type } from 'typebox'
import { Check } from 'typebox/value'

/**
 * A model provider refused a request (#340): the fact the page and the log were missing. Before
 * this, a run the provider refused ended as `run-ended` with no tokens — the SHAPE of a failure —
 * while the reason (a 429, a missing login, a model the account may not use) sat only in the
 * runtime's own message and a vendor extension's debug file, and the page read `idle · $0.0000`
 * for two hours of retries.
 *
 * pi marks the failed attempt on the assistant message it could not produce (`stopReason:
 * "error"`, `errorMessage`); the host says it as `provider_refused` beside that message's own
 * `message_end`, which keeps its accounting role unchanged. pi's retry (`auto_retry_start`) is
 * the separate `EnsoProviderRetry`, and its end (`auto_retry_end`) `EnsoProviderRetryEnd`.
 *
 * ⚠ CLASSIFIED, NOT PARSED FROM PROSE. Two parts are structured: the provider's own stop reason,
 * which pi keeps (`rawStopReason`) when a response that already succeeded ends in a refusal (#384 —
 * Anthropic's `refusal`, OpenAI's `content_filter`, Gemini's `SAFETY`, …, with no HTTP status at
 * all), and the HTTP status pi's providers put in front of an error message. The class word comes
 * from those, the stop reason first; the provider's own message travels verbatim for a reader.
 */

/**
 * One refused attempt: which provider and model, the HTTP status when the message carries one,
 * and the provider's message as pi recorded it.
 *
 * @group Thread runtime
 */
export const EnsoProviderRefusal = Type.Object({
  provider: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  /** The provider's own stop reason, when it ended a response it had begun (#384): `refusal`, `content_filter`, `SAFETY`, … */
  providerStopReason: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * The output tokens the refused attempt itself spent (#384): a refusal mid-stream comes after
   * the model wrote some, and that is not a reply getting through.
   */
  output: Type.Optional(Type.Integer({ minimum: 0 })),
  message: Type.String(),
})
/** @group Thread runtime */
export type EnsoProviderRefusal = Static<typeof EnsoProviderRefusal>

/**
 * The key a stored refusal rides under in a mounted assistant message's `metadata` (#381) — the
 * same colon-namespaced bag {@link ENSO_TOOL_RESULT_KEY} uses, for the same reason: the message
 * shape is the renderer's, and this is the one fact of ours on it.
 *
 * @group Thread runtime
 */
export const ENSO_PROVIDER_REFUSAL_KEY = 'enso:providerRefusal' as const

/**
 * The refusal a mounted message's `metadata` carries, or nothing — checked, since the bag is
 * anyone's and crosses the wire as JSON.
 *
 * @group Thread runtime
 */
export function readEnsoProviderRefusal(
  metadata: Record<string, unknown> | undefined,
): EnsoProviderRefusal | undefined {
  const candidate = metadata?.[ENSO_PROVIDER_REFUSAL_KEY]
  return Check(EnsoProviderRefusal, candidate) ? candidate : undefined
}

/**
 * pi is retrying a refused request (#340): which attempt this will be, of how many, and after how
 * long — pi's `auto_retry_start`, as it says it.
 *
 * @group Thread runtime
 */
export const EnsoProviderRetry = Type.Object({
  attempt: Type.Integer({ minimum: 1 }),
  maxAttempts: Type.Integer({ minimum: 1 }),
  delayMs: Type.Number({ minimum: 0 }),
})

/**
 * pi stopped retrying (#380 review) — pi's `auto_retry_end`: whether a retry got through, how many
 * retries it made, and — when none did — the last error, or `Retry cancelled` when a Stop ended
 * the wait. Without it a transcript that ran out of retries ends on `retrying in …`, as if one
 * were still coming.
 *
 * @group Thread runtime
 */
export const EnsoProviderRetryEnd = Type.Object({
  success: Type.Boolean(),
  attempt: Type.Integer({ minimum: 1 }),
  finalError: Type.Optional(Type.String()),
})

/**
 * The HTTP status a provider error message carries, where pi's providers put it: at the start
 * (`429 {"type":"error",…}` — the Anthropic SDK's message; `429: <body>` — pi's generic
 * `formatProviderError`), in a named prefix (`OpenAI API error (429): …`), or as the numeric
 * `error.code` of a bare JSON body (`{"error":{"code":429,…}}` — `@google/genai`, which pi's
 * Gemini and Vertex providers pass through unprefixed). `undefined` when it carries none — a
 * network failure, an unknown shape.
 *
 * @group Thread runtime
 */
export function providerStatusOf(message: string): number | undefined {
  const found = /^(\d{3})\b|^[^():\n]{1,80}\((\d{3})\):/.exec(message)
  const digits = found?.[1] ?? found?.[2]
  const status = digits === undefined ? jsonErrorBodyOf(message)?.code : Number(digits)
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
}

/**
 * The class words a refusal is shown as — see {@link providerRefusalClass}.
 *
 * @group Thread runtime
 */
export type ProviderRefusalClass =
  | 'rate-limited'
  | 'not logged in'
  | 'model refused'
  | 'provider policy'
  | 'provider error'
  | 'request failed'

/**
 * The provider stop reasons that mean "the provider's policy stopped this content" (#384), as pi
 * records them per API: Anthropic's `refusal` and `sensitive`; OpenAI chat's `content_filter`, and
 * the Responses API's `incomplete.content_filter`; Bedrock's guardrail and content filter; Gemini
 * and Vertex's safety, blocklist, prohibited-content and recitation reasons. pi maps every one to an
 * error stop; nothing else here says which of those errors is a policy.
 *
 * @group Thread runtime
 */
export const PROVIDER_POLICY_STOP_REASONS: ReadonlySet<string> = new Set([
  'refusal',
  'sensitive',
  'content_filter',
  'incomplete.content_filter',
  'guardrail_intervened',
  'content_filtered',
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
])

/**
 * The short word for a refusal: what a person glancing at the status bar needs — whether waiting
 * helps (`rate-limited`, `provider error`), logging in does (`not logged in`), rephrasing might
 * (`provider policy`: the provider's content policy stopped it), or none of these (`model refused`:
 * the request itself, often the model, is not allowed).
 *
 * ⚠ `provider policy`, not `content policy` (#384, #387): until an error line says whose it is, the
 * word must name the owner, or it reads as one of Enso's own guards.
 *
 * @group Thread runtime
 */
export function providerRefusalClass(
  refusal: Pick<EnsoProviderRefusal, 'status' | 'providerStopReason'>,
): ProviderRefusalClass {
  if (refusal.providerStopReason !== undefined && PROVIDER_POLICY_STOP_REASONS.has(refusal.providerStopReason)) {
    return 'provider policy'
  }
  const { status } = refusal
  if (status === 429) return 'rate-limited'
  if (status === 401 || status === 403) return 'not logged in'
  if (status !== undefined && status >= 400 && status < 500) return 'model refused'
  if (status !== undefined && status >= 500) return 'provider error'
  return 'request failed'
}

/** The longest reason a line or a record carries — a 4 000-character error page is not a reason. */
const PROVIDER_REASON_MAX_CHARS = 300

/**
 * What a JSON error body says for itself: its sentence — `error.message` (Anthropic, OpenAI,
 * Gemini) or `message` — and, when numeric, `error.code` (Gemini's HTTP status; OpenAI's codes
 * are words, and are not a status).
 */
function jsonErrorBodyOf(text: string): { readonly message?: string; readonly code?: number } | undefined {
  if (!text.startsWith('{')) return undefined
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: { message?: unknown; code?: unknown } }
    const message = typeof body.error?.message === 'string' ? body.error.message : body.message
    return {
      ...(typeof message === 'string' ? { message } : {}),
      ...(typeof body.error?.code === 'number' ? { code: body.error.code } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * The provider's own words for a refusal, for a person: the status prefix pi put in front removed,
 * a JSON error body reduced to the message it carries, and the first line, capped. The status and
 * class travel separately; this is the sentence beside them.
 *
 * @group Thread runtime
 */
export function providerReasonOf(message: string): string {
  const withoutStatus = message
    .replace(/^\d{3}\b:?\s*/, '')
    .replace(/^[^():\n]{1,80}\(\d{3}\):\s*/, '')
    .trim()
  const said = jsonErrorBodyOf(withoutStatus)?.message ?? withoutStatus
  const [firstLine = ''] = said.split('\n', 1)
  const line = firstLine.trim()
  if (line.length === 0) return 'no reason given'
  return line.length > PROVIDER_REASON_MAX_CHARS ? `${line.slice(0, PROVIDER_REASON_MAX_CHARS)}…` : line
}
