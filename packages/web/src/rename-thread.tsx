import { THREAD_NAME_MAX_LENGTH } from '@enso/core'
import { useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { describeFailedResponse } from './stored-threads.ts'

/** The thread a rename is for, and the fetch its pane's requests go through. */
export interface RenameTarget {
  readonly threadId: string
  readonly fetch: FetchLike
}

type RenameOutcome =
  | { readonly kind: 'renamed'; readonly name: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Name the thread (#670): `POST /api/threads/:id/name { name }`. The server records it as pi's own
 * `session_info` — what pi's `/name` writes — so a reload and a resume keep it; a running thread is
 * refused (409), in the server's words, as is any other refusal or no answer at all.
 */
async function renameThread(target: RenameTarget, name: string): Promise<RenameOutcome> {
  const trimmed = name.trim()
  try {
    const response = await target.fetch(`/api/threads/${encodeURIComponent(target.threadId)}/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    })
    if (response.ok) return { kind: 'renamed', name: trimmed }
    return { kind: 'refused', reason: await describeFailedResponse(response) }
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The header's inline Rename (#670, #879): the title becomes a field holding the thread's name — its
 * title until it has one — focused and selected whole, so typing replaces it. Enter saves a name
 * that is not blank and differs from the current one (an unchanged one just closes); Escape cancels
 * and sends nothing. A refusal is said under the field and the name stays to be tried again.
 */
export function InlineRename({
  target,
  current,
  onRenamed,
  onDone,
}: {
  target: RenameTarget
  /** What the thread is called now: its name, else its title; the field starts with it. */
  current: string | undefined
  onRenamed: (name: string) => void
  /** The field is done with: saved, cancelled or left. */
  onDone: () => void
}): React.ReactNode {
  const [draft, setDraft] = useState(current ?? '')
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  // The reader asked for the field by choosing Rename: focus moves in, selecting the name whole.
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])
  const save = (): void => {
    const trimmed = draft.trim()
    if (saving || trimmed.length === 0) return
    if (trimmed === current) {
      onDone()
      return
    }
    setSaving(true)
    void renameThread(target, trimmed).then((outcome) => {
      setSaving(false)
      if (outcome.kind === 'refused') {
        setRefusal(outcome.reason)
        return
      }
      onRenamed(outcome.name)
      onDone()
    })
  }
  return (
    <div className="grid min-w-0">
      <input
        ref={field}
        aria-label="thread name"
        aria-describedby="thread-rename-hint"
        value={draft}
        maxLength={THREAD_NAME_MAX_LENGTH}
        readOnly={saving}
        className="min-w-0 rounded-sm border bg-background px-1.5 font-heading text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event): void => setDraft(event.target.value)}
        onFocus={(event): void => event.target.select()}
        onKeyDown={(event): void => {
          // A key that ends an IME composition is the composition's, not the field's.
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            save()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            if (!saving) onDone()
          }
        }}
      />
      {refusal === undefined ? (
        <span id="thread-rename-hint" className="truncate text-xs text-muted-foreground">
          Enter to save · Escape to cancel
        </span>
      ) : (
        <span id="thread-rename-hint" role="alert" className="truncate text-xs text-destructive">
          Not renamed: {refusal}
        </span>
      )}
    </div>
  )
}
