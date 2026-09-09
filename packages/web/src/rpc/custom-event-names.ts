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
/** One completed message's accounting (#45). Value: a `message-end` observation that carries `usage`. */
export const ZEN_CUSTOM_EVENT_USAGE = "zen.usage";
/** What waits behind the run in flight (#75). Value: the `queue` observation. */
export const ZEN_CUSTOM_EVENT_QUEUE = "zen.queue";
/**
 * A blocking question pi is waiting on (#112). Value: `{ id, dialog: ZenDialogSpec }`. The
 * browser renders it and answers with `POST /api/threads/:id/dialog`; nothing on the run
 * ends or resumes for it.
 */
export const ZEN_CUSTOM_EVENT_DIALOG = "zen.dialog";
/**
 * A blocking question stopped waiting (#114). Value: `{ id, outcome: ZenDialogOutcome }`.
 * The browser drops the card if it shows this id — whoever answered, by whatever path.
 */
export const ZEN_CUSTOM_EVENT_DIALOG_SETTLED = "zen.dialog-settled";
/**
 * The questions pi is blocked on as of a snapshot (#114) — the COMPLETE list, so the
 * browser replaces what it shows rather than adds to it: a reconnect's snapshot is the
 * resync, and a card for a question settled while the page was away must not survive it.
 * Value: `{ open: ZenOpenDialog[] }`.
 */
export const ZEN_CUSTOM_EVENT_OPEN_DIALOGS = "zen.open-dialogs";
/**
 * The follow ended without this page leaving it (#103 receipt): the server closed, restarted,
 * or dropped the connection. Value: `{ threadId }`. The page says so; the debug pane
 * refetches, so a session the server no longer holds is not shown as its last fetch.
 */
export const ZEN_CUSTOM_EVENT_FOLLOW_ENDED = "zen.follow-ended";
/** An extension persisted a custom session entry (#29). Value: the `custom-entry` observation. */
export const ZEN_CUSTOM_EVENT_ENTRY = "zen.entry";
/**
 * The permission mode a run STARTS in, plus the modes the dropdown may offer (#84). A
 * state receipt the SERVER synthesises at run start — not a pi event — because picc only
 * persists a `modes` entry on a change, so a fresh thread's `default` never crosses on
 * its own. Value: `{ mode: string, available: string[] }`.
 */
export const ZEN_CUSTOM_EVENT_MODE = "zen.mode";
/**
 * Which server-side acquisition of the thread this run holds (#109). A state receipt the
 * SERVER synthesises at run start, beside `zen.mode`: the browser keeps the value, and the
 * debug pane compares it with the server's current `generation` — the two differ exactly
 * when a run this page did not make has moved the thread on. Value: `{ generation: number }`.
 */
export const ZEN_CUSTOM_EVENT_RUN = "zen.run";
/** A pi event this surface does not model yet — carried, never dropped. Value: the raw event. */
export const ZEN_CUSTOM_EVENT_UNMAPPED = "zen.unmapped";
