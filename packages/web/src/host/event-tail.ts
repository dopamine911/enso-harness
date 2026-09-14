import type { RuntimeEvent, ZenEventProvenance, ZenThreadEvent } from '@zen/core'

/**
 * A thread's event tail (#97): the last N events through one funnel, with provenance.
 *
 * #86 built a way to see a thread's STATE (what pi holds beside what the browser believes)
 * and it found #88 within minutes. The next class of bug is ORDERING — an entry emitted to
 * nobody (#88), an `agent_settled` replayed into the next run's pump (#69), a receipt
 * before or after `RUN_STARTED` (#84) — and every one of those was reconstructed from
 * source. Each is one glance at a timestamped list. This is that list.
 *
 * Two tails per thread, one per funnel: the host's `emit` (pi's rpc events, with HOW they
 * were delivered) and the server's follow writer (wire frames, in the wire's own order —
 * an observation's row is named by its kind). Three columns, one screen: what pi holds ·
 * what the host emitted · what the browser got.
 *
 * ⚠ COALESCED, not sampled. Consecutive events of the same type+name+provenance fold into
 * one record with a count — a model turn is hundreds of text deltas — so the tail stays
 * readable without losing an event: the count is exact.
 *
 * ⚠ A RING, per thread. Old records fall off the front; a long session costs nothing extra.
 * Not persisted, not streamed (refresh on demand, #86's rule: a debugging surface puts no
 * traffic in the trace it is reading).
 */

/** Enough for a whole run with its startup replays and a few tool calls; deltas coalesce. */
export const EVENT_TAIL_CAPACITY = 200

export interface EventTail {
  readonly record: (type: string, name: string | undefined, provenance: ZenEventProvenance) => void
  /** Oldest first. A fresh copy per call — the caller's to keep or mutate; the ring is untouched. */
  readonly recent: () => ZenThreadEvent[]
}

export function createEventTail(capacity = EVENT_TAIL_CAPACITY): EventTail {
  const ring: ZenThreadEvent[] = []
  let nextSequence = 0
  return {
    record: (type: string, name: string | undefined, provenance: ZenEventProvenance) => {
      const last = ring.at(-1)
      if (last !== undefined && last.type === type && last.name === name && last.provenance === provenance) {
        ring[ring.length - 1] = { ...last, count: last.count + 1 }
        return
      }
      nextSequence += 1
      const entry: ZenThreadEvent = {
        sequence: nextSequence,
        type,
        provenance,
        at: new Date().toISOString(),
        count: 1,
      }
      ring.push(name === undefined ? entry : { ...entry, name })
      if (ring.length > capacity) ring.shift()
    },
    recent: () => [...ring],
  }
}

/**
 * The inner name of a pi rpc event when its type alone reads as nothing: which custom
 * entry, which ui method, which tool. Read defensively — pi's shapes are carried, not
 * modelled (`thread-runtime.ts`).
 */
export function describeRuntimeEvent(event: RuntimeEvent): { type: string; name: string | undefined } {
  const record = event as { type: string; entry?: unknown; method?: unknown; toolName?: unknown }
  if (record.type === 'entry_appended' && typeof record.entry === 'object' && record.entry !== null) {
    const entry = record.entry as { type?: unknown; customType?: unknown }
    if (typeof entry.customType === 'string') return { type: record.type, name: entry.customType }
    if (typeof entry.type === 'string') return { type: record.type, name: entry.type }
  }
  if (typeof record.method === 'string') return { type: record.type, name: record.method }
  if (typeof record.toolName === 'string') return { type: record.type, name: record.toolName }
  return { type: record.type, name: undefined }
}
