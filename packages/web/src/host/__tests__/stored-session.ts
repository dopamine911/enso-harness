import { SessionManager } from '@earendil-works/pi-coding-agent'

/**
 * A stored thread, written the way pi writes one (#95, #486): a session created under the thread's
 * id and whole turns appended, each a user message and pi's reply. pi flushes on the first
 * assistant message, so the file exists after this.
 *
 * Shared by the host's tests and the browser suite's seeded home (`packages/web/e2e/`), which
 * needs long stored transcripts with no model: here, under `host/`, because only the host may
 * name the runtime's package (the vendor gate), and a hand-written JSONL would test our reader
 * against our own idea of pi's format.
 *
 * ⚠ THE SESSION DIR IS pi's, FROM `PI_CODING_AGENT_DIR`, read when this runs. The caller sets it
 * to a scratch agent dir first: a host does so when it is created, the e2e home does so itself.
 * Unset, this writes into the operator's real `~/.pi/agent` (a test did, once, run in isolation).
 */
export function writeStoredSession(options: {
  /** The project the thread ran in: pi files sessions by it. */
  readonly cwd: string
  readonly threadId: string
  readonly turns: ReadonlyArray<readonly [user: string, assistant: string]>
  /** When the messages say they were sent; now unless a test needs an old thread. */
  readonly at?: () => number
}): { file: string; userEntryIds: string[] } {
  const at = options.at ?? Date.now
  const sessionDir = SessionManager.inMemory(options.cwd).getSessionDir()
  const stored = SessionManager.create(options.cwd, sessionDir, { id: options.threadId })
  const userEntryIds = options.turns.map(([userText, assistantText]) => {
    const userEntryId = stored.appendMessage({ role: 'user', content: userText, timestamp: at() })
    stored.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: at(),
    } as never)
    return userEntryId
  })
  const file = stored.getSessionFile()
  if (file === undefined) throw new Error('pi did not flush the stored session')
  return { file, userEntryIds }
}
