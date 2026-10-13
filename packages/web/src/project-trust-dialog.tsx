import type { EnsoProjectTierFile, EnsoProjectTrust } from '@enso/core'
import { TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'
import { type ProjectRequestOutcome, requestProjectTrust } from './project-list.ts'

/**
 * Project trust's confirmations (#873), on the project page and after Add project: trusting names
 * what it turns on — each of the project's own files that is there and the setup commands it
 * declares, as written, or "none" — read from the server when the dialog opens, so they are the
 * files as they are now. Revoking says what stops. Both say what happens to a thread already open:
 * nothing — a session keeps the decision it was built with (`project-trust-route.ts`).
 */

/** The project's own files, by the names a person knows them by. */
export const OWN_FILES = '.enso/config.json and .enso/config.local.json'

/** What a grant changes for threads already open, and for the next ones. */
const NEXT_THREADS = 'New threads and new trees follow this; a thread already open picks it up when it is next built.'

/** What a revoke does to threads already open: what the server does (`project-routes.ts`). */
const OPEN_THREADS_REVOKED =
  'Its open threads that aren’t running are closed, so each is rebuilt without this trust at its next prompt; Enso won’t revoke while one of them is running.'

/** One file's commands, as written, in order — or "none". */
function SetupCommands({ setup = [] }: { setup?: readonly string[] | undefined }): React.ReactNode {
  if (setup.length === 0) return <p className="text-muted-foreground">Setup commands: none</p>
  // A list may hold one command twice: each is keyed by its words and which occurrence it is.
  const seen = new Map<string, number>()
  const keyed = setup.map((command) => {
    const occurrence = (seen.get(command) ?? 0) + 1
    seen.set(command, occurrence)
    return { key: `${command}#${occurrence}`, command }
  })
  return (
    <div className="grid gap-1">
      <p>Setup commands, run in order on this machine in every new tree:</p>
      <ol aria-label="setup commands" className="grid gap-1">
        {keyed.map(({ key, command }) => (
          <li key={key} className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap">
            {command}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Each of the project's own files that is there, with its commands — or why it is not shown. */
function TierFileList({ files }: { files: readonly EnsoProjectTierFile[] }): React.ReactNode {
  return (
    <ul aria-label="the project’s own settings files" className="grid gap-3">
      {files.map((file) => (
        <li key={file.path} className="grid gap-1">
          <span className="font-mono text-xs break-all">{file.path}</span>
          {'unread' in file ? (
            <p className="flex items-start gap-1.5 text-destructive">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              This file {file.unread}.
            </p>
          ) : (
            <SetupCommands setup={file.setup} />
          )}
        </li>
      ))}
    </ul>
  )
}

/** The files trust turns on, each with its setup commands, and what else trust lets in. */
function TrustDisclosure({ trust }: { trust: EnsoProjectTrust }): React.ReactNode {
  const declaring = trust.files.filter((file) => 'setup' in file && file.setup !== undefined)
  return (
    <div className="grid gap-3 text-sm">
      {trust.files.length === 0 ? (
        <p>
          This project has none of its own settings files yet ({OWN_FILES}), so there are no setup commands to run.
          Setup commands: none.
        </p>
      ) : (
        <TierFileList files={trust.files} />
      )}
      {declaring.length > 1 ? (
        <p className="text-muted-foreground">
          Both files list setup commands: the local file’s list replaces the shared one’s.
        </p>
      ) : null}
      <p className="text-muted-foreground">
        Trust also lets in the project’s .pi/ folder — its settings, extensions, skills, prompts, permission rules and
        modes — and its .enso/prompts. {NEXT_THREADS}
      </p>
    </div>
  )
}

/**
 * A project's trust, read whenever `active` turns on — the page at once, a confirmation each time it
 * opens, so it names the files as they are now. Undefined while the read is out; the setter puts in
 * the trust a change answered.
 */
export function useProjectTrust(
  projectId: string,
  active: boolean,
  fetchImpl: FetchLike | undefined,
): [ProjectRequestOutcome<EnsoProjectTrust> | undefined, (trust: EnsoProjectTrust) => void] {
  const [read, setRead] = useState<ProjectRequestOutcome<EnsoProjectTrust> | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    let current = true
    setRead(undefined)
    void requestProjectTrust(projectId, undefined, fetchImpl).then((outcome) => {
      if (current) setRead(outcome)
    })
    return (): void => {
      current = false
    }
  }, [projectId, active, fetchImpl])
  return [read, (trust: EnsoProjectTrust) => setRead({ kind: 'ok', value: trust })]
}

/** What a confirmation's change button says and does. */
interface TrustChange {
  readonly label: string
  readonly busyLabel: string
  readonly destructive: boolean
  readonly disabled: boolean
  readonly onConfirm: () => void
}

/** The shell both confirmations share: what the change does, why it failed, and Cancel beside the change. */
function TrustConfirm({
  open,
  onOpenChange,
  title,
  description,
  children,
  failure,
  busy,
  cancelLabel,
  change,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children?: React.ReactNode
  failure: string | undefined
  busy: boolean
  cancelLabel: string
  change: TrustChange
}): React.ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {failure === undefined ? null : (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={change.destructive ? 'destructive' : 'default'}
            disabled={busy || change.disabled}
            onClick={change.onConfirm}
          >
            {busy ? change.busyLabel : change.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** What the trust read found: still reading, why it could not, or the files and their commands. */
function TrustRead({ read }: { read: ProjectRequestOutcome<EnsoProjectTrust> | undefined }): React.ReactNode {
  if (read === undefined) return <p className="text-sm text-muted-foreground">Reading its files…</p>
  if (read.kind === 'ok') return <TrustDisclosure trust={read.value} />
  return (
    <p role="alert" className="text-sm text-destructive">
      Its files could not be read, so nothing can be trusted from here: {read.reason}
    </p>
  )
}

/** A confirmation's state, as its owner holds it. */
interface ConfirmState {
  readonly title: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly busy: boolean
  /** Why the change was not saved, in the owner's words; kept in the dialog until it closes. */
  readonly failure: string | undefined
}

export interface TrustDialogProps extends ConfirmState {
  readonly projectId: string
  /** Trust it: the owner sends the PUT and says how it went (`failure`). */
  readonly onTrust: () => void
  /** What leaving without trusting is called: Cancel on the page, Not now after Add project. */
  readonly cancelLabel: string
  readonly fetch?: FetchLike | undefined
}

/** Trust this project? — what it turns on, read now; Trust project is offered only once that is read. */
export function TrustDialog(props: TrustDialogProps): React.ReactNode {
  const [read] = useProjectTrust(props.projectId, props.open, props.fetch)
  return (
    <TrustConfirm
      {...props}
      title={`Trust ${props.title}?`}
      description="Enso will read this project’s own settings, and run their setup commands on this machine in every new tree."
      change={{
        label: 'Trust project',
        busyLabel: 'Trusting…',
        destructive: false,
        disabled: read?.kind !== 'ok',
        onConfirm: props.onTrust,
      }}
    >
      <TrustRead read={read} />
    </TrustConfirm>
  )
}

/** Revoke trust in this project? — what stops, and that a new thread will not ask again. */
export function RevokeDialog(props: ConfirmState & { readonly onRevoke: () => void }): React.ReactNode {
  return (
    <TrustConfirm
      {...props}
      title={`Revoke trust in ${props.title}?`}
      description={`Enso stops reading this project’s own settings (${OWN_FILES}) and its .pi/ folder, so their setup commands no longer run in a new tree. ${OPEN_THREADS_REVOKED} It is saved as not trusted, so a new thread doesn’t ask: trust it again here.`}
      cancelLabel="Cancel"
      change={{
        label: 'Revoke trust',
        busyLabel: 'Revoking…',
        destructive: true,
        disabled: false,
        onConfirm: props.onRevoke,
      }}
    />
  )
}
