import type { EnsoDirectoryListing, EnsoProject } from '@enso/core'
import { ArrowUpIcon, FolderIcon } from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { Checkbox } from './components/ui/checkbox.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'
import { Field, FieldError, FieldLabel } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { browseDirectories, registerProject } from './project-list.ts'

/**
 * Add a project (#395 slice 3, #866): browse from the home folder — or from the roots, when the
 * user's config declares any (`ENSO_HOME/config.json`) — or type a folder's path, then confirm what
 * an agent there can reach. Only what the server lists can be chosen, and the server lists only what
 * it would register (`projects.ts`): resolved, never hidden, never the home folder or one holding it,
 * never Enso's own home. A starting folder is browsed, not added; a directory already a project says so.
 */
export interface AddProjectDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The project, new or already registered — the page refreshes its lists. */
  readonly onAdded: (project: EnsoProject) => void
  /** Injected by tests; the page's global by default. */
  readonly fetch?: FetchLike
}

type Browsing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly listing: EnsoDirectoryListing }
  | { readonly kind: 'failed'; readonly reason: string }

/** What the dialog says when there is no folder to start from: every declared root is gone from disk. */
export const NO_START = 'none of the folders to start from exists — type a path below'

/**
 * What adding `path` means, said before it is added (#866). With no sandbox (#24, #397), a project's
 * folder is everything an agent working in it can reach: the person chooses that, knowing it. A
 * folder inside a hidden one (reachable only with hidden folders shown) says so as well.
 */
export function reachOf(path: string): string {
  const reach = `An agent working in ${path} can read and change everything under it. Enso does not sandbox agents, so that is the whole of what this folder lets one reach.`
  const hidden = path.split('/').some((segment) => segment.startsWith('.'))
  return hidden ? `${reach} It is inside a hidden folder, where tools keep their settings and keys.` : reach
}

/** The listing at `path` (`null`: where browsing starts), reloaded whenever the dialog opens, moves, or shows hidden folders. */
function useBrowsing(open: boolean, path: string | null, hidden: boolean, fetchImpl: FetchLike | undefined): Browsing {
  const [browsing, setBrowsing] = useState<Browsing>({ kind: 'loading' })
  useEffect(() => {
    if (!open) return
    let current = true
    setBrowsing({ kind: 'loading' })
    void browseDirectories(path, hidden, fetchImpl).then((outcome) => {
      if (!current) return
      setBrowsing(
        outcome.kind === 'ok' ? { kind: 'loaded', listing: outcome.value } : { kind: 'failed', reason: outcome.reason },
      )
    })
    return () => {
      current = false
    }
  }, [open, path, hidden, fetchImpl])
  return browsing
}

function DirectoryList({
  listing,
  onOpen,
}: {
  listing: EnsoDirectoryListing
  onOpen: (path: string | null) => void
}): React.ReactNode {
  if (listing.path === null && listing.directories.length === 0) return <FieldError>{NO_START}</FieldError>
  return (
    <ul aria-label="folders" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-md border p-1">
      {listing.path === null ? null : (
        <li>
          <button
            type="button"
            onClick={() => onOpen(listing.parent)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-muted"
          >
            <ArrowUpIcon className="size-4" /> {listing.parent === null ? 'where to start' : 'up'}
          </button>
        </li>
      )}
      {listing.directories.map((directory) => (
        <li key={directory.path}>
          <button
            type="button"
            title={directory.path}
            onClick={() => onOpen(directory.path)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
          >
            <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{directory.name}</span>
            {directory.projectId === undefined ? null : (
              <span className="shrink-0 text-xs text-muted-foreground">project</span>
            )}
          </button>
        </li>
      ))}
      {listing.directories.length === 0 && listing.path !== null ? (
        <li className="px-2 py-1 text-sm text-muted-foreground italic">no folders here</li>
      ) : null}
      {listing.truncated ? <li className="px-2 py-1 text-xs text-muted-foreground">more folders than shown</li> : null}
    </ul>
  )
}

/** A folder's path, typed or pasted (`~/` allowed): the server resolves it and browses there. */
function PathField({ onGo }: { onGo: (path: string) => void }): React.ReactNode {
  const [typed, setTyped] = useState('')
  const go = (event: FormEvent): void => {
    event.preventDefault()
    const path = typed.trim()
    if (path.length > 0) onGo(path)
  }
  return (
    <form onSubmit={go} className="flex gap-2">
      <Input
        aria-label="folder path"
        placeholder="or type a path, e.g. ~/work/app"
        value={typed}
        onChange={(event): void => setTyped(event.target.value)}
      />
      <Button type="submit" variant="outline" disabled={typed.trim().length === 0}>
        Go
      </Button>
    </form>
  )
}

/** Choosing: the folders on screen, the path field, and whether hidden folders show — until a folder is chosen. */
function BrowsePane({
  browsing,
  onMove,
  hidden,
  onHidden,
}: {
  browsing: Browsing
  onMove: (path: string | null) => void
  hidden: boolean
  onHidden: (hidden: boolean) => void
}): React.ReactNode {
  const toggleId = useId()
  return (
    <>
      {browsing.kind === 'loading' ? <p className="text-sm text-muted-foreground">reading folders…</p> : null}
      {browsing.kind === 'failed' ? <FieldError>{browsing.reason}</FieldError> : null}
      {browsing.kind === 'loaded' ? <DirectoryList listing={browsing.listing} onOpen={onMove} /> : null}
      <PathField onGo={onMove} />
      <Field orientation="horizontal">
        <Checkbox
          id={toggleId}
          checked={hidden}
          onCheckedChange={(checked: boolean | 'indeterminate'): void => onHidden(checked === true)}
        />
        <FieldLabel htmlFor={toggleId}>show hidden folders</FieldLabel>
      </Field>
    </>
  )
}

/** Confirming (#866): back to choosing, or register the folder the dialog has just described. */
function ConfirmActions({
  adding,
  onBack,
  onAdd,
}: {
  adding: boolean
  onBack: () => void
  onAdd: () => void
}): React.ReactNode {
  return (
    <>
      <Button variant="ghost" disabled={adding} onClick={onBack}>
        Back
      </Button>
      <Button disabled={adding} onClick={onAdd}>
        {adding ? 'Adding…' : 'Add project'}
      </Button>
    </>
  )
}

export function AddProjectDialog({ open, onClose, onAdded, fetch: fetchImpl }: AddProjectDialogProps): React.ReactNode {
  const [path, setPath] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  // The folder on screen, held while the person reads what adding it means (#866).
  const [confirming, setConfirming] = useState(false)
  // Hidden folders listed, browsable and addable (#866) — off at every opening, as the guardrail is.
  const [hidden, setHidden] = useState(false)
  const browsing = useBrowsing(open, path, hidden, fetchImpl)
  const listing = browsing.kind === 'loaded' ? browsing.listing : undefined
  const move = (next: string | null): void => {
    setRefusal(undefined)
    setConfirming(false)
    setPath(next)
  }
  // Every opening starts where browsing starts: the dialog stays mounted while closed, and
  // the folder it was left on may since be gone, unreadable, or already added.
  const close = (): void => {
    move(null)
    setHidden(false)
    onClose()
  }
  const add = async (): Promise<void> => {
    if (listing?.path == null || !listing.registrable) return
    setAdding(true)
    const outcome = await registerProject(listing.path, hidden, fetchImpl)
    setAdding(false)
    if (outcome.kind === 'refused') {
      setConfirming(false)
      setRefusal(outcome.reason)
      return
    }
    onAdded(outcome.value)
    close()
  }
  const chosen = confirming && listing?.path != null ? listing.path : undefined
  return (
    <Dialog open={open} onOpenChange={(next: boolean): void => (next ? undefined : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription className="break-all">
            {listing?.path ?? 'choose a folder, or type its path'}
          </DialogDescription>
        </DialogHeader>
        {chosen === undefined ? (
          <BrowsePane browsing={browsing} onMove={move} hidden={hidden} onHidden={setHidden} />
        ) : (
          <p role="alert" className="text-sm">
            {reachOf(chosen)}
          </p>
        )}
        {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
        <DialogFooter>
          {chosen === undefined ? (
            <>
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              <Button disabled={listing?.registrable !== true} onClick={(): void => setConfirming(true)}>
                Add this folder
              </Button>
            </>
          ) : (
            <ConfirmActions adding={adding} onBack={(): void => setConfirming(false)} onAdd={(): void => void add()} />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
