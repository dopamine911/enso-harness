import { type EnsoRecordedModel, type EnsoTranscriptEntry, transcriptEntryOf } from '@enso/core'
import { descriptorFrom } from './map-events.ts'
import { providerRefusalOfMessage } from './provider-refusal.ts'

/**
 * The runtime's session branch → the transcript of ours (#162 workstream 4, L2's persistence
 * side). The decoding of the runtime's stored entry shapes is `@enso/core`'s `transcriptEntryOf`
 * (#557: one module names the envelope, and every fold takes what it produces); this adds the two
 * things that need the vendor's own types, so stay in the host: a provider refusal pi kept on a
 * failed attempt (#381), and a tool result's rendering descriptor from pi's `details` (#18).
 * `AgentHost.readStoredThread` and a hosted thread's `inspect()` hand out what this produces, and
 * nothing above the seam decodes a stored entry again.
 *
 * The one exception is `recordedModelOf` (#434): the last `model_change` and the last
 * `thinking_level_change` on the branch are what a cold thread says it last ran on — what pi
 * restores when it opens the session. Walked here rather than through pi's `buildSessionContext`,
 * which answers `off` for a branch that recorded no level: a level nobody chose must read as none.
 */

/** The record, with what the host alone can add; `raw` is the entry it was decoded from. */
function enriched(entry: EnsoTranscriptEntry, raw: unknown): EnsoTranscriptEntry {
  const stored = typeof raw === 'object' && raw !== null ? (raw as { message?: unknown }).message : undefined
  if (entry.kind === 'message' && entry.role === 'assistant') {
    // A refused attempt (#381): pi keeps it on the branch, marked, and it is said as such — not
    // as the empty reply its parts alone would read as.
    const refusal = providerRefusalOfMessage(stored)
    return refusal === undefined ? entry : { ...entry, refusal }
  }
  if (entry.kind === 'tool-result') {
    const details =
      typeof stored === 'object' && stored !== null ? (stored as { details?: unknown }).details : undefined
    const descriptor = descriptorFrom(entry.toolName, details)
    return descriptor === undefined ? entry : { ...entry, descriptor }
  }
  return entry
}

/** The branch, root to leaf, as the transcript — same length, same order. */
export function transcriptOf(branch: readonly unknown[]): EnsoTranscriptEntry[] {
  return branch.map((raw, position) => enriched(transcriptEntryOf(raw, position), raw))
}

interface PiStateEntry {
  type?: unknown
  provider?: unknown
  modelId?: unknown
  thinkingLevel?: unknown
  message?: { role?: unknown; provider?: unknown; model?: unknown }
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * What the branch (root to leaf) records it last ran on; `undefined` when it records neither half
 * (#434). pi's own restore rule (`session-manager.js` `getSessionContextSettings`, PR #438
 * review): the model is the last `model_change` OR assistant reply on the path — a reply records the
 * model that produced it, and pi falls back to another model on reopen WITHOUT appending a change
 * when the recorded one cannot be restored. The level is the last `thinking_level_change`; pi
 * defaults a missing one to `off`, which this does not invent.
 */
export function recordedModelOf(branch: readonly unknown[]): EnsoRecordedModel | undefined {
  let model: EnsoRecordedModel['model'] = null
  let thinkingLevel: string | null = null
  for (const raw of branch) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as PiStateEntry
    const reply = entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message : undefined
    if (entry.type === 'model_change' && nonEmpty(entry.provider) && nonEmpty(entry.modelId)) {
      model = { provider: entry.provider, modelId: entry.modelId }
    } else if (reply !== undefined && nonEmpty(reply.provider) && nonEmpty(reply.model)) {
      model = { provider: reply.provider, modelId: reply.model }
    } else if (entry.type === 'thinking_level_change' && nonEmpty(entry.thinkingLevel)) {
      thinkingLevel = entry.thinkingLevel
    }
  }
  return model === null && thinkingLevel === null ? undefined : { model, thinkingLevel }
}
