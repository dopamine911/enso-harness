import type { EnsoModelChoice, EnsoModelState, EnsoPermissionModeState, EnsoSessionUsage } from '@enso/core'
import { livePermissionModeState } from './permission-mode-adapter.ts'
import type { RuntimeEvent } from './runtime-event.ts'
import type { ThreadLog } from './thread-log.ts'

/**
 * What a live thread says about itself as the host's own events (#45, #338 slice 2, #496): its model
 * and thinking level, its spend and context, its permission mode — each read NOW, and each said once
 * per change. Over a port in our words (#801): the runtime's live readings, adapted by
 * `hosted-thread.ts`, so nothing here names it.
 */

/** A live thread's readings off its runtime (#801), read on every call. */
export interface ThreadReadings {
  /** The model the thread runs; none for the runtime's stand-in when no model could be chosen. */
  readonly model: () => EnsoModelChoice | undefined
  readonly thinkingLevel: () => string
  /** The levels the current model offers — the runtime's whole list when there is no model. */
  readonly availableThinkingLevels: () => string[]
  /** The thread's totals and context, whole (#45). */
  readonly usage: () => EnsoSessionUsage
  /** The command names the thread's extensions registered. */
  readonly registeredCommands: () => readonly string[]
}

/** What the announcements read and where they say it (#801). */
export interface AnnouncementsHost {
  readonly readings: ThreadReadings
  readonly threadLog: ThreadLog
  readonly emit: (event: RuntimeEvent) => void
}

/** The thread's state NOW, and the events that say it once per change (#801). */
export interface ThreadAnnouncements {
  readonly currentPermissionModeState: () => EnsoPermissionModeState
  readonly currentModelState: () => EnsoModelState
  readonly announceSessionUsage: () => void
  readonly announceModelState: () => void
}

export function createThreadAnnouncements(host: AnnouncementsHost): ThreadAnnouncements {
  const { readings, threadLog, emit } = host

  /**
   * The mode NOW (#84, #496): the last `active_agent` entry among the log's ENTRIES, the walk the
   * permission engine itself makes, re-run on every call (see the adapter). The dropdown offers the
   * modes AS REGISTERED: the permission-modes extension names one command per mode, exactly after it,
   * so the intersection is a name lookup. Read off the registry directly rather than through
   * `listCommands` — that call's count is a contract the refusal path's tests pin, and this is not a
   * refusal lookup.
   */
  function currentPermissionModeState(): EnsoPermissionModeState {
    return livePermissionModeState(threadLog.everyEntry(), new Set(readings.registeredCommands()))
  }

  /** The model and thinking level NOW (#338 slice 2): `model` is `null` when the thread runs none. */
  function currentModelState(): EnsoModelState {
    const model = readings.model()
    return {
      model: model === undefined ? null : { provider: model.provider, id: model.id, name: model.name },
      thinkingLevel: readings.thinkingLevel(),
      availableThinkingLevels: readings.availableThinkingLevels(),
    }
  }

  /**
   * Say the thread's totals and context as the host's own event (#45), ONCE per change — the
   * runtime's stats, whole, never a delta, so a follower applies the latest and cannot double-count.
   * Said after each event `growsSessionSpend` names (`session-usage.ts` says why those and not
   * `message_end`), and on a model change.
   */
  let announcedSessionUsage: string | undefined
  function announceSessionUsage(): void {
    const usage = readings.usage()
    const serialized = JSON.stringify(usage)
    if (serialized === announcedSessionUsage) return
    announcedSessionUsage = serialized
    emit({ type: 'session_usage', ...usage })
  }

  /**
   * Say the model state as the host's own event, ONCE per change. A `/model` reaches here up to
   * three times — `thinking_level_changed` when the new model clamps the level, `model_select`, and
   * the command's own call — and every arrival reads the same state; the feed hears one.
   */
  let announcedModelState: string | undefined
  function announceModelState(): void {
    const state = currentModelState()
    const serialized = JSON.stringify(state)
    if (serialized === announcedModelState) return
    announcedModelState = serialized
    emit({ type: 'model', ...state })
    // A new model is a new context window: the usage's `context` moved with it.
    announceSessionUsage()
  }

  return { currentPermissionModeState, currentModelState, announceSessionUsage, announceModelState }
}
