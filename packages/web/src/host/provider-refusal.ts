import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { type EnsoProviderRefusal, providerStatusOf } from '@enso/core'

/**
 * The refusal an assistant `message_end` records, or nothing (#340).
 *
 * pi marks a request the provider refused on the assistant message it could not produce:
 * `stopReason: "error"` and `errorMessage` (`@earendil-works/pi-ai` `AssistantMessage`). That
 * message still ends as `message_end`, which keeps its accounting role; the host says the refusal
 * beside it, as its own `provider_refused` event, so nothing above the seam reads pi's message
 * shape. A stop the user made is `stopReason: "aborted"` — not a refusal, and not said.
 */
export function providerRefusalOf(event: AgentSessionEvent): EnsoProviderRefusal | undefined {
  if (event.type !== 'message_end') return undefined
  return providerRefusalOfMessage(event.message)
}

/**
 * The refusal one of pi's messages records, or nothing — live off `message_end`, or stored on the
 * branch (#381): pi keeps the failed attempt in the session file with the same two fields, so a
 * reload reads the refusal from where the live event read it.
 */
export function providerRefusalOfMessage(raw: unknown): EnsoProviderRefusal | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const message = raw as {
    role?: unknown
    stopReason?: unknown
    errorMessage?: unknown
    provider?: unknown
    model?: unknown
  }
  if (message.role !== 'assistant' || message.stopReason !== 'error') return undefined
  const text = typeof message.errorMessage === 'string' && message.errorMessage.length > 0 ? message.errorMessage : ''
  const status = providerStatusOf(text)
  return {
    ...(typeof message.provider === 'string' && message.provider.length > 0 ? { provider: message.provider } : {}),
    ...(typeof message.model === 'string' && message.model.length > 0 ? { model: message.model } : {}),
    ...(status === undefined ? {} : { status }),
    message: text.length > 0 ? text : 'the provider returned an error without a message',
  }
}
