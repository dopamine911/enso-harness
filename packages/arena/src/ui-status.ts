import { ENSO_UI_EVENTS, EnsoThreadStatusEvent } from '@enso/core'
import { Check } from 'typebox/value'
import type { ArenaStatusLog } from './actions.ts'
import type { ArenaEventBody } from './timeline.ts'

/** Where one UI event came from (#737): its name and `detail` as the page sent them, and the tab it was sent from. */
export interface ArenaUiEvent {
  readonly name: unknown
  readonly detail: unknown
  /** The tab of the page that sent it; undefined for a page that is not one of the run's tabs. */
  readonly tab: number | undefined
}

/** Where a heard thread status goes: the status log a wait reads, and the timeline. */
export interface ArenaStatusEars {
  readonly log: Pick<ArenaStatusLog, 'record'>
  /** A line on the timeline, placed at the tab it came from. */
  readonly record: (body: ArenaEventBody, tab: number) => void
  readonly redact: (text: string) => string
}

/**
 * One event the page forwarded through the recorder's binding (#737). Only a shown pane's thread
 * status counts, and only once it checks against the schema: a page on another origin in the same
 * context (a preview, #713) can call the binding too, and a hidden pane's bar is not what the
 * person sees. It goes to the status log, then the timeline, the question's title redacted.
 */
export function hearUiEvent(event: ArenaUiEvent, ears: ArenaStatusEars): void {
  const { name, detail, tab } = event
  if (name !== ENSO_UI_EVENTS.threadStatus || !Check(EnsoThreadStatusEvent, detail) || !detail.shown) return
  if (tab === undefined) return
  ears.log.record(tab, detail)
  ears.record(
    {
      kind: 'thread-status',
      status: detail.status,
      ...(detail.question === undefined ? {} : { question: ears.redact(detail.question.title) }),
    },
    tab,
  )
}
