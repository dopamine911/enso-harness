import type { EnsoObservation, EnsoThreadEvent } from '@enso/core'
import { createEventTail, describeObservation } from './event-tail.ts'
import { mapPiEvent } from './map-events.ts'
import type { RuntimeEvent } from './runtime-event.ts'

/**
 * A live thread's event fan-out (#801): subscribers receive OBSERVATIONS (L2, #162 workstream 4) — the
 * runtime's event is mapped here, at delivery, and its shape never leaves the host. The emitted tail
 * (#97) records every event through this funnel with HOW it was delivered, at the one place all of
 * them pass, so the record and the delivery cannot disagree.
 */

/** One thread's fan-out: what the host emits, who hears it, and the tail of what passed. */
export interface EventChannel {
  /**
   * @invariant follow-snapshot-frames/held-until-first-subscriber Held until the first subscriber; never held after.
   * Records emitted before the FIRST subscriber (what an extension says during session_start: multi-account's
   * startup notify, a dialog a probe opens, an extension's `session_start` entry) are held and replayed to it with origin
   * `session-start`, so the browser sees them exactly as it saw pi's startup stdout over the pipe; the replay is
   * recorded again, as `replayed`, when it actually reaches a subscriber (see `subscribe`).
   *
   * Never between runs: the session lives across runs (#69) and each run subscribes its own pump, so holding
   * would replay an aborted run's `agent_settled` into the NEXT run's pump and end it before its first token (the
   * disconnect-then-prompt race). Once a subscriber has existed, an event with nobody listening is `dropped`, not
   * queued for the next one, like status heartbeats with no rpc client reading the pipe (#88).
   */
  readonly emit: (event: RuntimeEvent) => void
  /** Hear every observation from now on; what was held for the first subscriber is replayed to it first. */
  readonly subscribe: (onObservation: (observation: EnsoObservation) => void) => () => void
  /** The emitted tail (#97), a fresh copy. */
  readonly recent: () => EnsoThreadEvent[]
}

export function createEventChannel(): EventChannel {
  const listeners = new Set<(observation: EnsoObservation) => void>()
  const heldUntilFirstSubscriber: RuntimeEvent[] = []
  let hasHadSubscriber = false
  const emitted = createEventTail()

  function emit(event: RuntimeEvent): void {
    if (listeners.size === 0) {
      if (!hasHadSubscriber) {
        heldUntilFirstSubscriber.push(event)
        // Described as the observation it will become when replayed.
        const described = describeObservation(mapPiEvent(event, 'replayed'))
        emitted.record(described.type, described.name, 'held')
        return
      }
      const described = describeObservation(mapPiEvent(event, 'live'))
      emitted.record(described.type, described.name, 'dropped')
      return
    }
    const observation = mapPiEvent(event, 'live')
    const described = describeObservation(observation)
    emitted.record(described.type, described.name, 'live')
    for (const listener of listeners) listener(observation)
  }

  function subscribe(onObservation: (observation: EnsoObservation) => void): () => void {
    listeners.add(onObservation)
    hasHadSubscriber = true
    if (heldUntilFirstSubscriber.length > 0) {
      const held = heldUntilFirstSubscriber.splice(0)
      for (const event of held) {
        // The subscriber learns it is a replay (#96): the tail's `replayed` and the
        // observation's `origin` are the same fact, told once here by the mapper.
        const observation = mapPiEvent(event, 'replayed')
        const described = describeObservation(observation)
        emitted.record(described.type, described.name, 'replayed')
        onObservation(observation)
      }
    }
    return () => {
      listeners.delete(onObservation)
    }
  }

  return { emit, subscribe, recent: () => emitted.recent() }
}
