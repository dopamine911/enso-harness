import { expect, test } from 'bun:test'
import { fetchLibraryPrompt, fetchPromptLibrary } from '../prompt-library-connection.ts'

/**
 * #443: the Start dialog's library reads never throw — a failure is words the dialog shows beside the
 * field, and pi's default still starts. Each way a read fails is said as itself.
 */

const answering = (response: Response) => (): Promise<Response> => Promise.resolve(response)
const unreachable = (): Promise<Response> => Promise.reject(new Error('connection refused'))

test('a listing the server refuses is its reason; an empty refusal says the status; a payload off its schema says so; a dead server says why', async () => {
  expect(await fetchPromptLibrary(answering(new Response('no library here', { status: 404 })))).toEqual({
    kind: 'unavailable',
    detail: 'no library here',
  })
  expect(await fetchPromptLibrary(answering(new Response('', { status: 500 })))).toEqual({
    kind: 'unavailable',
    detail: 'the server answered 500',
  })
  expect(await fetchPromptLibrary(answering(Response.json({ prompts: 'none' })))).toEqual({
    kind: 'unavailable',
    detail: "the server's prompt listing did not match its schema",
  })
  expect(await fetchPromptLibrary(unreachable)).toEqual({ kind: 'unavailable', detail: 'connection refused' })
})

test('one prompt: its reason, a payload off its schema, a dead server — and the id is encoded into the path', async () => {
  const asked: string[] = []
  const recording = (input: string): Promise<Response> => {
    asked.push(input)
    return Promise.resolve(new Response('reviewer.md: frontmatter has no name', { status: 422 }))
  }
  expect(await fetchLibraryPrompt('a b', recording)).toEqual({
    kind: 'unavailable',
    detail: 'reviewer.md: frontmatter has no name',
  })
  expect(asked).toEqual(['/api/prompts/a%20b'])
  expect(await fetchLibraryPrompt('x', answering(Response.json({ id: 'x' })))).toEqual({
    kind: 'unavailable',
    detail: "the server's prompt did not match its schema",
  })
  expect(await fetchLibraryPrompt('x', () => Promise.reject('down'))).toEqual({ kind: 'unavailable', detail: 'down' })
})
