import type { EnsoDirectoryListing, EnsoProject } from '@enso/core'
import { ArrowUpIcon, FolderIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'
import { FieldError } from './components/ui/field.tsx'
import { browseDirectories, registerProject } from './project-list.ts'

/**
 * Add a project (#395 slice 3): browse the directories the install allows — inside the roots
 * `enso.config.json` declares — and register one. Only what the server lists can be chosen, and
 * the server lists only what it would register: resolved, inside a root, never hidden. A root
 * itself is browsed, not added; a directory already a project says so.
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

/** What the dialog says when there is nothing to browse. */
export const NO_ROOTS = 'no project roots are declared — add "projects": { "roots": ["~/code"] } to enso.config.json'

/** The listing at `path` (`null`: the roots), reloaded whenever the dialog opens or moves. */
function useBrowsing(open: boolean, path: string | null, fetchImpl: FetchLike | undefined): Browsing {
  const [browsing, setBrowsing] = useState<Browsing>({ kind: 'loading' })
  useEffect(() => {
    if (!open) return
    let current = true
    setBrowsing({ kind: 'loading' })
    void browseDirectories(path, fetchImpl).then((outcome) => {
      if (!current) return
      setBrowsing(
        outcome.kind === 'ok' ? { kind: 'loaded', listing: outcome.value } : { kind: 'failed', reason: outcome.reason },
      )
    })
    return () => {
      current = false
    }
  }, [open, path, fetchImpl])
  return browsing
}

function DirectoryList({
  listing,
  onOpen,
}: {
  listing: EnsoDirectoryListing
  onOpen: (path: string | null) => void
}): React.ReactNode {
  if (listing.path === null && listing.directories.length === 0) return <FieldError>{NO_ROOTS}</FieldError>
  return (
    <ul aria-label="folders" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-md border p-1">
      {listing.path === null ? null : (
        <li>
          <button
            type="button"
            onClick={() => onOpen(listing.parent)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-muted-foreground text-sm hover:bg-muted"
          >
            <ArrowUpIcon className="size-4" /> {listing.parent === null ? 'project roots' : 'up'}
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
              <span className="shrink-0 text-muted-foreground text-xs">project</span>
            )}
          </button>
        </li>
      ))}
      {listing.directories.length === 0 && listing.path !== null ? (
        <li className="px-2 py-1 text-muted-foreground text-sm italic">no folders here</li>
      ) : null}
      {listing.truncated ? <li className="px-2 py-1 text-muted-foreground text-xs">more folders than shown</li> : null}
    </ul>
  )
}

export function AddProjectDialog({ open, onClose, onAdded, fetch: fetchImpl }: AddProjectDialogProps): React.ReactNode {
  const [path, setPath] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const browsing = useBrowsing(open, path, fetchImpl)
  const listing = browsing.kind === 'loaded' ? browsing.listing : undefined
  const move = (next: string | null): void => {
    setRefusal(undefined)
    setPath(next)
  }
  const add = async (): Promise<void> => {
    if (listing?.path == null || !listing.registrable) return
    setAdding(true)
    const outcome = await registerProject(listing.path, fetchImpl)
    setAdding(false)
    if (outcome.kind === 'refused') {
      setRefusal(outcome.reason)
      return
    }
    onAdded(outcome.value)
    onClose()
  }
  return (
    <Dialog open={open} onOpenChange={(next: boolean): void => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription className="break-all">
            {listing?.path ?? 'the project roots enso.config.json declares'}
          </DialogDescription>
        </DialogHeader>
        {browsing.kind === 'loading' ? <p className="text-muted-foreground text-sm">reading folders…</p> : null}
        {browsing.kind === 'failed' ? <FieldError>{browsing.reason}</FieldError> : null}
        {listing === undefined ? null : <DirectoryList listing={listing} onOpen={move} />}
        {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button disabled={adding || listing?.registrable !== true} onClick={(): void => void add()}>
            {adding ? 'Adding…' : 'Add this folder'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
