import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { DEFAULT_RISK_THRESHOLDS } from '@enso/core'
import type { StoredThreadRead } from '../../host/agent-host.ts'
import { followThread } from '../follow.ts'
import { createProjectRegistry } from '../projects.ts'
import { createThreadRegistry, type ThreadRegistry } from '../thread-registry.ts'
import { createFakeAgentHost } from './fake-hosted-thread.ts'

/** A response the test closes by hand, as a browser tab closing does. */
function closableResponse(): { response: ServerResponse; close: () => void } {
  const emitter = new EventEmitter()
  let destroyed = false
  let writableEnded = false
  // Getters DEFINED, not assigned: `Object.assign` would copy their value once.
  Object.defineProperties(emitter, {
    destroyed: { get: () => destroyed },
    writableEnded: { get: () => writableEnded },
    writeHead: { value: () => emitter },
    write: { value: () => true },
    end: {
      value: () => {
        writableEnded = true
        return emitter
      },
    },
  })
  return {
    response: emitter as unknown as ServerResponse,
    close: () => {
      destroyed = true
      emitter.emit('close')
    },
  }
}

// #160 §6: a follow of a COLD thread awaits the stored read before it subscribes and attaches its
// `close` listener. A tab that closed during that read had already fired `close`, so the listener
// never ran and the subscription stayed in the feed for the life of the process — the state the
// registry's own comment says must not persist, and one per abandoned page load.
test('⚠ a follow whose client left during the stored read leaves no subscription behind (#160 §6)', async () => {
  const read = Promise.withResolvers<StoredThreadRead | undefined>()
  const host = {
    ...createFakeAgentHost(() => Promise.reject(new Error('no session is built by a follow'))),
    readStoredThread: () => read.promise,
    storedThreadDirectory: () => Promise.resolve(undefined),
  }
  const registry = createThreadRegistry({ createSession: (threadId) => host.createSession(threadId, tmpdir) })
  let open = 0
  const threads: ThreadRegistry = {
    ...registry,
    observe: (threadId, listener) => {
      const follow = registry.observe(threadId, listener)
      open += 1
      return {
        ...follow,
        unsubscribe: () => {
          open -= 1
          follow.unsubscribe()
        },
      }
    },
  }
  const projects = createProjectRegistry({ launchDirectory: tmpdir(), roots: [] })
  const { response, close } = closableResponse()

  const following = followThread(
    { threads, host, projects, riskThresholds: DEFAULT_RISK_THRESHOLDS, sseKeepaliveMs: 60_000 },
    'cold-1',
    response,
  )
  close()
  read.resolve(undefined)
  await following

  expect(open).toBe(0)
})
