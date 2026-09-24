import { act } from 'react'

const DEADLINE_MS = 2000
const STEP_MS = 20

const flush = (work: () => Promise<void>): Promise<void> => act(work)

/**
 * React's work flushed every 20 ms until `ready()` holds or two seconds pass — the mounted
 * tests' one wait. It never fails by itself: the `expect` after it says what did not arrive.
 */
export async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS
  while (!ready() && Date.now() < deadline) {
    await flush(() => new Promise<void>((resolve) => setTimeout(resolve, STEP_MS)))
  }
}
