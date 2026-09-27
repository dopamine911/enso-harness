/**
 * When a run was admitted, so its FIRST delta can be recorded as a latency (#144 slice 1).
 *
 * Turn duration is already derivable at `info` — `prompt … opened` to `settled`. Time to
 * first token is not: the deltas that would date it only exist at `debug`, and a person
 * asking "why did that feel slow" should not have to have been at `debug` beforehand. So one
 * `info` record per run, at its first delta, with the ms since admission.
 *
 * Keyed by thread and generation because that pair is what every other record joins on. A run
 * that never produces a delta (aborted before the first token) leaves its entry until it
 * settles, which clears it. Two endings publish no `settled` — a prompt pi rejects after its
 * receipt, and an extension slash command, whose acceptance is its completion — so the prompt
 * route forgets those itself (#160 §8). The map holds live runs only.
 */

/** `${threadId}:${generation}` → the ms clock at admission. */
const admittedAt = new Map<string, number>()

function keyOf(threadId: string, generation: number): string {
  return `${threadId}:${generation}`
}

/**
 * A run opened on this thread. The FIRST admission of a generation wins: a prompt queued
 * behind a run in flight joins that run and does not restart its clock.
 */
export function noteRunAdmitted(threadId: string, generation: number, now: number = Date.now()): void {
  const key = keyOf(threadId, generation)
  if (!admittedAt.has(key)) admittedAt.set(key, now)
}

/**
 * The ms from admission to now for this run's FIRST delta — `undefined` afterwards, and
 * `undefined` when the run's admission was never seen (a follow attached mid-run, a test).
 */
export function takeFirstDeltaMs(threadId: string, generation: number, now: number = Date.now()): number | undefined {
  const key = keyOf(threadId, generation)
  const admitted = admittedAt.get(key)
  if (admitted === undefined) return undefined
  admittedAt.delete(key)
  return now - admitted
}

/** The run ended without a delta, or has had its one record: nothing left to time. */
export function forgetRun(threadId: string, generation: number): void {
  admittedAt.delete(keyOf(threadId, generation))
}
