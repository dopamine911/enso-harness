import {
  claudeCodeVersionHint,
  claudeCodeVersionRefusalOf,
  type EnsoProviderRefusal,
  providerReasonOf,
  providerRefusalClass,
  readEnsoProviderRefusal,
} from '@enso/core'
import { TranscriptLine } from './notifications.tsx'

/**
 * Who refused, as a reader names them (#387): pi's display name for the provider (`Anthropic`),
 * else its id; undefined when the refusal names no provider. The line's source label — so the
 * class word can never be read as an Enso policy.
 */
export function providerRefusalSource(refusal: EnsoProviderRefusal): string | undefined {
  return refusal.providerName ?? refusal.provider
}

/**
 * A refused attempt, said (#340, #381): `<model> refused: <class> (<status>) — <reason>`, beside
 * its source (`providerRefusalSource`) — `Anthropic · claude-opus-5 refused: rate-limited (429) — …`.
 *
 * One sentence, two places. Live, the router writes it as a transcript line the moment the host
 * says `provider-refused`; on a reload, pi's stored attempt carries the same refusal and its
 * bubble says it where the reply would have been. Both read this, so the two never word it apart.
 *
 * Anthropic's refusal of the claimed Claude Code version (#925) gets Enso's own next step after it:
 * its sentence says "Run 'claude update'", which changes nothing Enso sends.
 */
export function providerRefusalLine(refusal: EnsoProviderRefusal): string {
  const status = refusal.status === undefined ? '' : ` (${refusal.status})`
  const versionRefusal = claudeCodeVersionRefusalOf(refusal.message)
  const hint = versionRefusal === undefined ? '' : ` ${claudeCodeVersionHint(versionRefusal)}`
  const verdict = `refused: ${providerRefusalClass(refusal)}${status} — ${providerReasonOf(refusal.message)}${hint}`
  if (refusal.model !== undefined) return `${refusal.model} ${verdict}`
  return providerRefusalSource(refusal) === undefined ? `the provider ${verdict}` : verdict
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
 * The refusal in the attempt's own bubble (#381): the same row the live line is (`TranscriptLine`,
 * error), so a reloaded thread reads the way it did while it ran.
 */
export function RefusedAttemptLine({ refusal }: { refusal: EnsoProviderRefusal }): React.ReactNode {
  return (
    <TranscriptLine
      notifyType="error"
      message={providerRefusalLine(refusal)}
      source={providerRefusalSource(refusal)}
      data-enso-refused-attempt=""
    />
  )
}
