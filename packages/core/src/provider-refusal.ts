import { type Static, Type } from 'typebox'

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
 * the separate `EnsoProviderRetry`.
 *
 * ⚠ CLASSIFIED BY STATUS, NOT PARSED FROM PROSE. The one structured part of the message is the
 * HTTP status pi's providers put in front of it; the class word comes from that, and the
 * provider's own message travels verbatim for a reader.
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
  message: Type.String(),
})
/** @group Thread runtime */
export type EnsoProviderRefusal = Static<typeof EnsoProviderRefusal>

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
 * The HTTP status a provider error message carries, where pi's providers put it: at the start
 * (`429 {"type":"error",…}` — the Anthropic SDK's message; `429: <body>` — pi's generic
 * `formatProviderError`) or in a named prefix (`OpenAI API error (429): …`). `undefined` when it
 * carries none — a network failure, an unknown shape.
 *
 * @group Thread runtime
 */
export function providerStatusOf(message: string): number | undefined {
  const found = /^(\d{3})\b|^[^():\n]{1,80}\((\d{3})\):/.exec(message)
  const digits = found?.[1] ?? found?.[2]
  if (digits === undefined) return undefined
  const status = Number(digits)
  return status >= 100 && status <= 599 ? status : undefined
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
  | 'provider error'
  | 'request failed'

/**
 * The short word for a refusal, by its status: what a person glancing at the status bar needs —
 * whether waiting helps (`rate-limited`, `provider error`), logging in does (`not logged in`), or
 * neither (`model refused`: the request itself, often the model, is not allowed).
 *
 * @group Thread runtime
 */
export function providerRefusalClass(status: number | undefined): ProviderRefusalClass {
  if (status === 429) return 'rate-limited'
  if (status === 401 || status === 403) return 'not logged in'
  if (status !== undefined && status >= 400 && status < 500) return 'model refused'
  if (status !== undefined && status >= 500) return 'provider error'
  return 'request failed'
}

/** The longest reason a line or a record carries — a 4 000-character error page is not a reason. */
const PROVIDER_REASON_MAX_CHARS = 300

/** What a JSON error body says for itself: `error.message` (Anthropic, OpenAI) or `message`. */
function jsonMessageOf(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') return body.error.message
    return typeof body.message === 'string' ? body.message : undefined
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
    .replace(/^\d{3}:?\s*/, '')
    .replace(/^[^():\n]{1,80}\(\d{3}\):\s*/, '')
    .trim()
  const said = jsonMessageOf(withoutStatus) ?? withoutStatus
  const [firstLine = ''] = said.split('\n', 1)
  const line = firstLine.trim()
  if (line.length === 0) return 'no reason given'
  return line.length > PROVIDER_REASON_MAX_CHARS ? `${line.slice(0, PROVIDER_REASON_MAX_CHARS)}…` : line
}
