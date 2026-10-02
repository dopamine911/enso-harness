import {
  type EnsoLibraryPromptCategory,
  type EnsoLibraryPromptRefusal,
  type EnsoLibraryPromptSummary,
  libraryPromptRefOf,
  parseLibraryPromptRef,
} from '@enso/core'
import { useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Field, FieldDescription, FieldError, FieldLabel } from './components/ui/field.tsx'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.tsx'
import {
  fetchLibraryPrompt,
  fetchProjectPrompt,
  fetchProjectPromptLibrary,
  fetchPromptLibrary,
  type LibraryListing,
  type LibraryPromptRead,
  type ProjectLibraryRead,
} from './prompt-library-connection.ts'

/**
 * The Start dialog's two library fields (#443): the session's **system prompt** — pi's default, or
 * a `system` / `append` prompt, fixed for the session's life — and a saved **session prompt** that
 * fills the first message. Each prompt shows its estimated size beside its name.
 *
 * ⚠ A FILE THE LIBRARY REFUSED IS NAMED HERE, not left out: a prompt someone saved that does not
 * appear would read as lost, and picking a different one by mistake is how a session runs with the
 * wrong instructions. Choosing pi's default is always possible, and is the default.
 *
 * ⚠ TWO LIBRARIES, LISTED APART (#470). The user's prompts, then the project's own
 * (`<project>/.enso/prompts`) under their own heading, each chosen by its prompt reference
 * (`project:<id>` for the project's), so two prompts with one id are two choices. A project the
 * thread does not trust is not read: the field says where its prompts are and that they wait on trust.
 */

/**
 * The select's value for pi's own prompt — a Radix item may not have an empty value. ⚠ Outside the
 * library id grammar (`isLibraryPromptId`: no `:`), so no saved prompt can share it: `pi-default`
 * did, and a prompt saved as `pi-default.md` was sent as pi's default.
 */
export const PI_DEFAULT_SYSTEM_PROMPT = ':pi-default'

type LibraryState = { readonly kind: 'loading' } | LibraryListing

/** The library, read afresh each time the dialog opens. */
function usePromptLibrary(open: boolean, fetchImpl: FetchLike | undefined): LibraryState {
  const [library, setLibrary] = useState<LibraryState>({ kind: 'loading' })
  useEffect(() => {
    if (!open) return
    let current = true
    setLibrary({ kind: 'loading' })
    void fetchPromptLibrary(fetchImpl).then((loaded) => {
      if (current) setLibrary(loaded)
    })
    return (): void => {
      current = false
    }
  }, [open, fetchImpl])
  return library
}

type ProjectState = { readonly kind: 'loading' } | ProjectLibraryRead

/** The thread's project library (#470), read afresh each time the dialog opens. */
function useProjectPromptLibrary(open: boolean, threadId: string, fetchImpl: FetchLike | undefined): ProjectState {
  const [project, setProject] = useState<ProjectState>({ kind: 'loading' })
  useEffect(() => {
    if (!open) return
    let current = true
    setProject({ kind: 'loading' })
    void fetchProjectPromptLibrary(threadId, fetchImpl).then((loaded) => {
      if (current) setProject(loaded)
    })
    return (): void => {
      current = false
    }
  }, [open, threadId, fetchImpl])
  return project
}

/** Both libraries, and the system prompt chosen from them — pi's default until one is picked. */
export interface SystemPromptChoice {
  readonly library: LibraryState
  readonly project: ProjectState
  readonly threadId: string
  /** A prompt reference, or {@link PI_DEFAULT_SYSTEM_PROMPT}. */
  readonly systemPrompt: string
  readonly setSystemPrompt: (value: string) => void
}

export function useSystemPromptChoice(
  open: boolean,
  threadId: string,
  fetchImpl: FetchLike | undefined,
): SystemPromptChoice {
  const library = usePromptLibrary(open, fetchImpl)
  const project = useProjectPromptLibrary(open, threadId, fetchImpl)
  const [systemPrompt, setSystemPrompt] = useState(PI_DEFAULT_SYSTEM_PROMPT)
  return { library, project, threadId, systemPrompt, setSystemPrompt }
}

/** Both library fields, as the dialog places them: the system prompt, then a saved prompt for the box. */
export function PromptLibraryFields(props: {
  choice: SystemPromptChoice
  fetch: FetchLike | undefined
  onPick: (text: string) => void
}): React.ReactNode {
  const { library, project, threadId, systemPrompt, setSystemPrompt } = props.choice
  return (
    <>
      <SystemPromptField library={library} project={project} value={systemPrompt} onChoose={setSystemPrompt} />
      <SessionPromptPicker
        library={library}
        project={project}
        read={(ref) => readByRef(ref, threadId, props.fetch)}
        onPick={props.onPick}
      />
    </>
  )
}

/** A prompt by its reference, from whichever library the reference names. */
function readByRef(ref: string, threadId: string, fetchImpl: FetchLike | undefined): Promise<LibraryPromptRead> {
  const parsed = parseLibraryPromptRef(ref)
  if (parsed === undefined) return Promise.resolve({ kind: 'unavailable', detail: `${ref} names no library prompt` })
  return parsed.source === 'project'
    ? fetchProjectPrompt(threadId, parsed.id, fetchImpl)
    : fetchLibraryPrompt(parsed.id, fetchImpl)
}

function promptsOf(
  library: LibraryState,
  keep: (prompt: EnsoLibraryPromptSummary) => boolean,
): EnsoLibraryPromptSummary[] {
  return library.kind === 'loaded' ? library.listing.prompts.filter(keep) : []
}

function projectPromptsOf(
  project: ProjectState,
  keep: (prompt: EnsoLibraryPromptSummary) => boolean,
): EnsoLibraryPromptSummary[] {
  return project.kind === 'loaded' && project.project.kind === 'listed'
    ? project.project.listing.prompts.filter(keep)
    : []
}

/** A prompt's size as its row says it: the same estimate the Context tab prices the text with. */
function estimateLabel(prompt: EnsoLibraryPromptSummary): string {
  return `≈${prompt.tokens.toLocaleString('en')} tokens`
}

/** What a prompt does to the system head, said beside its size; a session prompt leaves it alone. */
const CATEGORY_WORDS: Readonly<Record<EnsoLibraryPromptCategory, string | undefined>> = {
  system: "replaces pi's prompt",
  append: "adds to pi's prompt",
  session: undefined,
}

function PromptItem({ prompt, value }: { prompt: EnsoLibraryPromptSummary; value: string }): React.ReactNode {
  const words = CATEGORY_WORDS[prompt.category]
  return (
    <SelectItem value={value}>
      <span>{prompt.name}</span>
      <span className="text-xs text-muted-foreground">
        {estimateLabel(prompt)}
        {words === undefined ? '' : ` · ${words}`}
      </span>
    </SelectItem>
  )
}

function RefusedFiles({
  refused,
  where,
}: {
  refused: readonly EnsoLibraryPromptRefusal[]
  where: string
}): React.ReactNode {
  if (refused.length === 0) return null
  return (
    <FieldError>
      {refused.map((file) => (
        <span key={file.file} className="block">
          refused {where}
          {file.reason}
        </span>
      ))}
    </FieldError>
  )
}

/** Every refused file by name, and a library that could not be read at all. */
function LibraryProblems({ library }: { library: LibraryState }): React.ReactNode {
  if (library.kind === 'unavailable') return <FieldError>prompt library: {library.detail}</FieldError>
  return library.kind === 'loaded' ? <RefusedFiles refused={library.listing.refused} where="" /> : null
}

/**
 * What the project library says beside the field (#470): where its prompts are and that they wait on
 * trust, its refused files by name, or that it could not be read. A trusted project with none says nothing.
 */
function ProjectLibraryNote({ project }: { project: ProjectState }): React.ReactNode {
  if (project.kind === 'loading') return null
  if (project.kind === 'unavailable') return <FieldError>project prompts: {project.detail}</FieldError>
  if (project.project.kind === 'untrusted') {
    return (
      <FieldDescription>
        project prompts in {project.project.directory} are not read: the project is not trusted
      </FieldDescription>
    )
  }
  return <RefusedFiles refused={project.project.listing.refused} where="project " />
}

/** The project's prompts as a group of their own, each chosen by its `project:<id>` reference. */
function ProjectGroup({ prompts }: { prompts: readonly EnsoLibraryPromptSummary[] }): React.ReactNode {
  if (prompts.length === 0) return null
  return (
    <SelectGroup>
      <SelectLabel>Project</SelectLabel>
      {prompts.map((prompt) => (
        <PromptItem key={prompt.id} prompt={prompt} value={libraryPromptRefOf('project', prompt.id)} />
      ))}
    </SelectGroup>
  )
}

function SystemPromptField(props: {
  library: LibraryState
  project: ProjectState
  value: string
  onChoose: (value: string) => void
}): React.ReactNode {
  const isSystem = (prompt: EnsoLibraryPromptSummary): boolean => prompt.category !== 'session'
  const choices = promptsOf(props.library, isSystem)
  return (
    <Field>
      <FieldLabel htmlFor="start-session-system-prompt">System prompt</FieldLabel>
      <Select value={props.value} onValueChange={props.onChoose}>
        <SelectTrigger id="start-session-system-prompt" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PI_DEFAULT_SYSTEM_PROMPT}>pi default</SelectItem>
          {choices.map((prompt) => (
            <PromptItem key={prompt.id} prompt={prompt} value={prompt.id} />
          ))}
          <ProjectGroup prompts={projectPromptsOf(props.project, isSystem)} />
        </SelectContent>
      </Select>
      <FieldDescription>fixed for the whole session</FieldDescription>
      <LibraryProblems library={props.library} />
      <ProjectLibraryNote project={props.project} />
    </Field>
  )
}

/** A saved session prompt, read in full and handed to the prompt box; a read that fails is said here. */
function SessionPromptPicker(props: {
  library: LibraryState
  project: ProjectState
  read: (ref: string) => Promise<LibraryPromptRead>
  onPick: (text: string) => void
}): React.ReactNode {
  const isSession = (prompt: EnsoLibraryPromptSummary): boolean => prompt.category === 'session'
  const choices = promptsOf(props.library, isSession)
  const projectChoices = projectPromptsOf(props.project, isSession)
  const [picked, setPicked] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // ⚠ Only the latest pick may fill the box: a slow read of an earlier one lands after it otherwise,
  // and the prompt box holds A's text while the field says B.
  const latest = useRef('')
  if (choices.length === 0 && projectChoices.length === 0) return null
  const pick = async (ref: string): Promise<void> => {
    latest.current = ref
    setPicked(ref)
    setFailure(undefined)
    const read = await props.read(ref)
    if (latest.current !== ref) return
    if (read.kind === 'loaded') props.onPick(read.prompt.body)
    else setFailure(read.detail)
  }
  return (
    <Field>
      <FieldLabel htmlFor="start-session-saved-prompt">Saved prompt</FieldLabel>
      <Select value={picked} onValueChange={(id: string): void => void pick(id)}>
        <SelectTrigger id="start-session-saved-prompt" className="w-full">
          <SelectValue placeholder="fill the prompt from the library" />
        </SelectTrigger>
        <SelectContent>
          {choices.map((prompt) => (
            <PromptItem key={prompt.id} prompt={prompt} value={prompt.id} />
          ))}
          <ProjectGroup prompts={projectChoices} />
        </SelectContent>
      </Select>
      {failure === undefined ? null : <FieldError>{failure}</FieldError>}
    </Field>
  )
}
