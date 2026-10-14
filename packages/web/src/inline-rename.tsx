import { useEffect, useId, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { describeFailedResponse } from './stored-threads.ts'

/** What a rename's request came to: the name now held, or the server's refusal in one line. */
export type RenameOutcome =
  | { readonly kind: 'renamed'; readonly name: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Name the thread (#670): `POST /api/threads/:id/name { name }`. The server records it as pi's own
 * `session_info` — what pi's `/name` writes — so a reload and a resume keep it; a running thread is
 * refused (409), in the server's words, as is any other refusal or no answer at all.
 */
export async function renameThread(
  target: { readonly threadId: string; readonly fetch: FetchLike },
  name: string,
): Promise<RenameOutcome> {
  try {
    const response = await target.fetch(`/api/threads/${encodeURIComponent(target.threadId)}/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (response.ok) return { kind: 'renamed', name }
    return { kind: 'refused', reason: await describeFailedResponse(response) }
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A header's inline rename — a thread's (#670, #879), a project's (#939): the title becomes a field
 * holding the current name, focused and selected whole, so typing replaces it. Enter saves a name
 * that is not blank and differs from the current one, trimmed (an unchanged one just closes);
 * Escape cancels and sends nothing. A refusal is said under the field and the name stays to be
 * tried again.
 */
export function InlineRename({
  label,
  hint,
  maxLength,
  current,
  save,
  onDone,
}: {
  /** The field's accessible name: "thread name", "project name". */
  label: string
  /** What the line under the field says while nothing is refused: how to save and cancel. */
  hint: string
  maxLength?: number
  /** What it is called now; the field starts with it. */
  current: string | undefined
  /**
   * Send the trimmed name, never a blank or unchanged one, and do what a saved one changes on the
   * page before answering: the field closes once it answers `renamed`.
   */
  save: (name: string) => Promise<RenameOutcome>
  /** The field is done with: saved, cancelled or left. */
  onDone: () => void
}): React.ReactNode {
  const [draft, setDraft] = useState(current ?? '')
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const hintId = useId()
  // The reader asked for the field by choosing Rename: focus moves in, selecting the name whole.
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => field.current?.focus(), [])
  const submit = (): void => {
    const trimmed = draft.trim()
    if (saving || trimmed.length === 0) return
    if (trimmed === current) {
      onDone()
      return
    }
    setSaving(true)
    void save(trimmed).then((outcome) => {
      setSaving(false)
      if (outcome.kind === 'refused') {
        setRefusal(outcome.reason)
        return
      }
      onDone()
    })
  }
  return (
    <div className="grid min-w-0">
      <input
        ref={field}
        aria-label={label}
        aria-describedby={hintId}
        value={draft}
        maxLength={maxLength}
        readOnly={saving}
        className="min-w-0 rounded-sm border bg-background px-1.5 font-heading text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event): void => setDraft(event.target.value)}
        onFocus={(event): void => event.target.select()}
        onKeyDown={(event): void => {
          // A key that ends an IME composition is the composition's, not the field's.
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            if (!saving) onDone()
          }
        }}
      />
      {refusal === undefined ? (
        <span id={hintId} className="truncate text-xs text-muted-foreground">
          {hint}
        </span>
      ) : (
        <span id={hintId} role="alert" className="truncate text-xs text-destructive">
          Not renamed: {refusal}
        </span>
      )}
    </div>
  )
}
