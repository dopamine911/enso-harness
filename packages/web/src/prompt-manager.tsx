import type { EnsoLibraryPromptCategory, EnsoLibraryPromptListing, EnsoSystemPromptPreview } from '@enso/core'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'
import { Field, FieldError, FieldLabel } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { Textarea } from './components/ui/textarea.tsx'
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
  runtimeDefaultDraft,
  saveDraft,
} from './prompt-editor-state.ts'
import {
  deleteLibraryPrompt,
  fetchLibraryPrompt,
  fetchPromptLibrary,
  fetchSystemPromptPreview,
  type LibraryListing,
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
 */

type Selection =
  | { readonly kind: 'pi-default' }
  | { readonly kind: 'prompt'; readonly id: string }
  | { readonly kind: 'new' }

/** A move held behind the discard guard, as data: open a selection, or start a new draft. */
type Move =
  | { readonly kind: 'select'; readonly next: Selection }
  | { readonly kind: 'start'; readonly state: EditorState }

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

/** The library and pi's default, read when the manager opens; `reload` after a write. */
function useLibrary(
  open: boolean,
  threadId: string | undefined,
  fetchImpl: FetchLike | undefined,
): { library: LibraryState; runtimeDefault: HeadState; reload: () => void } {
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
  return { library, runtimeDefault, reload: useCallback(() => setGeneration((value) => value + 1), []) }
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

function PromptList({
  library,
  selection,
  onSelect,
}: {
  library: LibraryState
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

/** The file's fields: its name on disk, what lists call it, one line about it, and where it goes. */
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
function DeleteAction({ id, onDelete }: { id: string | undefined; onDelete: () => void }): React.ReactNode {
  const [asking, setAsking] = useState(false)
  if (id === undefined) return null
  if (!asking) return <ArtifactAction icon={Trash2Icon} label="Delete" onClick={() => setAsking(true)} />
  return (
    <span role="alert" className="flex items-center gap-1 text-xs">
      delete {id}.md?
      <Button variant="destructive" size="sm" onClick={onDelete}>
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
          <ArtifactAction icon={SaveIcon} label="Save" disabled={!dirty} onClick={props.onSave} />
          <ArtifactAction icon={CopyIcon} label="Copy" onClick={props.onCopy} />
          <DeleteAction id={state.saved?.id} onDelete={props.onDelete} />
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className="grid content-start gap-3">
        <DraftFields draft={state.draft} onChange={onChange} />
        {props.refusal === undefined ? null : <FieldError>{props.refusal}</FieldError>}
        <BodyField body={state.draft.body} readOnly={false} onChange={(body) => onChange({ ...state.draft, body })} />
      </ArtifactContent>
      <PromptSizeBar draft={state.draft} head={head} window={props.window} />
      <PromptBreakdown head={head} />
    </Artifact>
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

/** What the manager has open: the selection, the editor's state, and a move waiting on the discard guard. */
function useManagerState(
  library: LibraryState,
  reload: () => void,
  fetchImpl: FetchLike | undefined,
): {
  selection: Selection
  editor: EditorState | undefined
  pending: Move | undefined
  refusal: string | undefined
  select: (next: Selection) => void
  start: (state: EditorState) => void
  change: (draft: EditorDraft) => void
  save: () => Promise<void>
  remove: () => Promise<void>
  settle: (discard: boolean) => void
} {
  const [selection, setSelection] = useState<Selection>({ kind: 'pi-default' })
  const [editor, setEditor] = useState<EditorState | undefined>(undefined)
  const [pending, setPending] = useState<Move | undefined>(undefined)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const taken = new Set(listingOf(library)?.prompts.map((prompt) => prompt.id) ?? [])
  // ⚠ Every move takes a new ticket; a prompt read answers only if its ticket is still the latest.
  // Otherwise a slow read of an earlier selection lands after a later one and fills the editor
  // with the wrong prompt while the list shows the right one selected.
  const moves = useRef(0)
  const open = (next: Selection, ticket: number): void => {
    setRefusal(undefined)
    setSelection(next)
    setEditor(undefined)
    if (next.kind !== 'prompt') return
    void fetchLibraryPrompt(next.id, fetchImpl).then((read) => {
      if (ticket !== moves.current) return
      if (read.kind === 'loaded') setEditor(openedState(read.prompt))
      else setRefusal(read.detail)
    })
  }
  const perform = (move: Move): void => {
    moves.current += 1
    if (move.kind === 'select') {
      open(move.next, moves.current)
      return
    }
    setRefusal(undefined)
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
    select: (next) => guarded({ kind: 'select', next }),
    start: (state) => guarded({ kind: 'start', state }),
    change: (draft) => setEditor((state) => (state === undefined ? state : { ...state, draft })),
    save: async () => {
      if (editor === undefined) return
      const outcome = await saveDraft(editor, taken, fetchImpl)
      if (outcome.kind === 'refused') {
        setRefusal(outcome.reason)
        return
      }
      setRefusal(undefined)
      setEditor(openedState(outcome.prompt))
      setSelection({ kind: 'prompt', id: outcome.prompt.id })
      reload()
    },
    remove: async () => {
      const id = editor?.saved?.id
      if (id === undefined) return
      const removed = await deleteLibraryPrompt(id, fetchImpl)
      if (removed.kind !== 'deleted') {
        setRefusal(removed.detail)
        return
      }
      setEditor(undefined)
      setSelection({ kind: 'pi-default' })
      reload()
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
      threadId={threadId}
      window={runtimeDefault.kind === 'loaded' ? runtimeDefault.preview : undefined}
      fetch={fetchImpl}
    />
  )
}

function ManagerBody({
  threadId,
  fetch: fetchImpl,
}: {
  threadId: string | undefined
  fetch?: FetchLike
}): React.ReactNode {
  const { library, runtimeDefault, reload } = useLibrary(true, threadId, fetchImpl)
  const manager = useManagerState(library, reload, fetchImpl)
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border">
      <div className="flex min-h-0 w-64 shrink-0 flex-col">
        <div className="flex gap-1 border-b p-2">
          <Button variant="outline" size="sm" onClick={() => manager.start(newState(blankDraft()))}>
            <FilePlusIcon /> New
          </Button>
        </div>
        <PromptList library={library} selection={manager.selection} onSelect={manager.select} />
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

/** The header's prompt button and the manager it opens; the thread on screen renders pi's prompt. */
export function PromptManagerDialog({
  threadId,
  fetch,
}: {
  threadId: string | undefined
  fetch?: FetchLike
}): React.ReactNode {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="prompts"
          title="prompts — the library of system, append and session prompts"
        >
          <ScrollTextIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-5/6 flex-col sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Prompts</DialogTitle>
          <DialogDescription>markdown files in ENSO_HOME/prompts — edit, copy and name them here</DialogDescription>
        </DialogHeader>
        <ManagerBody threadId={threadId} {...(fetch === undefined ? {} : { fetch })} />
      </DialogContent>
    </Dialog>
  )
}
