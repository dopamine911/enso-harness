import { expect, test } from 'bun:test'
import { readPageUrl, readThreadUrl, urlForPage, urlForThread, urlOpeningThread } from '../thread-url.ts'

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
test('a page or a section Enso does not have is not found, with what was asked — never a guess at a page', () => {
  expect(readPageUrl('?page=settings&section=trees')).toEqual({ kind: 'not-found', asked: 'trees', within: 'settings' })
  expect(readPageUrl('?page=SETTINGS')).toEqual({ kind: 'not-found', asked: 'SETTINGS' })
  expect(readPageUrl('?page=projects&section=storage')).toEqual({ kind: 'not-found', asked: 'projects' })
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
  expect(urlOpeningThread(onSettings, 't2')).toBe('?debug=&thread=t2')
  expect(urlOpeningThread('?log=debug', 't3')).toBe('?log=debug&thread=t3')
  // The page's own rewrite of its thread (a delete, a failed resume) keeps the page.
  expect(urlForThread(onSettings, 't4')).toBe('?debug=&thread=t4&page=settings&section=appearance')
})
