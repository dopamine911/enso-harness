import { ensoLogger, EnsoRunStatesFrame } from '@enso/core'
import { Compile } from 'typebox/compile'
import { sleep } from './abortable-sleep.ts'
import { readSseFrames } from './follow-connection.ts'

/**
 * The page's watch of every thread's run (#911): `GET /api/run-states`, read until the caller
 * leaves, reconnected when it ends. Each frame goes to `onFrame`; a reconnect starts with a fresh
 * `run-states`, so nothing missed while it was down is kept wrong.
 *
 * A refusal (4xx) is the page asking wrong, and asking again changes nothing: said once, not
 * retried. A frame off its schema is said and skipped.
 *
 * ⚠ No silence watchdog, unlike the follow's (#914): the route's keepalives are read and dropped.
 * A server that stops, or restarts, closes the socket, and that ends the read and reconnects; only
 * a half-open connection (a network that vanished without a close) would keep this waiting. What
 * that costs is a not-open row's dot clearing late — the next listing read still corrects it.
 */

const log = ensoLogger('browser', 'run-states')

const RUN_STATES_ROUTE = '/api/run-states'

/** Compiled once: it checks every frame. */
const frameValidator = Compile(EnsoRunStatesFrame)

/** The longest a reconnect waits: kept to once the shorter waits are spent. */
const LONGEST_RECONNECT_DELAY_MS = 5000

/** How long a reconnect waits, by consecutive attempt that heard nothing; a stream that delivered starts over. */
const RECONNECT_DELAYS_MS = [250, 1000, LONGEST_RECONNECT_DELAY_MS] as const

export interface RunStatesWatchOptions {
  /** The caller leaving: closes the stream and ends the loop. */
  readonly signal: AbortSignal
  readonly onFrame: (frame: EnsoRunStatesFrame) => void
  /** Test seam: the page's `fetch`. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

/** Read the server's run states until `signal` aborts or the route refuses. */
export async function watchRunStates(options: RunStatesWatchOptions): Promise<void> {
  const { signal } = options
  let failures = 0
  while (!signal.aborted) {
    const attempt = await readOnce(options)
    if (attempt === 'refused') return
    failures = attempt === 'delivered' ? 0 : failures + 1
    const delay = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)] ?? LONGEST_RECONNECT_DELAY_MS
    await sleep(delay, signal)
  }
}

/** One connection: `delivered` when a frame came through, `refused` on a 4xx, else `ended`. */
async function readOnce(options: RunStatesWatchOptions): Promise<'delivered' | 'refused' | 'ended'> {
  const { signal, onFrame } = options
  let delivered = false
  try {
    const response = await (options.fetch ?? fetch)(RUN_STATES_ROUTE, {
      signal,
      headers: { accept: 'text/event-stream' },
    })
    if (!response.ok || response.body === null) {
      const refused = response.status >= 400 && response.status < 500
      log.warn('the run states could not be watched: {status} {reason}', {
        status: response.status,
        reason: await response.text().catch(() => ''),
      })
      return refused ? 'refused' : 'ended'
    }
    for await (const frame of readSseFrames(response.body, signal, () => undefined)) {
      if (!frameValidator.Check(frame)) {
        log.warn('a run states frame is off its schema: {frame}', { frame: JSON.stringify(frame).slice(0, 200) })
        continue
      }
      delivered = true
      onFrame(frame)
    }
  } catch (error) {
    if (!signal.aborted) log.warn('the run states stopped: {error}', { error: String(error) })
  }
  return delivered ? 'delivered' : 'ended'
}
