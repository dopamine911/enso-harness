import { expect, test } from 'bun:test'
import type { EnsoThreadCommands } from '@enso/core'
import { COMMANDS_SCHEMA_MISMATCH, CommandsFetchError, fetchThreadCommands } from '../commands-connection.ts'

/**
 * The palette's read (#338): the route's answer validated, a non-2xx said with its status and
 * body, a payload the schema refuses said as such. No DOM — a fetch seam and three responses.
 */

const LIVE: EnsoThreadCommands = {
  threadId: 'thread-1',
  commands: [{ name: 'mode', source: 'extension', description: 'switch the permission mode' }],
  source: 'live',
}

/** One canned response, and the URL it was asked for. */
function answering(response: Response): { fetch: (input: string) => Promise<Response>; asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    fetch: (input: string): Promise<Response> => {
      asked.push(input)
      return Promise.resolve(response)
    },
  }
}

test('a 2xx that matches the schema is returned as-is, from the thread-scoped route', async () => {
  const server = answering(Response.json(LIVE))
  await expect(fetchThreadCommands('thread 1/x', server.fetch)).resolves.toEqual(LIVE)
  expect(server.asked).toEqual(['/api/threads/thread%201%2Fx/commands'])
})

test('a non-2xx throws `<status> <body>` with the status as data', async () => {
  const server = answering(new Response('no such thread', { status: 404 }))
  const failure = await fetchThreadCommands('gone', server.fetch).catch((thrown: unknown) => thrown)
  expect(failure).toBeInstanceOf(CommandsFetchError)
  expect((failure as CommandsFetchError).status).toBe(404)
  expect((failure as Error).message).toBe('404 no such thread')
})

test('a payload the schema refuses is a schema error, not a rendered guess', async () => {
  const { source: _dropped, ...withoutSource } = LIVE
  const server = answering(Response.json(withoutSource))
  await expect(fetchThreadCommands('thread-1', server.fetch)).rejects.toThrow(COMMANDS_SCHEMA_MISMATCH)
})
