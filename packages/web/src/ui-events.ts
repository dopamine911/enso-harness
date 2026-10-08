import { ENSO_UI_EVENTS, type EnsoThreadStatusEvent } from '@enso/core'

/**
 * The page's side of UI events (#737, core's `ui-events.ts`): a component announces a state it
 * renders by dispatching a `CustomEvent` on `document`, named from `ENSO_UI_EVENTS` and carrying
 * the `detail` core types for that name. Dispatched from an effect, after the commit that shows
 * the state: a listener that then reads the page finds what the event says.
 *
 * Typed per name, so the dispatcher and a listener in this app agree with core's schema at
 * compile time; the arena validates what reaches it against the same schema at run time.
 */

/** Each event name's `detail`. */
export interface EnsoUiEventDetails {
  readonly [ENSO_UI_EVENTS.threadStatus]: EnsoThreadStatusEvent
}

/** Announce `detail` under `name` on `document`; nothing outside a document (a static render). */
export function announceUiEvent<Name extends keyof EnsoUiEventDetails>(
  name: Name,
  detail: EnsoUiEventDetails[Name],
): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent(name, { detail }))
}
