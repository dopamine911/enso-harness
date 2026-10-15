import { expect, test } from 'bun:test'
import { closePane, openBeside, singlePane } from '../pane-layout.ts'
import {
  readPageUrl,
  readPaneLayout,
  readThreadUrl,
  showsPage,
  urlForPage,
  urlForPanes,
  urlForThread,
  urlOpeningPanes,
} from '../thread-url.ts'

// The URL is the source of truth for the active thread (#142): what it names, and what it cannot.
// @pins resume/url-names-thread
test('a URL that names a thread id resumes it; none is a fresh page; one that cannot be a thread id is fresh AND said', () => {
  expect(readThreadUrl('?thread=6923e620-856a-4132-a9c8-1a2ff7d271f9&debug')).toEqual({
    kind: 'resume',
    threadId: '6923e620-856a-4132-a9c8-1a2ff7d271f9',
  })
  expect(readThreadUrl('')).toEqual({ kind: 'fresh' })
  expect(readThreadUrl('?debug&thread=')).toEqual({ kind: 'fresh' })
  const malformed = readThreadUrl('?thread=../etc/passwd')
  expect(malformed.kind).toBe('fresh')
  expect(malformed.kind === 'fresh' ? malformed.notice : '').toContain('../etc/passwd is not a thread id')
  expect(readThreadUrl('?thread=has%20space').kind).toBe('fresh')
})

test('writing a thread keeps every other parameter, in order, and replaces the thread that was there', () => {
  expect(urlForThread('?debug&log=debug', 't1')).toBe('?debug=&log=debug&thread=t1')
  expect(urlForThread('?thread=old&fixture', 't2')).toBe('?thread=t2&fixture=')
  expect(urlForThread('', 't3')).toBe('?thread=t3')
})

const THREAD = '6923e620-856a-4132-a9c8-1a2ff7d271f9'

// The pages beside the threads (#869): what `?page=` names, beside the thread, never in its place.
// @pins resume/url-names-page
test('a URL names a Settings section beside its thread; no section is the first; none, or an empty one, is no page', () => {
  expect(readPageUrl(`?thread=${THREAD}&page=settings&section=permissions`)).toEqual({
    kind: 'settings',
    section: 'permissions',
  })
  expect(readPageUrl('?page=settings&section=storage')).toEqual({ kind: 'settings', section: 'storage' })
  expect(readPageUrl('?page=settings')).toEqual({ kind: 'settings', section: 'appearance' })
  expect(readPageUrl('?page=settings&section=')).toEqual({ kind: 'settings', section: 'appearance' })
  // Today's links name a thread only: the thread is what is shown, and it is the thread it was.
  expect(readPageUrl(`?thread=${THREAD}&debug`)).toBeUndefined()
  expect(readThreadUrl(`?thread=${THREAD}&page=settings&section=storage`)).toEqual({ kind: 'resume', threadId: THREAD })
  expect(readPageUrl('?page=')).toBeUndefined()
})

// @pins resume/url-names-page
test('a URL names the Projects page beside its thread; it has no sections', () => {
  expect(readPageUrl(`?thread=${THREAD}&page=projects`)).toEqual({ kind: 'projects' })
  expect(readPageUrl('?page=projects&section=')).toEqual({ kind: 'projects' })
  expect(readPageUrl('?page=projects&section=storage')).toEqual({
    kind: 'not-found',
    asked: 'storage',
    within: 'projects',
  })
})

// @pins resume/url-names-page
test('a URL names the Add project page beside its thread; it has no sections (#872)', () => {
  expect(readPageUrl(`?thread=${THREAD}&page=add-project`)).toEqual({ kind: 'add-project' })
  expect(readPageUrl('?page=add-project&section=browse')).toEqual({
    kind: 'not-found',
    asked: 'browse',
    within: 'add-project',
  })
  const adding = urlForPage(`?thread=${THREAD}&page=projects`, { kind: 'add-project' })
  expect(adding).toBe(`?thread=${THREAD}&page=add-project`)
  expect(showsPage(adding, { kind: 'add-project' })).toBe(true)
  expect(showsPage(adding, { kind: 'projects' })).toBe(false)
})

// @pins resume/url-names-page
test('a URL names a project’s page and its tab beside its thread; no tab is Threads; a tab it has not is not found (#871)', () => {
  expect(readPageUrl(`?thread=${THREAD}&page=project&project=p-app&tab=worktrees`)).toEqual({
    kind: 'project',
    projectId: 'p-app',
    tab: 'worktrees',
  })
  expect(readPageUrl('?page=project&project=p-app')).toEqual({ kind: 'project', projectId: 'p-app', tab: 'threads' })
  // Whether a project has the id is the listing's to say: the page says when none has it.
  expect(readPageUrl('?page=project')).toEqual({ kind: 'project', projectId: '', tab: 'threads' })
  expect(readPageUrl('?page=project&project=p-app&tab=settings')).toEqual({
    kind: 'not-found',
    asked: 'settings',
    within: 'project',
  })
  const storage = urlForPage(`?thread=${THREAD}&page=settings&section=storage`, {
    kind: 'project',
    projectId: 'p-app',
    tab: 'storage',
  })
  expect(storage).toBe(`?thread=${THREAD}&page=project&project=p-app&tab=storage`)
  expect(showsPage(storage, { kind: 'project', projectId: 'p-app', tab: 'storage' })).toBe(true)
  expect(showsPage(storage, { kind: 'project', projectId: 'p-app', tab: 'threads' })).toBe(false)
  expect(showsPage(storage, { kind: 'project', projectId: 'p-other', tab: 'storage' })).toBe(false)
  expect(urlOpeningPanes(storage, singlePane('t2'))).toBe('?thread=t2')
})

// @pins resume/url-names-page
test('a page or a section Enso does not have is not found, with what was asked — never a guess at a page', () => {
  expect(readPageUrl('?page=settings&section=trees')).toEqual({ kind: 'not-found', asked: 'trees', within: 'settings' })
  expect(readPageUrl('?page=SETTINGS')).toEqual({ kind: 'not-found', asked: 'SETTINGS' })
  expect(readPageUrl('?page=Projects')).toEqual({ kind: 'not-found', asked: 'Projects' })
  // An own key only: what every object inherits is no page.
  expect(readPageUrl('?page=constructor')).toEqual({ kind: 'not-found', asked: 'constructor' })
  expect(readPageUrl('?page=__proto__')).toEqual({ kind: 'not-found', asked: '__proto__' })
  const long = readPageUrl(`?page=settings&section=${'x'.repeat(100)}`)
  expect(long?.kind === 'not-found' ? long.asked : '').toHaveLength(40)
})

// @pins resume/url-names-page
test('opening a page keeps the thread and every other parameter; opening a thread from it drops the page alone', () => {
  const onSettings = urlForPage(`?debug&thread=${THREAD}`, { kind: 'settings', section: 'appearance' })
  expect(onSettings).toBe(`?debug=&thread=${THREAD}&page=settings&section=appearance`)
  // Another section replaces the one before; it is never added beside it.
  expect(urlForPage(onSettings, { kind: 'settings', section: 'storage' })).toBe(
    `?debug=&thread=${THREAD}&page=settings&section=storage`,
  )
  expect(urlOpeningPanes(onSettings, singlePane('t2'))).toBe('?debug=&thread=t2')
  expect(urlOpeningPanes('?log=debug', singlePane('t3'))).toBe('?log=debug&thread=t3')
  // The page's own rewrite of its thread (a delete, a failed resume) keeps the page.
  expect(urlForThread(onSettings, 't4')).toBe('?debug=&thread=t4&page=settings&section=appearance')
  // A page with no sections writes none, and drops the section of the page it replaced.
  const onProjects = urlForPage(onSettings, { kind: 'projects' })
  expect(onProjects).toBe(`?debug=&thread=${THREAD}&page=projects`)
  expect(showsPage(onProjects, { kind: 'projects' })).toBe(true)
  expect(showsPage(onSettings, { kind: 'settings', section: 'storage' })).toBe(false)
  expect(showsPage(onSettings, { kind: 'settings', section: 'appearance' })).toBe(true)
})

const SECOND = '1b8f1c55-3f1e-4c1a-9a51-2f0a6c1d7e42'
const THIRD = 'c0ffee00-1234-4abc-8def-0123456789ab'

// Threads side by side (#938): `?thread=` stays the focused pane's, `?panes=` lists them all.
// @pins resume/url-names-panes
test('a URL names its panes beside the focused thread, which an old link without them opens alone (#938)', () => {
  expect(readPaneLayout(`?thread=${SECOND}&panes=${THREAD},${SECOND}`, SECOND)).toEqual({
    threadIds: [THREAD, SECOND],
    focused: 1,
  })
  // A link from before panes is its one thread.
  expect(readPaneLayout(`?thread=${THREAD}`, THREAD)).toEqual(singlePane(THREAD))
  // A list that does not hold the focused thread is not the page's: the thread alone.
  expect(readPaneLayout(`?thread=${THREAD}&panes=${SECOND},${THIRD}`, THREAD)).toEqual(singlePane(THREAD))
  // What cannot be a thread is left out, a thread twice is once, and no more than three are open.
  expect(
    readPaneLayout(`?thread=${THREAD}&panes=../etc,${THREAD},${SECOND},${THREAD},${THIRD},${'f'.repeat(36)}`, THREAD),
  ).toEqual({ threadIds: [THREAD, SECOND, THIRD], focused: 0 })
})

// @pins resume/url-names-panes
test('writing panes keeps every other parameter; one pane writes no list, and a reload reads back what was written (#938)', () => {
  const two = openBeside(singlePane(THREAD), SECOND)
  expect(two).toEqual({ threadIds: [THREAD, SECOND], focused: 1 })
  if (two === undefined) throw new Error('expected a second pane')
  const written = urlForPanes('?debug', two)
  expect(readThreadUrl(written)).toEqual({ kind: 'resume', threadId: SECOND })
  expect(readPaneLayout(written, SECOND)).toEqual(two)
  // Closing back to one pane takes the list away, and opening from a page drops the page alone.
  const one = urlForPanes(written, closePane(two, 0))
  expect(one).toBe(`?debug=&thread=${SECOND}`)
  expect(urlOpeningPanes(`${written}&page=settings&section=storage`, two)).toBe(written)
})
