import type { EnsoDiskUsage, EnsoStoredThread } from '@enso/core'
import { Trash2Icon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'
import { type DeletePreviewRead, type DeleteTarget, deleteThread, readDeletePreview } from './delete-thread.ts'
import { describeSize } from './disk-usage.ts'

/**
 * A thread's Delete (#571), behind a confirmation that says what goes before it is confirmed:
 * opening it reads the server's delete preview (`delete-thread.ts`), and the words come from that —
 * the conversation, the thread's tree by path, branch and size on disk (#578) when it has one, and
 * whether forks keep its snapshots (they stay while a live fork needs them). Delete waits for the
 * preview. Work the tree holds is named up front, and the confirm is "Delete anyway" from the
 * start; it confirms the text shown (its digest, `If-Match`), and work changed since is refused
 * (422) with the new list, said as changed, for the next click to confirm. A preview that fails is
 * said, and a plain Delete stays: the server's answer to it is authoritative. A tree that gained
 * work after the preview is still refused (422) and named, offering "Delete anyway". Any other
 * refusal closes the dialog and goes to `onRefused` — the header says it on the thread, Settings'
 * Trees on the tree's row (#578). ⚠ Once sent, a delete cannot be called back, so until the server
 * answers nothing dismisses the dialog (PR #572 review): Cancel is disabled, the close button is
 * gone, and Esc and the backdrop do nothing.
 */
export function DeleteThread({
  target,
  label = 'delete thread',
  onDeleted,
  onRefused,
  stored,
}: {
  target: DeleteTarget
  /** The trigger's accessible name: the header's is the active thread's; a listing names its row's. */
  label?: string
  onDeleted: (threadId: string) => void
  /** A refusal `force` cannot change (409, 404, no answer), in the server's words. */
  onRefused: (reason: string) => void
  /** The stored listing, for the rail titles of the forks that keep the thread's snapshots. */
  stored: readonly EnsoStoredThread[]
}): React.ReactNode {
  const { threadId, fetch } = target
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** The server's preview while the dialog is open; `undefined` while it is read. */
  const [preview, setPreview] = useState<DeletePreviewRead | undefined>(undefined)
  /**
   * The work the tree holds, as the server named it on a refused delete (422) — a race with the
   * preview. `changed` when it answered a "Delete anyway": the work moved since it was shown.
   */
  const [refusedForWork, setRefusedForWork] = useState<{ reason: string; changed: boolean } | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    let current = true
    void readDeletePreview({ threadId, fetch }).then((read) => {
      if (current) setPreview(read)
    })
    return (): void => {
      current = false
    }
  }, [open, threadId, fetch])
  const changeOpen = (next: boolean): void => {
    if (!next && deleting) return
    setOpen(next)
    if (!next) {
      setRefusedForWork(undefined)
      setPreview(undefined)
    }
  }
  const previewed = preview?.kind === 'read' ? preview.preview : undefined
  /** The holds-work text on screen, and what "Delete anyway" confirms (its digest is the `If-Match`). */
  const holdsWork = refusedForWork?.reason ?? previewed?.holdsWork ?? undefined
  const confirm = (confirmedWork: string | undefined): void => {
    setDeleting(true)
    void deleteThread({ threadId, fetch }, confirmedWork).then((outcome) => {
      setDeleting(false)
      if (outcome.kind === 'holds-work') {
        setRefusedForWork({ reason: outcome.reason, changed: confirmedWork !== undefined })
        return
      }
      // `deleting` in `changeOpen` is this render's; the answer is in, so close directly.
      setOpen(false)
      setRefusedForWork(undefined)
      setPreview(undefined)
      if (outcome.kind === 'deleted') onDeleted(threadId)
      else onRefused(outcome.reason)
    })
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title="delete this thread">
          <Trash2Icon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md" showCloseButton={!deleting}>
        <DialogHeader>
          <DialogTitle>Delete this thread?</DialogTitle>
          <DialogDescription>{describeDelete(preview, stored)}</DialogDescription>
        </DialogHeader>
        {holdsWork === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {refusedForWork?.changed === true ? 'The tree changed since: ' : null}
            {holdsWork}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={deleting} onClick={(): void => changeOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleting || preview === undefined}
            onClick={(): void => confirm(holdsWork)}
          >
            {holdsWork === undefined ? 'Delete' : 'Delete anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The tree's size in the confirmation (#578): what deleting it frees. An unreadable one is said as such, never as 0. */
function sizePhrase(size: EnsoDiskUsage | null): string {
  if (size === null) return ''
  if (size.kind === 'unreadable') return `; its size could not be read (${size.reason})`
  return `, ${describeSize(size)} on disk`
}

/** The confirmation's words: while the preview is read, why it could not be, or what goes and what forks keep. */
function describeDelete(read: DeletePreviewRead | undefined, stored: readonly EnsoStoredThread[]): string {
  if (read === undefined) return 'Checking what a delete would take…'
  if (read.kind === 'failed')
    return `This cannot be undone. The conversation is deleted. What else goes could not be read: ${read.reason}`
  const { tree, keptFor, size } = read.preview
  if (tree === null) return 'This cannot be undone. The conversation is deleted. Your checkout is not touched.'
  const named = tree.branch === null ? tree.path : `${tree.path} (branch ${tree.branch})`
  const goes = `This cannot be undone. The conversation is deleted, and so is the thread's tree at ${named}${sizePhrase(size)}.`
  if (keptFor.length > 0) {
    const forks = keptFor.map((fork) => forkName(fork.threadId, stored))
    if (forks.length === 1)
      return `${goes} Its snapshots up to where the fork ${forks[0]} branched stay with that fork; the rest go. The fork itself is not deleted.`
    return `${goes} Its snapshots up to where each of ${forks.length} forks (${forks.join(', ')}) branched stay with them; the rest go. The forks themselves are not deleted.`
  }
  return `${goes} Its snapshots go too.`
}

/** The longest fork title the dialog quotes whole; a longer one is cut, with an ellipsis. */
const FORK_TITLE_LIMIT = 40

/** A fork as the dialog names it: its rail title, quoted and bounded, else its short id. */
function forkName(threadId: string, stored: readonly EnsoStoredThread[]): string {
  const title = stored.find((row) => row.threadId === threadId)?.title?.trim()
  if (title === undefined || title.length === 0) return threadId.slice(0, 8)
  const bounded = title.length > FORK_TITLE_LIMIT ? `${title.slice(0, FORK_TITLE_LIMIT - 1).trimEnd()}…` : title
  return `“${bounded}”`
}
