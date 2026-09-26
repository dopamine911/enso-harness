import { type EnsoProviderRefusal, providerReasonOf, providerRefusalClass, readEnsoProviderRefusal } from '@enso/core'
import { TranscriptLine } from './notifications.tsx'

/**
 * A refused attempt, said (#340, #381): `<provider>/<model> refused: <class> (<status>) — <reason>`.
 *
 * One sentence, two places. Live, the router writes it as a transcript line the moment the host
 * says `provider-refused`; on a reload, pi's stored attempt carries the same refusal and its
 * bubble says it where the reply would have been. Both read this, so the two never word it apart.
 */
export function providerRefusalLine(refusal: EnsoProviderRefusal): string {
  const who =
    refusal.provider !== undefined && refusal.model !== undefined
      ? `${refusal.provider}/${refusal.model}`
      : (refusal.provider ?? refusal.model ?? 'the provider')
  const status = refusal.status === undefined ? '' : ` (${refusal.status})`
  return `${who} refused: ${providerRefusalClass(refusal)}${status} — ${providerReasonOf(refusal.message)}`
}

/** The refusal a mounted message carries (#381), or nothing — a message as JSON or as TanStack's. */
export function refusalOfMessage(message: unknown): EnsoProviderRefusal | undefined {
  if (typeof message !== 'object' || message === null || !('metadata' in message)) return undefined
  const { metadata } = message
  return typeof metadata === 'object' && metadata !== null
    ? readEnsoProviderRefusal(metadata as Record<string, unknown>)
    : undefined
}

/**
 * The refusal the thread's LAST assistant message is (#381), or nothing: what a resumed thread's
 * status bar says. A refusal followed by a reply is history, not the thread's state.
 */
export function trailingRefusalOf(messages: readonly unknown[]): EnsoProviderRefusal | undefined {
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const message = messages[position]
    if (typeof message === 'object' && message !== null && 'role' in message && message.role === 'assistant') {
      return refusalOfMessage(message)
    }
  }
  return undefined
}

/**
 * The refusal in the attempt's own bubble (#381): the same row the live line is (`TranscriptLine`,
 * error), so a reloaded thread reads the way it did while it ran.
 */
export function RefusedAttemptLine({ refusal }: { refusal: EnsoProviderRefusal }): React.ReactNode {
  return <TranscriptLine notifyType="error" message={providerRefusalLine(refusal)} data-enso-refused-attempt="" />
}
