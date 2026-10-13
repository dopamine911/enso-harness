import type {
  EnsoLibraryPrompt,
  EnsoLibraryPromptCategory,
  EnsoLibraryPromptListing,
  EnsoSystemPromptPreview,
} from '@enso/core'
import { TextPart } from '@tanstack/ai-react/ui'
import { CopyIcon, FilePlusIcon, SaveIcon, ScrollTextIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from './components/ai-elements/artifact.tsx'
import { Button } from './components/ui/button.tsx'
import { Field, FieldError, FieldLabel } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { Textarea } from './components/ui/textarea.tsx'
import { type Loading, useFreshRead } from './fresh-read.ts'
import { HeaderDialog } from './header-dialog.tsx'
import { TEXT_PART_COMPONENTS } from './markdown-image.tsx'
import {
  blankDraft,
  CATEGORY_LABELS,
  copyDraft,
  type EditorDraft,
  type EditorState,
  isDirty,
  newState,
  openedState,
  savedState,
  runtimeDefaultDraft,
  saveDraft,
} from './prompt-editor-state.ts'
import {
  deleteLibraryPrompt,
  fetchLibraryPrompt,
  fetchProjectPrompt,
  fetchProjectPromptLibrary,
  fetchPromptLibrary,
  fetchSystemPromptPreview,
  type LibraryListing,
  type LibraryPromptRead,
  type ProjectLibraryRead,
} from './prompt-library-connection.ts'
import { type HeadState, PromptBreakdown, PromptSizeBar, useDraftHead } from './prompt-size.tsx'
import { Choice } from './view-parts.tsx'

/**
 * The prompt manager (#443): one place to read, write and organise the prompts a session runs with —
 * the header's scroll button, beside Settings, because the library is the user's, not a thread's.
 *
 * On the left, pi's default (read-only — pi's own rendering, on the thread on screen), then the
 * library by category, then every file the library refused, by name. On the right, the editor: the
 * file name and fields, the markdown as source or rendered, the size bar, and — for a system or
 * append prompt — what the model will actually receive with it, pi's sections and tool definitions
 * included (`prompt-size.tsx`). A new prompt starts blank, as a copy of pi's default, or as a copy of
 * another. Unsaved changes are marked, and moving away from them asks first; delete asks too.
 *
 * The editor is ai-elements' `artifact.tsx` (ported) over shadcn's `Textarea` in the mono face;
 * upstream has no markdown editor, and the rendered view is the chat's own safe markdown
 * (`TextPart` with `TEXT_PART_COMPONENTS`, whose remote images wait for a click).
 *
 * ⚠ A PROJECT'S PROMPTS ARE READ HERE, NEVER WRITTEN (#470). Below the user's library, the thread's
 * project library (`<project>/.enso/prompts`) when the thread trusts the project: each opens
 * read-only, with what the model would receive with it, and can be copied into the user's library.
 * Its files are committed and shared, so they are changed in the repository, not from here.
 */

type Selection =
  | { readonly kind: 'pi-default' }
  | { readonly kind: 'prompt'; readonly id: string }
  /** A project prompt (#470), open read-only. */
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'new' }

/** A move held behind the discard guard, as data: open a selection, start a new draft, or close the manager. */
type Move =
  | { readonly kind: 'select'; readonly next: Selection }
  | { readonly kind: 'start'; readonly state: EditorState }
  | { readonly kind: 'close' }

type TextView = 'source' | 'preview'
const TEXT_VIEWS: ReadonlyArray<readonly [TextView, string]> = [
  ['source', 'source'],
  ['preview', 'preview'],
]

const CATEGORY_ORDER: readonly EnsoLibraryPromptCategory[] = ['system', 'append', 'session']
const CATEGORY_HEADINGS: Readonly<Record<EnsoLibraryPromptCategory, string>> = {
  system: 'System prompts',
  append: 'Append prompts',
  session: 'Session prompts',
}

type LibraryState = { readonly kind: 'loading' } | LibraryListing

function listingOf(library: LibraryState): EnsoLibraryPromptListing | undefined {
  return library.kind === 'loaded' ? library.listing : undefined
}

type ProjectState = Loading | { readonly kind: 'none' } | ProjectLibraryRead

const NO_PROJECT: ProjectState = { kind: 'none' }

/** The thread's project library (#470), read when the manager opens; none without a thread. */
function useProjectLibrary(
  open: boolean,
  threadId: string | undefined,
  fetchImpl: FetchLike | undefined,
): ProjectState {
  const read = useFreshRead(open && threadId !== undefined, threadId ?? '', () =>
    fetchProjectPromptLibrary(threadId ?? '', fetchImpl),
  )
  return threadId === undefined ? NO_PROJECT : read
}

/** The library and pi's default, read when the manager opens; `reload` after a write. */
function useLibrary(
  open: boolean,
  threadId: string | undefined,
  fetchImpl: FetchLike | undefined,
): { library: LibraryState; project: ProjectState; runtimeDefault: HeadState; reload: () => void } {
  const project = useProjectLibrary(open, threadId, fetchImpl)
  const [library, setLibrary] = useState<LibraryState>({ kind: 'loading' })
  const [runtimeDefault, setRuntimeDefault] = useState<HeadState>({ kind: 'none' })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (!open) return
    let current = true
    void fetchPromptLibrary(fetchImpl).then((read) => {
      if (current) setLibrary(read)
    })
    return (): void => {
      current = false
    }
  }, [open, fetchImpl, generation])
  useEffect(() => {
    if (!open || threadId === undefined) {
      setRuntimeDefault(
        threadId === undefined ? { kind: 'unavailable', detail: 'no thread to render it on' } : { kind: 'none' },
      )
      return
    }
    let current = true
    setRuntimeDefault({ kind: 'loading' })
    void fetchSystemPromptPreview(threadId, null, fetchImpl).then((read) => {
      if (current) setRuntimeDefault(read)
    })
    return (): void => {
      current = false
    }
  }, [open, threadId, fetchImpl])
  return { library, project, runtimeDefault, reload: useCallback(() => setGeneration((value) => value + 1), []) }
}

function ListButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-popover aria-[current]:bg-popover aria-[current]:font-semibold"
    >
      {children}
    </button>
  )
}

/**
 * The project's prompts (#470), every category in one read-only section — or where they are and
 * that the project is not trusted, or why they could not be listed.
 */
function ProjectSection({
  project,
  selection,
  onSelect,
}: {
  project: ProjectState
  selection: Selection
  onSelect: (next: Selection) => void
}): React.ReactNode {
  if (project.kind === 'loading' || project.kind === 'none') return null
  if (project.kind === 'unavailable') return <FieldError>project prompts: {project.detail}</FieldError>
  const heading = <h3 className="px-2 text-xs font-semibold text-muted-foreground">Project prompts</h3>
  if (project.project.kind === 'untrusted') {
    return (
      <section aria-label="Project prompts" className="grid gap-0.5">
        {heading}
        <p className="px-2 text-xs text-muted-foreground">
          not read: the project is not trusted ({project.project.directory})
        </p>
      </section>
    )
  }
  const { prompts, refused } = project.project.listing
  if (prompts.length === 0 && refused.length === 0) return null
  return (
    <section aria-label="Project prompts" className="grid gap-0.5">
      {heading}
      {prompts.map((prompt) => (
        <ListButton
          key={prompt.id}
          selected={selection.kind === 'project' && selection.id === prompt.id}
          onSelect={() => onSelect({ kind: 'project', id: prompt.id })}
        >
          <span className="truncate">{prompt.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {prompt.category} · ≈{prompt.tokens.toLocaleString('en')}
          </span>
        </ListButton>
      ))}
      {refused.length === 0 ? null : (
        <FieldError>
          {refused.map((file) => (
            <span key={file.file} className="block">
              refused project {file.reason}
            </span>
          ))}
        </FieldError>
      )}
    </section>
  )
}

function PromptList({
  library,
  project,
  selection,
  onSelect,
}: {
  library: LibraryState
  project: ProjectState
  selection: Selection
  onSelect: (next: Selection) => void
}): React.ReactNode {
  const listing = listingOf(library)
  return (
    <nav aria-label="prompts" className="grid flex-1 content-start gap-3 overflow-y-auto border-r p-3">
      <ListButton selected={selection.kind === 'pi-default'} onSelect={() => onSelect({ kind: 'pi-default' })}>
        <span>pi default</span>
        <span className="text-xs text-muted-foreground">read-only</span>
      </ListButton>
      {library.kind === 'unavailable' ? <FieldError>prompt library: {library.detail}</FieldError> : null}
      {CATEGORY_ORDER.map((category) => {
        const prompts = listing?.prompts.filter((prompt) => prompt.category === category) ?? []
        return prompts.length === 0 ? null : (
          <section key={category} aria-label={CATEGORY_HEADINGS[category]} className="grid gap-0.5">
            <h3 className="px-2 text-xs font-semibold text-muted-foreground">{CATEGORY_HEADINGS[category]}</h3>
            {prompts.map((prompt) => (
              <ListButton
                key={prompt.id}
                selected={selection.kind === 'prompt' && selection.id === prompt.id}
                onSelect={() => onSelect({ kind: 'prompt', id: prompt.id })}
              >
                <span className="truncate">{prompt.name}</span>
                <span className="font-mono text-xs text-muted-foreground">≈{prompt.tokens.toLocaleString('en')}</span>
              </ListButton>
            ))}
          </section>
        )
      })}
      {listing === undefined || listing.refused.length === 0 ? null : (
        <FieldError>
          {listing.refused.map((refused) => (
            <span key={refused.file} className="block">
              refused {refused.reason}
            </span>
          ))}
        </FieldError>
      )}
      <ProjectSection project={project} selection={selection} onSelect={onSelect} />
    </nav>
  )
}

/** The markdown, as source (monospace, editable) or rendered. */
function BodyField({
  body,
  onChange,
  readOnly,
}: {
  body: string
  onChange?: (body: string) => void
  readOnly: boolean
}): React.ReactNode {
  const [view, setView] = useState<TextView>('source')
  return (
    <Field className="min-h-0">
      <div className="flex items-center justify-between">
        <FieldLabel htmlFor="prompt-body">Markdown</FieldLabel>
        <Choice label="show the markdown" value={view} options={TEXT_VIEWS} onChange={setView} />
      </div>
      {view === 'source' ? (
        <Textarea
          id="prompt-body"
          value={body}
          readOnly={readOnly}
          rows={16}
          spellCheck={false}
          className="min-h-72 font-mono text-sm"
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => onChange?.(event.target.value)}
        />
      ) : (
        <div
          aria-label="rendered markdown"
          className="prose min-h-72 max-w-none rounded-md border p-3 text-sm dark:prose-invert"
        >
          <TextPart components={TEXT_PART_COMPONENTS} content={body} />
        </div>
      )}
    </Field>
  )
}

/** pi's default as pi renders it on the thread on screen — read-only, and copyable as a start. */
function RuntimeDefaultPanel({
  head,
  onCopy,
}: {
  head: HeadState
  onCopy: (preview: EnsoSystemPromptPreview) => void
}): React.ReactNode {
  const preview = head.kind === 'loaded' ? head.preview : undefined
  return (
    <Artifact className="h-full">
      <ArtifactHeader>
        <div>
          <ArtifactTitle>pi default</ArtifactTitle>
          <ArtifactDescription>what pi builds for this thread — read-only</ArtifactDescription>
        </div>
        <ArtifactActions>
          <ArtifactAction
            icon={CopyIcon}
            label="Copy as a new prompt"
            disabled={preview === undefined}
            onClick={() => (preview === undefined ? undefined : onCopy(preview))}
          />
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className="grid content-start gap-3">
        <BodyField body={preview?.sections.map((section) => section.text).join('\n\n') ?? ''} readOnly={true} />
      </ArtifactContent>
      <PromptBreakdown head={head} />
    </Artifact>
  )
}

/** A project prompt as a draft for the user's library: the same file name and fields, not yet saved. */
function userCopyOf(prompt: EnsoLibraryPrompt): EditorDraft {
  const { id, name, description, category, body } = prompt
  return { id, name, description, category, body }
}

/** A project prompt, read fresh each time it is selected; `undefined` while the read is in flight. */
function useProjectPrompt(
  threadId: string | undefined,
  id: string,
  fetchImpl: FetchLike | undefined,
): LibraryPromptRead | undefined {
  const [read, setRead] = useState<LibraryPromptRead | undefined>(undefined)
  useEffect(() => {
    if (threadId === undefined) return
    let current = true
    setRead(undefined)
    void fetchProjectPrompt(threadId, id, fetchImpl).then((loaded) => {
      if (current) setRead(loaded)
    })
    return (): void => {
      current = false
    }
  }, [threadId, id, fetchImpl])
  return read
}

/**
 * A project prompt (#470), read-only: its fields, its markdown, and what the model would receive
 * with it. Copy puts it in the user's library as a new prompt under the same file name.
 */
function ProjectPromptPanel(props: {
  threadId: string | undefined
  id: string
  onCopy: (draft: EditorDraft) => void
  window: EnsoSystemPromptPreview | undefined
  fetch: FetchLike | undefined
}): React.ReactNode {
  const read = useProjectPrompt(props.threadId, props.id, props.fetch)
  if (read === undefined) return <p className="p-4 text-sm text-muted-foreground">opening…</p>
  if (read.kind === 'unavailable') return <FieldError>{read.detail}</FieldError>
  return <ProjectPromptView prompt={read.prompt} {...props} />
}

function ProjectPromptView(props: {
  prompt: EnsoLibraryPrompt
  threadId: string | undefined
  onCopy: (draft: EditorDraft) => void
  window: EnsoSystemPromptPreview | undefined
  fetch: FetchLike | undefined
}): React.ReactNode {
  const { prompt } = props
  const draft = userCopyOf(prompt)
  const head = useDraftHead(props.threadId, draft, props.fetch)
  return (
    <Artifact className="h-full">
      <ArtifactHeader>
        <div>
          <ArtifactTitle>{prompt.name}</ArtifactTitle>
          <ArtifactDescription>
            .enso/prompts/{prompt.id}.md · {CATEGORY_LABELS[prompt.category]} · the project's — read-only
          </ArtifactDescription>
        </div>
        <ArtifactActions>
          <ArtifactAction icon={CopyIcon} label="Copy to my library" onClick={() => props.onCopy(draft)} />
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className="grid content-start gap-3">
        {prompt.description.length === 0 ? null : <p className="text-sm text-muted-foreground">{prompt.description}</p>}
        <BodyField body={prompt.body} readOnly={true} />
      </ArtifactContent>
      <PromptSizeBar draft={draft} head={head} window={props.window} />
      <PromptBreakdown head={head} />
    </Artifact>
  )
}

/** One of the draft's text fields: its label over an input bound to one key. */
function DraftInput({
  field,
  label,
  draft,
  onChange,
  mono = false,
}: {
  field: 'name' | 'id' | 'description'
  label: string
  draft: EditorDraft
  onChange: (draft: EditorDraft) => void
  mono?: boolean
}): React.ReactNode {
  return (
    <Field>
      <FieldLabel htmlFor={`prompt-${field}`}>{label}</FieldLabel>
      <Input
        id={`prompt-${field}`}
        value={draft[field]}
        className={mono ? 'font-mono' : undefined}
        onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
      />
    </Field>
  )
}

/** The file's fields: its name on disk, what lists call it, one line about it, and where it goes. */
function DraftFields({
  draft,
  onChange,
}: {
  draft: EditorDraft
  onChange: (draft: EditorDraft) => void
}): React.ReactNode {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <DraftInput field="name" label="Name" draft={draft} onChange={onChange} />
      <DraftInput field="id" label="File" draft={draft} onChange={onChange} mono={true} />
      <DraftInput field="description" label="Description" draft={draft} onChange={onChange} />
      <Field>
        <FieldLabel htmlFor="prompt-category">Category</FieldLabel>
        <Select
          value={draft.category}
          onValueChange={(value: string) => {
            const category = CATEGORY_ORDER.find((candidate) => candidate === value)
            if (category !== undefined) onChange({ ...draft, category })
          }}
        >
          <SelectTrigger id="prompt-category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_ORDER.map((category) => (
              <SelectItem key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}

/** Delete, asked twice: the button, then the file named. */
function DeleteAction({
  id,
  disabled,
  onDelete,
}: {
  id: string | undefined
  disabled: boolean
  onDelete: () => void
}): React.ReactNode {
  const [asking, setAsking] = useState(false)
  if (id === undefined) return null
  if (!asking) {
    return <ArtifactAction icon={Trash2Icon} label="Delete" disabled={disabled} onClick={() => setAsking(true)} />
  }
  return (
    <span role="alert" className="flex items-center gap-1 text-xs">
      delete {id}.md?
      <Button variant="destructive" size="sm" disabled={disabled} onClick={onDelete}>
        Delete
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Keep
      </Button>
    </span>
  )
}

function EditorPanel(props: {
  state: EditorState
  onChange: (draft: EditorDraft) => void
  onSave: () => void
  onCopy: () => void
  onDelete: () => void
  refusal: string | undefined
  /** The disk changed under the open file: the save or the delete it refused. */
  conflict: 'save' | 'delete' | undefined
  onReopen: () => void
  onOverwrite: () => void
  /** A save or delete is in flight: Save and Delete wait for it. */
  working: boolean
  threadId: string | undefined
  window: EnsoSystemPromptPreview | undefined
  fetch: FetchLike | undefined
}): React.ReactNode {
  const { state, onChange } = props
  const head = useDraftHead(props.threadId, state.draft, props.fetch)
  const dirty = isDirty(state)
  return (
    <Artifact className="h-full">
      <ArtifactHeader>
        <div>
          <ArtifactTitle>
            {state.draft.name.trim() || 'untitled prompt'}
            {dirty ? (
              <span aria-label="unsaved changes" className="ml-2 text-primary">
                ● unsaved
              </span>
            ) : null}
          </ArtifactTitle>
          <ArtifactDescription>
            {state.saved === undefined ? 'not saved yet' : `${state.saved.id}.md`}
          </ArtifactDescription>
        </div>
        <ArtifactActions>
          <ArtifactAction icon={SaveIcon} label="Save" disabled={!dirty || props.working} onClick={props.onSave} />
          <ArtifactAction icon={CopyIcon} label="Copy" onClick={props.onCopy} />
          {/* Keyed by the file: a confirmation asked for one file never carries over to the next one opened or saved. */}
          <DeleteAction key={state.saved?.id} id={state.saved?.id} disabled={props.working} onDelete={props.onDelete} />
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className="grid content-start gap-3">
        <DraftFields draft={state.draft} onChange={onChange} />
        {props.refusal === undefined ? null : <FieldError>{props.refusal}</FieldError>}
        {props.conflict === undefined ? null : (
          <ConflictActions
            conflict={props.conflict}
            working={props.working}
            onReopen={props.onReopen}
            onOverwrite={props.onOverwrite}
          />
        )}
        <BodyField body={state.draft.body} readOnly={false} onChange={(body) => onChange({ ...state.draft, body })} />
      </ArtifactContent>
      <PromptSizeBar draft={state.draft} head={head} window={props.window} />
      <PromptBreakdown head={head} />
    </Artifact>
  )
}

/**
 * The open file changed on disk since it was read (#443): take it as it is now — the draft goes — or,
 * for a save, put the draft over it. Nothing was written until one of them is chosen.
 */
function ConflictActions(props: {
  conflict: 'save' | 'delete'
  working: boolean
  onReopen: () => void
  onOverwrite: () => void
}): React.ReactNode {
  return (
    <div role="alert" aria-label="changed on disk" className="flex flex-wrap items-center gap-2 text-sm">
      <Button variant="outline" size="sm" disabled={props.working} onClick={props.onReopen}>
        Reload from disk
      </Button>
      {props.conflict === 'save' ? (
        <Button variant="destructive" size="sm" disabled={props.working} onClick={props.onOverwrite}>
          Overwrite with mine
        </Button>
      ) : null}
    </div>
  )
}

/** Moving away from unsaved changes: asked, with the choice to stay. */
function DiscardGuard({ onDiscard, onStay }: { onDiscard: () => void; onStay: () => void }): React.ReactNode {
  return (
    <div role="alert" className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-sm">
      <span className="flex-1">This prompt has unsaved changes.</span>
      <Button variant="destructive" size="sm" onClick={onDiscard}>
        Discard them
      </Button>
      <Button variant="ghost" size="sm" onClick={onStay}>
        Keep editing
      </Button>
    </div>
  )
}

/**
 * What the manager has open: the selection, the editor's state, and a move waiting on the discard
 * guard. Held by the dialog, not its content, so a close is a move like any other: asked first when
 * the draft is unsaved (`close`), and `onClosed` only once it is not — or once it was discarded.
 */
function useManagerState(
  library: LibraryState,
  reload: () => void,
  fetchImpl: FetchLike | undefined,
  onClosed: () => void,
): {
  selection: Selection
  editor: EditorState | undefined
  pending: Move | undefined
  refusal: string | undefined
  /**
   * The disk no longer holds the version the editor opened (#443): a `save` or a `delete` refused
   * with 412. `refusal` says why; the person reloads, or — for a save — overwrites.
   */
  conflict: 'save' | 'delete' | undefined
  /** A save or delete is in flight: both wait for it. */
  working: boolean
  select: (next: Selection) => void
  start: (state: EditorState) => void
  close: () => void
  change: (draft: EditorDraft) => void
  /** `overwrite`: the answer to a save's conflict — replace whatever is on disk with the draft. */
  save: (overwrite?: boolean) => Promise<void>
  remove: () => Promise<void>
  /** Read the open file again as it is on disk now, dropping the draft — the other answer to a conflict. */
  reopen: () => void
  settle: (discard: boolean) => void
} {
  const [selection, setSelection] = useState<Selection>({ kind: 'pi-default' })
  const [editor, setEditor] = useState<EditorState | undefined>(undefined)
  const [pending, setPending] = useState<Move | undefined>(undefined)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [conflict, setConflict] = useState<'save' | 'delete' | undefined>(undefined)
  // ⚠ One write at a time. A second Save while the first is in flight wrote the file twice and, on
  // a rename, deleted the old one twice — the second DELETE's 404 then read as a half-done rename.
  // The ref holds a double-click in one tick; the state disables the buttons meanwhile.
  const writing = useRef(false)
  const [working, setWorking] = useState(false)
  /** Takes the one write slot, or says it is taken; `release` gives it back when the write answered. */
  const claim = (): boolean => {
    if (writing.current) return false
    writing.current = true
    setWorking(true)
    return true
  }
  const release = (): void => {
    writing.current = false
    setWorking(false)
  }
  // A refused file is still a file: a new prompt or a rename onto its name would write over it unread.
  const listing = listingOf(library)
  const taken = new Set([
    ...(listing?.prompts.map((prompt) => prompt.id) ?? []),
    ...(listing?.refused.map((refused) => refused.file.replace(/\.md$/, '')) ?? []),
  ])
  // ⚠ Every move takes a new ticket; a prompt read, save or delete touches the editor only if its
  // ticket is still the latest. Otherwise a slow answer to an earlier selection lands after a later
  // one and fills (or empties) the editor while the list shows the later one selected.
  const moves = useRef(0)
  const open = (next: Selection, ticket: number): void => {
    setRefusal(undefined)
    setSelection(next)
    setEditor(undefined)
    if (next.kind !== 'prompt') return
    void fetchLibraryPrompt(next.id, fetchImpl).then((read) => {
      if (ticket !== moves.current) return
      if (read.kind === 'loaded') setEditor(openedState(read.prompt, read.etag))
      else setRefusal(read.detail)
    })
  }
  const perform = (move: Move): void => {
    moves.current += 1
    setRefusal(undefined)
    setConflict(undefined)
    if (move.kind === 'select') {
      open(move.next, moves.current)
      return
    }
    if (move.kind === 'close') {
      // Closed means gone: the next open starts on pi's default, as a fresh dialog did.
      setSelection({ kind: 'pi-default' })
      setEditor(undefined)
      onClosed()
      return
    }
    setSelection({ kind: 'new' })
    setEditor(move.state)
  }
  const guarded = (move: Move): void => {
    if (editor !== undefined && isDirty(editor)) setPending(move)
    else perform(move)
  }
  return {
    selection,
    editor,
    pending,
    refusal,
    conflict,
    working,
    select: (next) => guarded({ kind: 'select', next }),
    start: (state) => guarded({ kind: 'start', state }),
    close: () => guarded({ kind: 'close' }),
    change: (draft) => setEditor((state) => (state === undefined ? state : { ...state, draft })),
    save: async (overwrite = false) => {
      if (editor === undefined || !claim()) return
      const ticket = moves.current
      const outcome = await saveDraft(editor, taken, fetchImpl, overwrite).finally(release)
      if (outcome.kind === 'saved') reload()
      if (ticket !== moves.current) return
      if (outcome.kind !== 'saved') {
        setRefusal(outcome.reason)
        setConflict(outcome.kind === 'conflict' ? 'save' : undefined)
        return
      }
      setRefusal(outcome.warning)
      setConflict(undefined)
      // `savedState` is pure (prompt-editor-state.ts, its own test); the rule cannot see across the
      // module. An updater is needed: a draft typed on since the save went out is kept (#443).
      // react-doctor-disable-next-line no-side-effect-in-state-updater-function
      setEditor((current) => savedState(current, editor.draft, outcome.prompt, outcome.etag))
      setSelection({ kind: 'prompt', id: outcome.prompt.id })
      // Saved is what the guard was asking about: a move it held no longer needs asking.
      setPending(undefined)
    },
    remove: async () => {
      const saved = editor?.saved
      if (saved === undefined || !claim()) return
      const ticket = moves.current
      const removed = await deleteLibraryPrompt(saved.id, { kind: 'replace', etag: saved.etag }, fetchImpl).finally(
        release,
      )
      if (removed.kind === 'deleted') reload()
      if (ticket !== moves.current) return
      if (removed.kind !== 'deleted') {
        setRefusal(removed.detail)
        setConflict(removed.kind === 'conflict' ? 'delete' : undefined)
        return
      }
      setEditor(undefined)
      setSelection({ kind: 'pi-default' })
    },
    reopen: () => {
      const id = editor?.saved?.id
      if (id !== undefined) perform({ kind: 'select', next: { kind: 'prompt', id } })
    },
    settle: (discard) => {
      if (discard && pending !== undefined) perform(pending)
      setPending(undefined)
    },
  }
}

type ManagerState = ReturnType<typeof useManagerState>

/** What the right-hand side shows: pi's default, the editor, or why a prompt could not be opened. */
function SelectedPanel({
  manager,
  runtimeDefault,
  threadId,
  fetch: fetchImpl,
}: {
  manager: ManagerState
  runtimeDefault: HeadState
  threadId: string | undefined
  fetch: FetchLike | undefined
}): React.ReactNode {
  if (manager.selection.kind === 'pi-default') {
    return (
      <RuntimeDefaultPanel
        head={runtimeDefault}
        onCopy={(preview) => manager.start(newState(runtimeDefaultDraft(preview)))}
      />
    )
  }
  if (manager.selection.kind === 'project') {
    return (
      <ProjectPromptPanel
        key={manager.selection.id}
        threadId={threadId}
        id={manager.selection.id}
        onCopy={(draft) => manager.start(newState(draft))}
        window={runtimeDefault.kind === 'loaded' ? runtimeDefault.preview : undefined}
        fetch={fetchImpl}
      />
    )
  }
  const { editor } = manager
  if (editor === undefined) {
    return manager.refusal === undefined ? (
      <p className="p-4 text-sm text-muted-foreground">opening…</p>
    ) : (
      <FieldError>{manager.refusal}</FieldError>
    )
  }
  return (
    <EditorPanel
      state={editor}
      onChange={manager.change}
      onSave={() => void manager.save()}
      onCopy={() => manager.start(newState(copyDraft(editor.draft)))}
      onDelete={() => void manager.remove()}
      refusal={manager.refusal}
      conflict={manager.conflict}
      onReopen={manager.reopen}
      onOverwrite={() => void manager.save(true)}
      working={manager.working}
      threadId={threadId}
      window={runtimeDefault.kind === 'loaded' ? runtimeDefault.preview : undefined}
      fetch={fetchImpl}
    />
  )
}

function ManagerBody({
  library,
  project,
  runtimeDefault,
  manager,
  threadId,
  fetch: fetchImpl,
}: {
  library: LibraryState
  project: ProjectState
  runtimeDefault: HeadState
  manager: ManagerState
  threadId: string | undefined
  fetch: FetchLike | undefined
}): React.ReactNode {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border">
      <div className="flex min-h-0 w-64 shrink-0 flex-col">
        <div className="flex gap-1 border-b p-2">
          <Button variant="outline" size="sm" onClick={() => manager.start(newState(blankDraft()))}>
            <FilePlusIcon /> New
          </Button>
        </div>
        <PromptList library={library} project={project} selection={manager.selection} onSelect={manager.select} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {manager.pending === undefined ? (
          <div />
        ) : (
          <DiscardGuard onDiscard={() => manager.settle(true)} onStay={() => manager.settle(false)} />
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <SelectedPanel manager={manager} runtimeDefault={runtimeDefault} threadId={threadId} fetch={fetchImpl} />
        </div>
      </div>
    </div>
  )
}

/**
 * The header's prompt button and the manager it opens; the thread on screen renders pi's prompt.
 *
 * ⚠ CONTROLLED, SO A CLOSE ASKS. Escape, a click outside and the X are the dialog's own closes; left
 * to it, they unmount the editor and an unsaved draft is gone without a word. Each is routed through
 * the manager's discard guard instead (`close`), which is why its state lives here and not in the
 * content the dialog unmounts.
 */
export function PromptManagerDialog({
  threadId,
  fetch,
}: {
  threadId: string | undefined
  fetch?: FetchLike
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const { library, project, runtimeDefault, reload } = useLibrary(open, threadId, fetch)
  const manager = useManagerState(library, reload, fetch, () => setOpen(false))
  return (
    <HeaderDialog
      open={open}
      onOpenChange={(next: boolean) => (next ? setOpen(true) : manager.close())}
      trigger={{
        label: 'prompts',
        hover: 'prompts — the library of system, append and session prompts',
        icon: <ScrollTextIcon />,
      }}
      title="Prompts"
      description="markdown files in ENSO_HOME/prompts — edit, copy and name them here; a trusted project's own, in .enso/prompts, are read-only"
      contentClassName="flex h-5/6 flex-col sm:max-w-6xl"
    >
      <ManagerBody
        library={library}
        project={project}
        runtimeDefault={runtimeDefault}
        manager={manager}
        threadId={threadId}
        fetch={fetch}
      />
    </HeaderDialog>
  )
}
