import { expect, test } from 'bun:test'
import { readThreadUrl, urlForThread } from '../thread-url.ts'

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
