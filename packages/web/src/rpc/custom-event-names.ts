/**
 * The AG-UI CUSTOM chunk names zen puts on the wire — the contract between the server-side
 * mapper (`to-agui.ts`, which emits them) and the browser router (`custom-event-router.ts`,
 * which dispatches on them). Declared ONCE here so a rename cannot land on one side only:
 * before this module each side carried its own string literals, and renaming `zen.entry`
 * in the browser left the suite green while every mode line silently stopped rendering
 * (#53 S1.3 — the #29 class, one hop upstream of where #29 was fixed).
 */

/** A `notify` ui-request: a message meant for a human. Value: the `extension-ui-request` observation. */
export const ZEN_CUSTOM_EVENT_NOTIFY = "zen.notify";
/** One completed request's accounting (#45). Value: the `message-usage` observation. */
export const ZEN_CUSTOM_EVENT_USAGE = "zen.usage";
/** An extension persisted a custom session entry (#29). Value: the `custom-entry` observation. */
export const ZEN_CUSTOM_EVENT_ENTRY = "zen.entry";
/** A pi event this surface does not model yet — carried, never dropped. Value: the raw event. */
export const ZEN_CUSTOM_EVENT_UNMAPPED = "zen.unmapped";
