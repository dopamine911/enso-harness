import { THREAD_NAME_MAX_LENGTH } from '@enso/core'
import { PencilIcon } from 'lucide-react'
import { useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { DialogFooter } from './components/ui/dialog.tsx'
import { Input } from './components/ui/input.tsx'
import { HeaderDialog } from './header-dialog.tsx'
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
 * The header's Rename (#670): a dialog holding the thread's name — its title until it has one —
 * selected, so typing replaces it. Save is offered for a name that is not blank and differs from
 * the current one; a refusal is said in the dialog and the name stays to be tried again.
 */
export function RenameThread({
  target,
  current,
  onRenamed,
}: {
  target: RenameTarget
  /** What the thread is called now: its name, else its title; the field starts with it. */
  current: string | undefined
  onRenamed: (name: string) => void
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const changeOpen = (next: boolean): void => {
    if (saving) return
    setOpen(next)
    setDraft(next ? (current ?? '') : '')
    setRefusal(undefined)
  }
  const trimmed = draft.trim()
  const savable = !saving && trimmed.length > 0 && trimmed !== current
  const save = (): void => {
    if (!savable) return
    setSaving(true)
    void renameThread(target, trimmed).then((outcome) => {
      setSaving(false)
      if (outcome.kind === 'refused') {
        setRefusal(outcome.reason)
        return
      }
      setOpen(false)
      onRenamed(outcome.name)
    })
  }
  return (
    <HeaderDialog
      open={open}
      onOpenChange={changeOpen}
      label="rename thread"
      hover="rename this thread"
      icon={<PencilIcon />}
      title="Rename this thread"
      description="The rail and the header show the name instead of the first prompt. It is kept with the thread."
      contentClassName="sm:max-w-md"
    >
      <form
        onSubmit={(event): void => {
          event.preventDefault()
          save()
        }}
      >
        <Input
          aria-label="thread name"
          value={draft}
          maxLength={THREAD_NAME_MAX_LENGTH}
          onChange={(event): void => setDraft(event.target.value)}
          onFocus={(event): void => event.target.select()}
        />
      </form>
      {refusal === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          Not renamed: {refusal}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" disabled={saving} onClick={(): void => changeOpen(false)}>
          Cancel
        </Button>
        <Button disabled={!savable} onClick={save}>
          Save
        </Button>
      </DialogFooter>
    </HeaderDialog>
  )
}
