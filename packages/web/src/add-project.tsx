import type { EnsoDirectoryListing, EnsoProject } from '@enso/core'
import { ArrowUpIcon, ChevronRightIcon, FolderIcon, GitBranchIcon, LockIcon, TriangleAlertIcon } from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { Checkbox } from './components/ui/checkbox.tsx'
import { Field, FieldDescription, FieldError, FieldLabel } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { cn } from './lib/utils.ts'
import { browseDirectories, registerProject } from './project-list.ts'
import { type PageRoute, projectRoute } from './thread-url.ts'

/**
 * The Add project page (#395 slice 3, #866, a page since #872): choose a folder — browse from the
 * home folder, or from the roots when the user's config declares any (`ENSO_HOME/config.json`), or
 * type its path — then confirm what pi can reach there and the name Enso shows it by. Only what the
 * server would register can be chosen (`projects.ts`): resolved, never hidden unless hidden folders
 * are shown, never the home folder or one holding it, never Enso's own home. Every refusal is the
 * server's, in its words, and says why; a folder that already is a project says which, and opens it.
 * Nothing registers before the person has confirmed.
 */
export interface AddProjectPageProps {
  /** The listed projects: a folder that already is one is said as such, with the way to it. */
  readonly projects: readonly EnsoProject[]
  readonly onOpen: (route: PageRoute) => void
  /** The project this page just registered: the page reads the projects again, then shows its page. */
  readonly onAdded: (project: EnsoProject) => void
  /** Injected by tests; the page's global by default. */
  readonly fetch?: FetchLike
}

type Browsing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly listing: EnsoDirectoryListing }
  | { readonly kind: 'failed'; readonly reason: string }

/** Why a folder was not taken: the server's words, and the project it already is, when it is one. */
interface Refusal {
  readonly text: string
  readonly project?: EnsoProject
}

/** The folder chosen in step 1, held while step 2 says what adding it means. */
interface Chosen {
  readonly folder: string
  /** Chosen with hidden folders shown: the registration says so, as the server requires (#866). */
  readonly hidden: boolean
}

/** What the page says when there is no folder to start from: every declared root is gone from disk. */
export const NO_START = 'none of the folders to start from exists — type a path above'

/** What step 2 says when the name is left empty: a project is shown by its name, so it needs one. */
export const NAME_NEEDED = 'Give the project a name.'

/** A folder that already is a project, said with which one it is. */
export function alreadyAProject(project: EnsoProject): Refusal {
  return { text: `That folder is already a project: ${project.title}.`, project }
}

/**
 * Whether `listing`'s folder can be chosen, or why not: already a project, or the server's refusal.
 * `listing.path` and a project's path are both canonical, so they compare as they are.
 */
function refusalOf(listing: EnsoDirectoryListing, projects: readonly EnsoProject[]): Refusal | undefined {
  const project = projects.find((candidate) => candidate.path === listing.path)
  if (project !== undefined) return alreadyAProject(project)
  if (listing.registrable) return undefined
  return listing.refusal === undefined ? undefined : { text: listing.refusal }
}

/** The listing at `path` (`null`: where browsing starts), read again whenever it moves or shows hidden folders. */
function useBrowsing(path: string | null, hidden: boolean, fetchImpl: FetchLike | undefined): Browsing {
  const [browsing, setBrowsing] = useState<Browsing>({ kind: 'loading' })
  useEffect(() => {
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
  }, [path, hidden, fetchImpl])
  return browsing
}

/** Step 1 and step 2, the one on screen marked. */
function Steps({ confirming }: { confirming: boolean }): React.ReactNode {
  const steps = [
    ['Choose a folder', !confirming],
    ['Confirm access', confirming],
  ] as const
  return (
    <ol aria-label="Steps" className="flex items-center gap-3 text-sm">
      {steps.map(([label, current], index) => (
        <li
          key={label}
          aria-current={current ? 'step' : undefined}
          className={cn('flex items-center gap-2', current ? 'font-medium' : 'text-muted-foreground')}
        >
          <span
            className={cn(
              'grid size-5 place-items-center rounded-full border text-xs',
              current ? 'border-primary bg-primary text-primary-foreground' : undefined,
            )}
          >
            {index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  )
}

/**
 * A refusal, said where the choice was made; one that names a project opens it. `quiet`: the folder
 * browsed to is described, not a choice refused — said in muted words, not as an alert.
 */
function RefusalLine({
  refusal,
  onOpen,
  id,
  quiet = false,
}: {
  refusal: Refusal
  onOpen: (route: PageRoute) => void
  id?: string
  quiet?: boolean
}): React.ReactNode {
  const { project } = refusal
  return (
    <p
      id={id}
      role={quiet ? undefined : 'alert'}
      className={cn('flex items-start gap-1.5 text-sm', quiet ? 'text-muted-foreground' : 'text-destructive')}
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {refusal.text}
        {project === undefined ? null : (
          <>
            {' '}
            <button
              type="button"
              className="font-medium underline underline-offset-2"
              onClick={() => onOpen(projectRoute(project.projectId))}
            >
              Open it
            </button>
          </>
        )}
      </span>
    </p>
  )
}

/** A folder's path, typed or pasted (`~/` allowed): the server resolves it, and says why when it is not one. */
function PathField({
  typed,
  onTyped,
  onUse,
  refusal,
  onOpen,
}: {
  typed: string
  onTyped: (typed: string) => void
  onUse: (path: string) => void
  refusal: Refusal | undefined
  onOpen: (route: PageRoute) => void
}): React.ReactNode {
  const inputId = useId()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const path = typed.trim()
    if (path.length > 0) onUse(path)
  }
  return (
    <form onSubmit={submit} className="grid gap-2">
      <FieldLabel htmlFor={inputId}>Folder path</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={inputId}
          className="font-mono"
          placeholder="~/repo/my-project"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={refusal !== undefined}
          aria-describedby={refusal === undefined ? undefined : `${inputId}-refusal`}
          value={typed}
          onChange={(event): void => onTyped(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={typed.trim().length === 0}>
          Use this path
        </Button>
      </div>
      <FieldDescription>Paste a path (~/ works), or pick a folder below.</FieldDescription>
      {refusal === undefined ? null : <RefusalLine id={`${inputId}-refusal`} refusal={refusal} onOpen={onOpen} />}
    </form>
  )
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
    <ul aria-label="folders" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto p-1">
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
              <span className="shrink-0 rounded-full border px-2 font-mono text-xs text-muted-foreground">
                already a project
              </span>
            )}
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
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

/** Browsing: the folder on screen and **Choose this folder** — or why it can't be chosen — and the folders inside it. */
function BrowsePane({
  browsing,
  refusal,
  onMove,
  onChoose,
  onOpen,
}: {
  browsing: Browsing
  refusal: Refusal | undefined
  onMove: (path: string | null) => void
  onChoose: (folder: string) => void
  onOpen: (route: PageRoute) => void
}): React.ReactNode {
  const listing = browsing.kind === 'loaded' ? browsing.listing : undefined
  const choosable = listing?.path != null && refusal === undefined
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">Or browse</span>
      <div className="rounded-md border">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">
            {listing?.path ?? 'where to start'}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={!choosable}
            onClick={() => (listing?.path == null ? undefined : onChoose(listing.path))}
          >
            Choose this folder
          </Button>
        </div>
        {browsing.kind === 'loading' ? <p className="p-3 text-sm text-muted-foreground">reading folders…</p> : null}
        {browsing.kind === 'failed' ? <FieldError className="p-3">{browsing.reason}</FieldError> : null}
        {listing === undefined ? null : <DirectoryList listing={listing} onOpen={onMove} />}
      </div>
      {refusal === undefined ? null : <RefusalLine refusal={refusal} onOpen={onOpen} quiet />}
    </div>
  )
}

/** The hidden-folders toggle (#866, kept by #868's decision): off on every visit, as the guardrail is. */
function HiddenToggle({ hidden, onHidden }: { hidden: boolean; onHidden: (hidden: boolean) => void }): React.ReactNode {
  const toggleId = useId()
  return (
    <Field orientation="horizontal">
      <Checkbox
        id={toggleId}
        checked={hidden}
        onCheckedChange={(checked: boolean | 'indeterminate'): void => onHidden(checked === true)}
      />
      <FieldLabel htmlFor={toggleId}>show hidden folders</FieldLabel>
    </Field>
  )
}

/** What adding the folder lets pi reach (#866, #872): the folder whole — Enso does not sandbox agents — a tree of it, and the permission rules. */
function ReachList({ chosen, onOpen }: { chosen: Chosen; onOpen: (route: PageRoute) => void }): React.ReactNode {
  const hiddenFolder = chosen.folder.split('/').some((segment) => segment.startsWith('.'))
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">What pi can reach here</span>
      <ul className="grid gap-3 text-sm">
        <li className="flex gap-2.5">
          <FolderIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="grid gap-0.5">
            <strong className="font-medium">Read and change files in this folder</strong>
            <span className="text-muted-foreground">
              <span className="font-mono break-all">{chosen.folder}</span> and everything inside it. Enso does not
              sandbox agents, so that is the whole of what this folder lets one reach.
              {hiddenFolder ? ' It is inside a hidden folder, where tools keep their settings and keys.' : null}
            </span>
          </span>
        </li>
        <li className="flex gap-2.5">
          <GitBranchIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="grid gap-0.5">
            <strong className="font-medium">Work in a tree of it, as the project’s tree mode says</strong>
            <span className="text-muted-foreground">
              A new thread gets a worktree of this folder unless your settings say otherwise, so your checkout stays as
              you left it. The project’s Worktrees tab can make it a copy, or the folder itself.
            </span>
          </span>
        </li>
        <li className="flex gap-2.5">
          <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="grid gap-0.5">
            <strong className="font-medium">Follow your permission rules</strong>
            <span className="text-muted-foreground">
              What pi may run without asking is set in{' '}
              <button
                type="button"
                className="text-foreground underline underline-offset-2"
                onClick={() => onOpen({ kind: 'settings', section: 'permissions' })}
              >
                Settings › Permissions
              </button>
              .
            </span>
          </span>
        </li>
      </ul>
    </div>
  )
}

/** The name Enso shows the project by: the folder's name to start with, and never empty. */
function NameField({
  name,
  onName,
  error,
}: {
  name: string
  onName: (name: string) => void
  error: string | undefined
}): React.ReactNode {
  const inputId = useId()
  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={inputId}>Name in Enso</FieldLabel>
      <Input
        id={inputId}
        autoComplete="off"
        aria-invalid={error !== undefined}
        aria-describedby={`${inputId}-help`}
        value={name}
        onChange={(event): void => onName(event.target.value)}
      />
      <FieldDescription id={`${inputId}-help`}>
        Shown in the rail and on the project’s page. It doesn’t rename the folder.
      </FieldDescription>
      {error === undefined ? null : (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
          <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Step 2, Confirm access: the folder with **Change**, its name, what pi can reach there; **Back**
 * registers nothing, **Add project** registers it under the name given — or says why not, and
 * opens the project the folder already is.
 */
function ConfirmStep({
  chosen,
  onBack,
  onOpen,
  onAdded,
  fetchImpl,
}: {
  chosen: Chosen
  onBack: () => void
  onOpen: (route: PageRoute) => void
  onAdded: (project: EnsoProject) => void
  fetchImpl: FetchLike | undefined
}): React.ReactNode {
  const [name, setName] = useState(
    () => chosen.folder.split('/').findLast((segment) => segment.length > 0) ?? chosen.folder,
  )
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const title = name.trim()
    setNameError(title.length === 0 ? NAME_NEEDED : undefined)
    if (title.length === 0) return
    setAdding(true)
    const outcome = await registerProject({ path: chosen.folder, title, hidden: chosen.hidden }, fetchImpl)
    setAdding(false)
    if (outcome.kind === 'refused') setRefusal({ text: outcome.reason })
    else if (outcome.value.added) onAdded(outcome.value.project)
    else setRefusal(alreadyAProject(outcome.value.project))
  }
  return (
    <form onSubmit={(event) => void add(event)} noValidate className="grid gap-5 rounded-lg border bg-card p-6">
      <div className="grid gap-2">
        <span className="text-sm font-medium">Folder</span>
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 font-mono text-sm break-all">{chosen.folder}</span>
          <Button type="button" variant="outline" disabled={adding} onClick={onBack}>
            Change
          </Button>
        </div>
      </div>
      <NameField
        name={name}
        onName={(next) => {
          setName(next)
          setNameError(undefined)
        }}
        error={nameError}
      />
      <ReachList chosen={chosen} onOpen={onOpen} />
      {refusal === undefined ? null : <RefusalLine refusal={refusal} onOpen={onOpen} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={adding} onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={adding}>
          {adding ? 'Adding…' : 'Add project'}
        </Button>
      </div>
    </form>
  )
}

/** Step 1, Choose a folder: the path field, browsing, and whether hidden folders show. */
function ChooseStep({
  projects,
  typed,
  onTyped,
  path,
  onPath,
  hidden,
  onHidden,
  onChosen,
  onOpen,
  fetchImpl,
}: {
  projects: readonly EnsoProject[]
  typed: string
  onTyped: (typed: string) => void
  path: string | null
  onPath: (path: string | null) => void
  hidden: boolean
  onHidden: (hidden: boolean) => void
  onChosen: (chosen: Chosen) => void
  onOpen: (route: PageRoute) => void
  fetchImpl: FetchLike | undefined
}): React.ReactNode {
  const browsing = useBrowsing(path, hidden, fetchImpl)
  const [typedRefusal, setTypedRefusal] = useState<Refusal | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  // A typed path is read as browsing it would be — resolved by the server — and taken only if the listing says it may be.
  const takePath = async (asked: string): Promise<void> => {
    setChecking(true)
    const outcome = await browseDirectories(asked, hidden, fetchImpl)
    setChecking(false)
    if (outcome.kind === 'refused') {
      setTypedRefusal({ text: outcome.reason })
      return
    }
    const refusal = refusalOf(outcome.value, projects)
    setTypedRefusal(refusal)
    if (refusal === undefined && outcome.value.path !== null) onChosen({ folder: outcome.value.path, hidden })
  }
  const browseRefusal = browsing.kind === 'loaded' ? refusalOf(browsing.listing, projects) : undefined
  return (
    <div className="grid gap-5 rounded-lg border bg-card p-6" aria-busy={checking}>
      <PathField
        typed={typed}
        onTyped={(next) => {
          onTyped(next)
          setTypedRefusal(undefined)
        }}
        onUse={(asked) => void takePath(asked)}
        refusal={typedRefusal}
        onOpen={onOpen}
      />
      <BrowsePane
        browsing={browsing}
        refusal={browseRefusal}
        onMove={onPath}
        onChoose={(folder) => onChosen({ folder, hidden })}
        onOpen={onOpen}
      />
      <HiddenToggle hidden={hidden} onHidden={onHidden} />
    </div>
  )
}

export function AddProjectPage({ projects, onOpen, onAdded, fetch: fetchImpl }: AddProjectPageProps): React.ReactNode {
  // Held across the steps: Change and Back come back to the path typed and the folder browsed.
  const [typed, setTyped] = useState('')
  const [path, setPath] = useState<string | null>(null)
  // Hidden folders listed, browsable and addable (#866) — off on every visit, as the guardrail is.
  const [hidden, setHidden] = useState(false)
  const [chosen, setChosen] = useState<Chosen | undefined>(undefined)
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4 p-4 md:p-6">
      <Steps confirming={chosen !== undefined} />
      {chosen === undefined ? (
        <ChooseStep
          projects={projects}
          typed={typed}
          onTyped={setTyped}
          path={path}
          onPath={setPath}
          hidden={hidden}
          onHidden={setHidden}
          onChosen={setChosen}
          onOpen={onOpen}
          fetchImpl={fetchImpl}
        />
      ) : (
        <ConfirmStep
          key={chosen.folder}
          chosen={chosen}
          onBack={() => setChosen(undefined)}
          onOpen={onOpen}
          onAdded={onAdded}
          fetchImpl={fetchImpl}
        />
      )}
    </div>
  )
}
