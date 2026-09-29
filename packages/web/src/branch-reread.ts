import type { UIMessage } from '@tanstack/ai-client'
import { useEffect, useRef } from 'react'
import { useStore } from './store.ts'
import { fetchThreadHistory } from './stored-threads.ts'
import { reviveHistoryMessages, type ThreadStores } from './thread-stores.ts'

/** What of the pane's chat the re-read touches: whether a run is in flight, and its transcript. */
interface RereadChat {
  readonly sessionGenerating: boolean
  readonly setMessages: (messages: UIMessage[]) => void
}

/**
 * After pi compacts the branch (#348), the transcript this pane mounted with is not the session's
 * any more: the thread is re-read, and its messages replace the pane's. Once per compaction pi
 * said it finished (`stores.branchCompacted`), and only while the thread is IDLE.
 *
 * ⚠ NEVER MID-RUN. pi compacts on its own when the context overflows, inside the run it then
 * retries, and replacing the transcript under a streaming reply would drop what streamed. So a
 * compaction said during a run waits for the run to settle; a read that finds a run begun since
 * applies nothing, and the next idle reads again.
 *
 * A later compaction makes an earlier read stale: a read applies only if no compaction was said
 * after it began. A thread the server no longer holds (404) has nothing to re-read, and is left.
 */
export function useRereadAfterCompaction(stores: ThreadStores, chat: RereadChat): void {
  const compacted = useStore(stores.branchCompacted)
  const applied = useRef(0)
  // The run flag as of the latest COMMITTED render, for a read that lands after it changed —
  // written in an effect, never during render (React's rule; `chat-screen.tsx#latestMessages`).
  const generating = useRef(chat.sessionGenerating)
  const { sessionGenerating, setMessages } = chat
  useEffect(() => {
    generating.current = sessionGenerating
  }, [sessionGenerating])
  useEffect(() => {
    if (sessionGenerating || compacted === applied.current) return
    const wanted = compacted
    void fetchThreadHistory(stores.threadId, stores.fetch).then(
      (history) => {
        if (stores.branchCompacted.get() !== wanted) return // compacted again since: that read applies
        if (history === undefined) {
          applied.current = wanted // gone from the server: nothing to re-read, and no retry
          return
        }
        if (generating.current) return // a run began since: the next idle reads again
        setMessages(reviveHistoryMessages(history.messages))
        applied.current = wanted
      },
      () => undefined, // unreachable or refused: the transcript stays; the next compaction reads again
    )
  }, [compacted, sessionGenerating, setMessages, stores])
}
