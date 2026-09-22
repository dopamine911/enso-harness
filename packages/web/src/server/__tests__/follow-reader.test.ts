import { afterEach, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { openFollow, WireSchemaViolation } from './follow-reader.ts'

/**
 * The double's own contract (#231). `follow-reader.ts` claims "a shape the browser could
 * not read fails the test that produced it"; until this file nothing enforced the claim —
 * the `Check` threw inside the reader's own `try` and the `catch` beside it discarded the
 * error, so a malformed frame surfaced as a bun-test timeout with no diagnosis, or as a
 * green test that never awaited another frame.
 *
 * The follow is served here by a bare `Bun.serve` rather than the enso server: these are
 * properties of the READER, and the only way to put a frame the server cannot type on the
 * wire is to write the bytes directly.
 */

const servers: Array<Server<undefined>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/**
 * An SSE endpoint that writes `lines` and then holds the stream open, exactly as the real
 * follow does between frames — so a reader that never reports is a reader that hangs.
 */
function sseServer(lines: string): Server<undefined> {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller: ReadableStreamDefaultController<Uint8Array>): void {
            controller.enqueue(new TextEncoder().encode(lines))
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  })
  servers.push(server)
  return server
}

const urlOf = (server: Server<undefined>): string => `http://localhost:${server.port}`

const STATUS = JSON.stringify({ type: 'status', live: false, busy: false, generation: 0 })

test('a frame that satisfies EnsoFollowFrame is recorded and awaited by count', async () => {
  const follow = await openFollow(urlOf(sseServer(`: keepalive\ndata: ${STATUS}\n\n`)), 't1')
  await follow.untilFrames(1)
  expect(follow.frames[0]).toEqual({ type: 'status', live: false, busy: false, generation: 0 })
  expect(follow.comments()).toBe(1)
  expect(follow.failure()).toBeUndefined()
  follow.close()
})

test('a frame off the wire that fails EnsoFollowFrame rejects the await that asked for it', async () => {
  // Typechecks nowhere: `generation` is required, and this is what a required field left
  // `undefined` looks like once `JSON.stringify` has dropped it.
  const malformed = JSON.stringify({ type: 'status', live: true, busy: false })
  const follow = await openFollow(urlOf(sseServer(`data: ${malformed}\n\n`)), 't1')
  await expect(follow.untilFrames(1)).rejects.toBeInstanceOf(WireSchemaViolation)
  expect(follow.failure()?.message).toContain('"type":"status"')
  // Fail fast: a later await is refused too, even for a count already reached.
  await expect(follow.untilComments(0)).rejects.toBeInstanceOf(WireSchemaViolation)
  follow.close()
})

test('a follow whose transport dies reports that error, not a schema violation', async () => {
  const server = sseServer(`data: ${STATUS}\n\n`)
  const follow = await openFollow(urlOf(server), 't1')
  await follow.untilFrames(1)
  // The server goes away under an open follow — the fault the bare `catch` used to hide.
  server.stop(true)
  await follow.ended()
  const failure = follow.failure()
  expect(failure).toBeDefined()
  expect(failure).not.toBeInstanceOf(WireSchemaViolation)
  await expect(follow.untilFrames(2)).rejects.toBe(failure)
  follow.close()
})

test('the test closing its own follow is not a failure', async () => {
  const follow = await openFollow(urlOf(sseServer(`data: ${STATUS}\n\n`)), 't1')
  await follow.untilFrames(1)
  follow.close()
  // The reader's own signal, not a delay: it resolves once the aborted read has been absorbed.
  await follow.ended()
  expect(follow.failure()).toBeUndefined()
})
