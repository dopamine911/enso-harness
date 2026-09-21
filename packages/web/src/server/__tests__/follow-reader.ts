import { ZenFollowFrame } from '@zen/core'
import { Check } from 'typebox/value'

/**
 * A follow as a test reads it: frames and keepalive comments as they arrive, awaited by
 * count — never by a guessed delay. Every frame is checked against `ZenFollowFrame` on the
 * way in, so a shape the browser could not read fails the test that produced it.
 *
 * ⚠ HOW THAT FAILURE TRAVELS (#231). The check cannot throw from the reader's own loop —
 * the `catch` that absorbs the test's `close()` would eat it, which is exactly what this
 * double did until #231: the named error reached no test, and a malformed frame surfaced
 * as a bun-test timeout with no diagnosis. So a violation is RECORDED (`failure()`) and
 * every later `untilFrames`/`untilComments` REJECTS with it, before the count is even
 * looked at — an awaited checkpoint is where a test learns. ⚠ Residual: a test that
 * produces a bad frame and then awaits nothing is still green. The reader keeps reading
 * past a violation, so `comments()` and the frames after it stay honest.
 *
 * Two faults, kept apart: a `WireSchemaViolation` is the server writing a shape the
 * browser could not read (fix the server); any other read error is the transport dying
 * under the follow (fix the test's plumbing, or the server's lifetime). Only the test's
 * own `close()` is silent.
 *
 * Lives under `__tests__/` deliberately: the coverage manifest skips that directory.
 */
export interface OpenFollow {
  readonly frames: ZenFollowFrame[]
  readonly comments: () => number
  /** Resolves once at least `count` frames have arrived; rejects once the wire has failed. */
  readonly untilFrames: (count: number) => Promise<void>
  /** Resolves once at least `count` keepalive comments have arrived; rejects once the wire has failed. */
  readonly untilComments: (count: number) => Promise<void>
  /** The first fault this follow saw, or `undefined` while the wire has been readable. */
  readonly failure: () => Error | undefined
  /** Resolves when the reader has stopped — the server closed, the transport failed, or the test closed the follow. */
  readonly ended: () => Promise<void>
  readonly close: () => void
}

/** A frame off the wire that `ZenFollowFrame` refuses: the server wrote a shape the browser could not read. */
export class WireSchemaViolation extends Error {
  constructor(line: string) {
    super(`frame off the wire fails ZenFollowFrame: ${line}`)
    this.name = 'WireSchemaViolation'
  }
}

/** The test's own `close()` — the one error the reader absorbs. `AbortError` is a `DOMException`, not an `Error`. */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

export async function openFollow(
  url: string,
  threadId: string,
  controller = new AbortController(),
): Promise<OpenFollow> {
  const response = await fetch(`${url}/api/threads/${threadId}/follow`, { signal: controller.signal })
  if (response.status !== 200) throw new Error(`follow ${threadId}: ${response.status} ${await response.text()}`)
  const frames: ZenFollowFrame[] = []
  let comments = 0
  let failure: Error | undefined
  const waiters: Array<() => void> = []
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter()
  }
  /** One SSE line: a frame the schema takes, a keepalive comment, or the violation that fails the test. */
  const readLine = (line: string): void => {
    if (line.startsWith(':')) {
      comments += 1
      return
    }
    if (!line.startsWith('data: ')) return
    const frame: unknown = JSON.parse(line.slice('data: '.length))
    if (Check(ZenFollowFrame, frame)) frames.push(frame)
    else failure ??= new WireSchemaViolation(line)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('no body')
  const readerDone = (async () => {
    const decoder = new TextDecoder()
    let buffered = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) readLine(line)
        wake()
      }
    } catch (error) {
      // The test closed the follow; anything else is a fault the follow must report.
      if (!isAbort(error)) failure ??= error instanceof Error ? error : new Error(String(error))
    }
    wake()
  })()
  const until = (ready: () => boolean): Promise<void> => {
    if (failure !== undefined) return Promise.reject(failure)
    if (ready()) return Promise.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const check = (): void => {
      if (failure !== undefined) reject(failure)
      else if (ready()) resolve()
      else waiters.push(check)
    }
    waiters.push(check)
    return promise
  }
  return {
    frames,
    comments: () => comments,
    untilFrames: (count: number) => until(() => frames.length >= count),
    untilComments: (count: number) => until(() => comments >= count),
    failure: () => failure,
    ended: () => readerDone,
    close: () => controller.abort(),
  }
}
