import type { CDPSession } from '@playwright/test'
import { RAIL_NAME, RELATIVE_AGE_WORD } from './actions.ts'

/**
 * A wait until change without a page read a second (#740). The wait compared a whole-page
 * accessibility snapshot every second: 1,926 of them in a 42-minute run, a median 30 ms each and
 * linear in the page's size, and each one a traced action — 12.4 of a trace chunk's 16.2 MB. The
 * page now counts its own changes, and the recorder reads the count, one number, before it reads
 * the page: the snapshot is taken again only when the count moved. What a wait returns on is
 * unchanged — the snapshot, `pageForChange`'s way, differing from the baseline.
 */

/** Where the page's change mark is read: a property the counting script defines on `window`. */
const PAGE_CHANGES_MARK = '__arenaPageChanges'

/**
 * The page's count of its changes, installed before any page's own script in every document of every
 * tab (`addInitScript`): a `MutationObserver` over the whole document adds one per batch of
 * mutations, unless every mutation in the batch is one `pageForChange` masks — a text node in the
 * rail going from one relative age to another (`6s` → `1m`), Enso's clock ticking. Anything else
 * counts, a masked-looking word outside the rail included, so the count errs only towards one more
 * look. The mark reads `<the document's time origin>:<count>`: a new document never passes for the
 * old one at the same count. Records still queued when the mark is read are counted first.
 */
export const PAGE_CHANGES_SCRIPT = `(() => {
  const age = new RegExp(${JSON.stringify(`^${RELATIVE_AGE_WORD}$`)})
  const rail = ${JSON.stringify(`nav[aria-label="${RAIL_NAME}"], [role="navigation"][aria-label="${RAIL_NAME}"]`)}
  const masked = (record) =>
    record.type === 'characterData' &&
    age.test(record.oldValue ?? '') &&
    age.test(record.target.data) &&
    record.target.parentElement?.closest(rail) != null
  let changes = 0
  const count = (records) => {
    if (!records.every(masked)) changes += 1
  }
  const observer = new MutationObserver(count)
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    characterDataOldValue: true,
  })
  const documentMark = performance.timeOrigin + ':'
  // ⚠ CONFIGURABLE: the initial about:blank's window is reused by the same-origin document that
  // replaces it, so the script runs twice on one window. A fixed property threw "Cannot redefine
  // property" into the application's page, where the score read it as the application's error.
  Object.defineProperty(window, ${JSON.stringify(PAGE_CHANGES_MARK)}, {
    configurable: true,
    get: () => {
      count(observer.takeRecords())
      return documentMark + changes
    },
  })
})()`

/**
 * A page's change mark, read over its DevTools connection: `undefined` when it cannot be read within
 * `withinMs` — a document the script is not in (an error page), one between documents, a page
 * that does not answer.
 *
 * ⚠ NOT THROUGH `page.evaluate` (#740, measured on a traced context): each `page.evaluate` is a
 * traced action with a DOM snapshot before and after it, the very cost this replaces; a DevTools
 * `Runtime.evaluate` puts nothing in the trace.
 */
export async function readPageMark(devtools: CDPSession, withinMs: number): Promise<string | undefined> {
  let stopTimer = (): void => undefined
  const late = new Promise<undefined>((resolve) => {
    const timer = setTimeout(resolve, withinMs)
    stopTimer = () => clearTimeout(timer)
  })
  const read = devtools
    .send('Runtime.evaluate', { expression: PAGE_CHANGES_MARK, returnByValue: true })
    .then(({ result }): unknown => result.value)
    .catch(() => undefined)
  try {
    const mark = await Promise.race([read, late])
    return typeof mark === 'string' ? mark : undefined
  } finally {
    stopTimer()
  }
}

/** The page as a wait until change compares it, looked at only when it may have changed. */
export interface ArenaPageLook {
  /** Look at the page now: the page after the agent's move, a wait's baseline. */
  readonly now: () => Promise<string>
  /** The page as it is: the last look while the page's mark holds, a new look once it moved. */
  readonly current: () => Promise<string>
}

/**
 * The page's looks, each kept with the change mark read just before it.
 *
 * ⚠ THE MARK IS READ BEFORE THE LOOK: a mutation between the two is in the look and moves the mark,
 * so the next `current` looks again and finds the page it already has — one look too many, never a
 * change missed. A mark that cannot be read is always a look.
 *
 * ⚠ AND AGAIN EVERY `recheckMs`: the DOM is not all a snapshot reads. A script setting a field's
 * `value` mutates nothing (measured) yet changes the textbox's line, and so would a style rule
 * inserted through the CSSOM; the last look is taken again once it is that old, so such a change is
 * seen late rather than never.
 */
export function createPageLook(options: {
  readonly look: () => Promise<string>
  readonly mark: () => Promise<string | undefined>
  readonly recheckMs: number
  readonly now?: () => number
}): ArenaPageLook {
  const now = options.now ?? Date.now
  let last: { readonly mark: string; readonly page: string; readonly at: number } | undefined
  const lookAt = async (mark: string | undefined): Promise<string> => {
    const at = now()
    const page = await options.look()
    last = mark === undefined ? undefined : { mark, page, at }
    return page
  }
  return {
    now: async () => lookAt(await options.mark()),
    current: async () => {
      const mark = await options.mark()
      if (last !== undefined && mark === last.mark && now() - last.at < options.recheckMs) return last.page
      return lookAt(mark)
    },
  }
}
