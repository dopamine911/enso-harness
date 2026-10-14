/**
 * The words the thread's status bar says, which something reading the page relies on (#648).
 *
 * The web bar renders them; the Dogfood Arena's `wait until attention` reads them back out of the
 * page's accessibility tree to tell an agent that Enso needs it or is done. One definition, so a
 * rewording changes both and neither silently stops matching the other.
 *
 * The run's word is one of five states (#914), each needing something different of the person:
 * the page lost its live view (reload), pi is working (watch), pi waits on you (answer), pi may be
 * stuck (consider stopping), or the run stopped (read how it ended).
 *
 * @group Thread status
 */
export const THREAD_STATUS_WORDS = {
  /** The bar's accessible name: its region in a page read is `contentinfo "thread status"`. */
  region: 'thread status',
  /** Said while pi waits on an answer from the person (#362), in the bar's live region. */
  questionWaiting: 'a question is waiting',
  /** The run's word before anything has run on this page: a fresh thread, or one opened at rest. */
  idle: 'idle',
  /** The run's word while pi works: a model request, thinking, a reply, a tool call (#914). */
  working: 'working',
  /** The run's word while pi waits on the person's answer (#914) — over every word but a lost view. */
  waiting: 'waiting on you',
  /** The run's word while pi works and nothing has come from it for minutes (#914): an observation, not a verdict. */
  stuck: 'possibly stuck',
  /** The run's word once a run finished on its own (#914), until the next prompt. */
  finished: 'finished',
  /** The run's word once a Stop ended the run (#766, #914), until the next prompt. */
  stopped: 'stopped by you',
  /** The run's word once the run ended on an error (#914) — a provider's, an extension's, a guard's halt — until the next prompt. */
  failed: 'failed',
  /** The run's word once the page stopped receiving the thread's updates (#119, #914): reload to catch up. */
  lost: 'live view lost',
  /** The run's word while the page says it may be out of date (#919): fallen behind, or partly failed, until a Reload. */
  behind: 'out of date',
} as const
