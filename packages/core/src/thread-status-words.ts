/**
 * The words the thread's status bar says, which something reading the page relies on (#648).
 *
 * The web bar renders them; the Dogfood Arena's `wait until attention` reads them back out of the
 * page's accessibility tree to tell an agent that Enso needs it or is done. One definition, so a
 * rewording changes both and neither silently stops matching the other.
 *
 * @group Thread status
 */
export const THREAD_STATUS_WORDS = {
  /** The bar's accessible name: its region in a page read is `contentinfo "thread status"`. */
  region: 'thread status',
  /** Said while pi waits on an answer from the person (#362). */
  questionWaiting: 'a question is waiting',
  /** The run's word when nothing runs: before the first prompt, after a reply, and after a failed run. */
  idle: 'idle',
  /** The run's word once the thread's follow ended: the server is gone until a reload (#119). */
  disconnected: 'disconnected',
} as const
