import type { ServerResponse } from 'node:http'
import type { EnsoRunStatesFrame, EnsoThreadRunState } from '@enso/core'
import { SSE_HEADERS, startSseKeepalive } from './sse.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/run-states` (#911): every thread's run, as it moves — what a page needs to stop saying
 * a thread it has NOT opened runs, at the moment the server releases it.
 *
 * A page follows the threads it has open (`…/follow`), and their status bar, rail row and header
 * hear a run end on that follow. A thread it has not opened is a stored row, whose `busy` and
 * `waiting` came from `/api/stored-threads` when the page last read it; before this route nothing
 * told the page when such a run ended, and its row and its closed project's signal (#876) said
 * running until the page's own run settled or it reloaded — measured, never within 20 s.
 *
 * One `run-states` frame of every thread the server holds, read in the same tick as the watch, so
 * no change falls between; then one `run-state` per build, take, release or drop
 * (`ThreadRegistry.watchRunStates`). Only reads: builds nothing, writes no record.
 */
export function followRunStates(threads: ThreadRegistry, response: ServerResponse, sseKeepaliveMs: number): void {
  response.writeHead(200, SSE_HEADERS)
  const stopKeepalive = startSseKeepalive(response, sseKeepaliveMs)
  const write = (frame: EnsoRunStatesFrame): void => {
    if (response.destroyed || response.writableEnded) return
    response.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  const watch = threads.watchRunStates((state: EnsoThreadRunState) => write({ type: 'run-state', ...state }))
  const stop = (): void => {
    stopKeepalive()
    watch.unsubscribe()
  }
  response.once('close', stop)
  // A client gone before the hook existed has fired `close` already: the watch would outlive it.
  if (response.destroyed || response.writableEnded) {
    stop()
    return
  }
  write({ type: 'run-states', threads: [...watch.states] })
}
