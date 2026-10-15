import { useSyncExternalStore } from 'react'
import { everyHeldThread, type ProjectThread, type ProjectThreadsContext, projectOf } from './project-list.ts'

/**
 * Threads side by side (#938): up to three panes on the page, from any projects, one of them focused.
 * The focused pane holds the page's one live composer (#707) and the header; the others keep
 * streaming beside it. Pure: the page (`chat-screen.tsx`) keeps the layout, the URL says it
 * (`thread-url.ts`), and these say what each way of opening, focusing and closing a pane makes of it.
 */

/** The most panes a page shows at once: three follows on screen stay inside the page's budget of four (#272). */
export const MAX_PANES = 3

/** The window widths two and three panes fit side by side from (#938, the prototype's); below, the panes are tabs. */
const WIDTH_FOR_TWO_PANES = 1024
const WIDTH_FOR_THREE_PANES = 1440

/** What a page has open: its panes' threads, left to right, and which one is focused. */
export interface PaneLayout {
  /** Distinct thread ids, at most {@link MAX_PANES}; empty only while the URL's thread is being adopted. */
  readonly threadIds: readonly string[]
  /** The focused pane's index in `threadIds`. */
  readonly focused: number
}

/** No pane yet: the page is adopting the thread its URL names. */
export const NO_PANES: PaneLayout = { threadIds: [], focused: 0 }

/** One pane, showing `threadId`. */
export function singlePane(threadId: string): PaneLayout {
  return { threadIds: [threadId], focused: 0 }
}

/** The focused pane's thread, or undefined while there is no pane. */
export function focusedThread(layout: PaneLayout): string | undefined {
  return layout.threadIds[layout.focused]
}

/** The panes `threadIds` names, focused on `focusedId`: one pane of it alone when the list does not hold it. */
export function paneLayoutOf(threadIds: readonly string[], focusedId: string): PaneLayout {
  const distinct = [...new Set(threadIds)].slice(0, MAX_PANES)
  const focused = distinct.indexOf(focusedId)
  return focused === -1 ? singlePane(focusedId) : { threadIds: distinct, focused }
}

/**
 * A plain open — a rail row, a fork, a project's thread: the pane already showing it is focused;
 * otherwise it takes the focused pane's place, the other panes kept.
 */
export function openInFocused(layout: PaneLayout, threadId: string): PaneLayout {
  const at = layout.threadIds.indexOf(threadId)
  if (at !== -1) return { ...layout, focused: at }
  if (layout.threadIds.length === 0) return singlePane(threadId)
  const threadIds = layout.threadIds.with(layout.focused, threadId)
  return { threadIds, focused: layout.focused }
}

/**
 * Open beside (#938): a new pane right of the focused one, focused. A thread already in a pane is
 * focused there; with every pane taken it is undefined — the page says why, and opens nothing.
 */
export function openBeside(layout: PaneLayout, threadId: string): PaneLayout | undefined {
  const at = layout.threadIds.indexOf(threadId)
  if (at !== -1) return { ...layout, focused: at }
  if (layout.threadIds.length >= MAX_PANES) return undefined
  const insertAt = Math.min(layout.focused + 1, layout.threadIds.length)
  return { threadIds: layout.threadIds.toSpliced(insertAt, 0, threadId), focused: insertAt }
}

/** Focus the pane at `index`; one the layout does not have changes nothing. */
export function focusPane(layout: PaneLayout, index: number): PaneLayout {
  return index >= 0 && index < layout.threadIds.length ? { ...layout, focused: index } : layout
}

/**
 * Close the pane at `index`. The last pane is never closed — the page always shows a thread; the
 * focus stays on its thread, or moves to the pane that takes the closed one's place.
 */
export function closePane(layout: PaneLayout, index: number): PaneLayout {
  if (layout.threadIds.length < 2 || index < 0 || index >= layout.threadIds.length) return layout
  const threadIds = layout.threadIds.toSpliced(index, 1)
  if (index < layout.focused) return { threadIds, focused: layout.focused - 1 }
  return { threadIds, focused: Math.min(layout.focused, threadIds.length - 1) }
}

/**
 * `gone`'s pane given to `next` (a delete, #663): `next` already in a pane is focused there and
 * `gone`'s pane closes; otherwise `next` takes `gone`'s place, focused.
 */
export function replacePane(layout: PaneLayout, gone: string, next: string): PaneLayout {
  const at = layout.threadIds.indexOf(gone)
  if (at === -1) return openInFocused(layout, next)
  const already = layout.threadIds.indexOf(next)
  if (already === -1) return { threadIds: layout.threadIds.with(at, next), focused: at }
  return closePane({ ...layout, focused: already }, at)
}

/**
 * The widths two and three panes fit from, as media queries: in rems, so 1024 and 1440 pixels at the
 * browser's default 16-pixel font and wider with a larger one. The count is read from these same
 * queries, never `innerWidth`, so it changes exactly when they fire.
 */
const PANE_QUERIES = [WIDTH_FOR_TWO_PANES, WIDTH_FOR_THREE_PANES].map((width) => `(min-width: ${width / 16}rem)`)

/** How many panes fit side by side in the window: one, and one more for each width it reaches. */
function panesThatFit(): number {
  return 1 + PANE_QUERIES.filter((query) => window.matchMedia(query).matches).length
}

/** The widths the count changes at, watched: a resize that crosses none re-renders nothing. */
function subscribeToWidth(changed: () => void): () => void {
  const queries = PANE_QUERIES.map((query) => window.matchMedia(query))
  for (const query of queries) query.addEventListener('change', changed)
  return () => {
    for (const query of queries) query.removeEventListener('change', changed)
  }
}

/** How many panes the window fits side by side, kept current as it is resized. */
export function usePanesThatFit(): number {
  return useSyncExternalStore(subscribeToWidth, panesThatFit, () => 1)
}

/** Side by side when every pane fits; tabs when they don't; one pane needs neither. */
export function sideBySide(layout: PaneLayout, fit: number): boolean {
  return layout.threadIds.length > 1 && layout.threadIds.length <= fit
}

/** How many threads the header's split menu offers to open beside (#938). */
const SPLIT_MENU_THREADS = 6

/** A thread the split menu offers (#938): where it is, what it reads as, its project and its state. */
export interface BesideRow extends ProjectThread {
  readonly title: string | undefined
  readonly projectId: string | undefined
  readonly projectTitle: string | undefined
  readonly state: 'waiting' | 'running' | 'idle'
}

/** A held thread as the split menu reads it: the page's summary when it is open here, else the server's row. */
function besideRow(thread: ProjectThread, context: ProjectThreadsContext): BesideRow {
  const row =
    context.pageThreads.find((summary) => summary.threadId === thread.threadId) ??
    context.stored.find((stored) => stored.threadId === thread.threadId)
  let state: BesideRow['state'] = 'idle'
  if (row?.busy === true) state = 'running'
  if (row?.waiting === true) state = 'waiting'
  return {
    ...thread,
    title: row?.name ?? row?.title,
    projectId: row?.projectId,
    projectTitle: projectOf(context.projects, row?.projectId)?.title,
    state,
  }
}

/**
 * What the header's split menu offers to open beside (#938): threads that hold something and are in
 * no pane — each project's latest first, so a thread in another project is one pick away, then the
 * rest, most recent first.
 */
export function besideRows(context: ProjectThreadsContext, open: readonly string[]): BesideRow[] {
  const inPanes = new Set(open)
  const free = everyHeldThread(context)
    .filter((thread) => !inPanes.has(thread.threadId))
    .map((thread) => besideRow(thread, context))
  const seen = new Set<string | undefined>()
  const latest = new Set<BesideRow>()
  for (const row of free) {
    if (seen.has(row.projectId)) continue
    seen.add(row.projectId)
    latest.add(row)
  }
  return [...latest, ...free.filter((row) => !latest.has(row))].slice(0, SPLIT_MENU_THREADS)
}
