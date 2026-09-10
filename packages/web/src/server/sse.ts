import type { ServerResponse } from 'node:http'
import { zenLogger } from '@zen/core'

/**
 * The SSE plumbing every streaming route shares: the response headers and the keepalive.
 * Lifted out of `index.ts` so the follow route (SPIKE #109) can use them without importing
 * the dispatcher.
 */

const log = zenLogger('server', 'sse')

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // The dev web surface proxies `/api` in dev, so this is the same origin — but a stray
  // buffering proxy would hold the stream open and silent, which looks exactly like a hung agent.
  'X-Accel-Buffering': 'no',
} as const

/**
 * How often an open response carries an SSE comment while no event is flowing.
 *
 * ⚠⚠ THE ACTUAL CAUSE OF #98/#99. `Bun.serve` closes an HTTP connection after 10 s of
 * inactivity by default (`idleTimeout`), and the dev web surface proxies `/api` through one.
 * A tool call has NO AG-UI event for its progress (`to-agui.ts`), so a search that took
 * 12 s put no byte on the wire for 12 s, the proxy dropped the connection, the browser saw
 * "Stream response body read failed", and the server's close hook aborted pi mid-call —
 * which is the `AbortError` the tool's audit line showed. The 90 s no-progress cutoff was
 * never reached; it would have ended the run cleanly with RUN_FINISHED, not a read failure.
 *
 * An SSE comment line (`: keepalive`) is the protocol's own answer: every intermediary sees
 * bytes, every client ignores it (TanStack's parser skips `:` lines). Well under the 10 s
 * default so a missed tick does not matter; cleared when the response ends.
 */
export const SSE_KEEPALIVE_MS = 5000

/**
 * Start the keepalive for one open response; returns the stop. Not an event, so not in the
 * sent tail.
 *
 * ⚠ The timer is GUARANTEED to fire in the window between a client's disconnect and the
 * handler's `finally` (pi is being torn down asynchronously in between), and a write on a
 * destroyed response emits `'error'` — with no listener, that is an uncaught exception in
 * the server (PR #108 review). So: the response's own `'close'` stops the timer, a tick
 * that finds the response gone stops itself instead of writing, and an `'error'` on the
 * response is reported rather than thrown.
 */
export function startSseKeepalive(response: ServerResponse, intervalMs: number): () => void {
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded) {
      clearInterval(timer)
      return
    }
    response.write(': keepalive\n\n')
  }, intervalMs)
  timer.unref?.()
  const stop = (): void => clearInterval(timer)
  response.once('close', stop)
  response.on('error', (error: unknown) => log.warn('SSE response error after the client left: {error}', { error }))
  return stop
}
