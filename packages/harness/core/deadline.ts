/**
 * Run work under a deadline AND the caller's abort signal, as one signal (#174; the shape
 * `web_fetch` and `web_search` each carried).
 *
 * Two things every copy had to get right:
 *
 * - A signal that is ALREADY aborted never fires its event (`addEventListener` is not
 *   retroactive), so an `execute()` entered post-abort would run to the deadline — the
 *   guard aborts first (PR #58 review, nit 3).
 * - A budget already spent aborts BEFORE the work starts: a 0 ms timer would let fast work
 *   answer first, and a fallback must not start what the deadline already forbade.
 *
 * The deadline's reason is the caller's — it names the tool and the budget in the refusal.
 *
 * @group Shell execution
 */
export async function runUnderDeadline<T>(
  callerSignal: AbortSignal | undefined,
  deadline: {
    /** Milliseconds left; zero or less aborts before `run`. */
    readonly remainingMs: number
    /** The error the work sees when the deadline, not the caller, ended it. */
    readonly reason: () => Error
  },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const deadlinePassed = (): void => controller.abort(deadline.reason())
  if (deadline.remainingMs <= 0) deadlinePassed()
  const timeoutId = deadline.remainingMs > 0 ? setTimeout(deadlinePassed, deadline.remainingMs) : undefined
  const abortWithCaller = (): void => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted === true) {
    abortWithCaller()
  } else {
    callerSignal?.addEventListener('abort', abortWithCaller, { once: true })
  }
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortWithCaller)
  }
}
