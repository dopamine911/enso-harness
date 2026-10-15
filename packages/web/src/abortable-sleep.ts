/** Wait, unless the caller leaves first — an abort resolves it at once and takes its listener with it. */
export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, milliseconds)
  const stop = (): void => {
    clearTimeout(timer)
    resolve()
  }
  signal.addEventListener('abort', stop, { once: true })
  return promise.finally(() => signal.removeEventListener('abort', stop))
}
