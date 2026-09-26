import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { type EnsoProviderRefusal, providerStatusOf } from '@enso/core'

/** A provider's display name by id, or undefined when pi names no such provider. */
export type ProviderNameOf = (providerId: string) => string | undefined

let builtinNames: ReadonlyMap<string, string> | undefined

/**
 * pi's own display name for one of its built-in providers (`Anthropic`, `OpenAI`, `xAI`), read from
 * pi-ai's catalogue — no session, so a stored thread read cold is named the same as a live one
 * (#387). Built once, on first use: constructing the catalogue is a millisecond of plain objects.
 */
export function builtinProviderName(providerId: string): string | undefined {
  builtinNames ??= new Map(builtinProviders().map((provider) => [provider.id, provider.name]))
  return builtinNames.get(providerId)
}

/**
 * The refusal an assistant `message_end` records, or nothing (#340).
 *
 * pi marks a request the provider refused on the assistant message it could not produce:
 * `stopReason: "error"` and `errorMessage` (`@earendil-works/pi-ai` `AssistantMessage`). That
 * message still ends as `message_end`, which keeps its accounting role; the host says the refusal
 * beside it, as its own `provider_refused` event, so nothing above the seam reads pi's message
 * shape. A stop the user made is `stopReason: "aborted"` — not a refusal, and not said.
 */
export function providerRefusalOf(
  event: AgentSessionEvent,
  providerNameOf: ProviderNameOf = builtinProviderName,
): EnsoProviderRefusal | undefined {
  if (event.type !== 'message_end') return undefined
  return providerRefusalOfMessage(event.message, providerNameOf)
}

/**
 * The refusal one of pi's messages records, or nothing — live off `message_end`, or stored on the
 * branch (#381): pi keeps the failed attempt in the session file with the same two fields, so a
 * reload reads the refusal from where the live event read it.
 */
export function providerRefusalOfMessage(
  raw: unknown,
  providerNameOf: ProviderNameOf = builtinProviderName,
): EnsoProviderRefusal | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const message = raw as {
    role?: unknown
    stopReason?: unknown
    errorMessage?: unknown
    provider?: unknown
    model?: unknown
    rawStopReason?: unknown
    usage?: { output?: unknown }
  }
  if (message.role !== 'assistant' || message.stopReason !== 'error') return undefined
  const text = nonEmpty(message.errorMessage)
  const output = message.usage?.output
  const provider = nonEmpty(message.provider)
  // #384: the provider's own stop reason — a policy stop arrives on a response that already
  // succeeded, so it carries no status — and what the attempt spent before it was stopped.
  return {
    ...definedOnly({
      provider,
      providerName: provider === undefined ? undefined : providerNameOf(provider),
      model: nonEmpty(message.model),
      status: text === undefined ? undefined : providerStatusOf(text),
      providerStopReason: nonEmpty(message.rawStopReason),
      // 0 is "spent nothing", the same as absent to its one reader; left out, so a refusal before any
      // token (a 429) reads as it always did (PR #402 review).
      output: typeof output === 'number' && Number.isInteger(output) && output > 0 ? output : undefined,
    }),
    message: text ?? 'the provider returned an error without a message',
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The fields that have a value — the wire's optional fields are absent, never `undefined`. */
function definedOnly<Fields extends Record<string, unknown>>(
  fields: Fields,
): Partial<{ [Key in keyof Fields]: NonNullable<Fields[Key]> }> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<{
    [Key in keyof Fields]: NonNullable<Fields[Key]>
  }>
}
