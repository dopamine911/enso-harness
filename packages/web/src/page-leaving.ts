/**
 * Whether this page is going away (#664): a reload, a navigation, a closed tab.
 *
 * The browser cuts every open stream as the page leaves, and nothing in the page aborted them: a
 * follow reading its stream saw `TypeError: network error` and logged "the follow failed" — a
 * warning in Enso's log for every reload. `beforeunload` comes first, before the streams are cut;
 * `pagehide` covers a leave without it. Enso registers no `beforeunload` prompt, so nothing can
 * cancel the leave once it is set. `pageshow` clears it: a page restored from the back/forward
 * cache is staying, and a failure then is a failure.
 */

let leaving = false

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('beforeunload', () => {
    leaving = true
  })
  globalThis.addEventListener('pagehide', () => {
    leaving = true
  })
  globalThis.addEventListener('pageshow', () => {
    leaving = false
  })
}

/** True from the moment the page starts to leave, until it is shown again. */
export function pageLeaving(): boolean {
  return leaving
}
