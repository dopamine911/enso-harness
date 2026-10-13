import {
  type EnsoLibraryPromptCategory,
  type EnsoLibraryPromptRefusal,
  type EnsoLibraryPromptSummary,
  libraryPromptRefOf,
  parseLibraryPromptRef,
} from '@enso/core'
import { useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { SelectGroup, SelectItem, SelectLabel } from './components/ui/select.tsx'
import { type Loading, useFreshRead } from './fresh-read.ts'
import {
  fetchLibraryPrompt,
  fetchProjectPrompt,
  fetchProjectPromptLibrary,
  fetchPromptLibrary,
  type LibraryListing,
  type LibraryPromptRead,
  type ProjectLibraryRead,
} from './prompt-library-connection.ts'
import { SettingChip } from './setting-chip.tsx'

/**
 * The launch panel's two library chips (#443, #877): the session's **System prompt** — pi's
 * default, or a `system` / `append` prompt, fixed for the session's life — and a **Saved prompt**
 * that fills the composer with a `session` prompt's text. Each prompt shows its estimated size
 * beside its name.
 *
 * ⚠ A FILE THE LIBRARY REFUSED IS NAMED HERE, not left out: a prompt someone saved that does not
 * appear would read as lost, and picking a different one by mistake is how a session runs with the
 * wrong instructions. Choosing pi's default is always possible, and is the default.
 *
 * ⚠ TWO LIBRARIES, LISTED APART (#470). The user's prompts, then the project's own
 * (`<project>/.enso/prompts`) under their own heading, each chosen by its prompt reference
 * (`project:<id>` for the project's), so two prompts with one id are two choices. A project the
 * thread does not trust is not read: the panel says where its prompts are and that they wait on trust.
 */

/**
 * The select's value for pi's own prompt — a Radix item may not have an empty value. ⚠ Outside the
 * library id grammar (`isLibraryPromptId`: no `:`), so no saved prompt can share it: `pi-default`
 * did, and a prompt saved as `pi-default.md` was sent as pi's default.
 */
export const PI_DEFAULT_SYSTEM_PROMPT = ':pi-default'

type LibraryState = Loading | LibraryListing

type ProjectState = Loading | ProjectLibraryRead

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
  // Both read afresh each time the panel is shown.
  const library = useFreshRead(open, '', () => fetchPromptLibrary(fetchImpl))
  const project = useFreshRead(open, threadId, () => fetchProjectPromptLibrary(threadId, fetchImpl))
  const [systemPrompt, setSystemPrompt] = useState(PI_DEFAULT_SYSTEM_PROMPT)
  return { library, project, threadId, systemPrompt, setSystemPrompt }
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

/** A prompt's name by its reference, as a chip says it; the reference itself when no listing names it. */
function promptName(ref: string, choice: Pick<SystemPromptChoice, 'library' | 'project'>): string {
  const parsed = parseLibraryPromptRef(ref)
  const listed =
    parsed?.source === 'project' ? projectPromptsOf(choice.project, () => true) : promptsOf(choice.library, () => true)
  return listed.find((prompt) => prompt.id === parsed?.id)?.name ?? ref
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

const isSystem = (prompt: EnsoLibraryPromptSummary): boolean => prompt.category !== 'session'
const isSession = (prompt: EnsoLibraryPromptSummary): boolean => prompt.category === 'session'

/** The session's system prompt: pi's default, or a `system` / `append` prompt from either library. */
export function SystemPromptChip({
  choice,
  invalid,
}: {
  readonly choice: SystemPromptChoice
  readonly invalid: boolean
}): React.ReactNode {
  const { systemPrompt } = choice
  return (
    <SettingChip
      label="System prompt"
      value={systemPrompt}
      display={systemPrompt === PI_DEFAULT_SYSTEM_PROMPT ? 'pi default' : promptName(systemPrompt, choice)}
      onChoose={choice.setSystemPrompt}
      invalid={invalid}
    >
      <SelectItem value={PI_DEFAULT_SYSTEM_PROMPT}>pi default</SelectItem>
      {promptsOf(choice.library, isSystem).map((prompt) => (
        <PromptItem key={prompt.id} prompt={prompt} value={prompt.id} />
      ))}
      <ProjectGroup prompts={projectPromptsOf(choice.project, isSystem)} />
    </SettingChip>
  )
}

/**
 * A saved session prompt, read in full and handed to the composer; a read that fails is said beside
 * it. Nothing when neither library holds one.
 */
export function SavedPromptChip({
  choice,
  fetch: fetchImpl,
  onPick,
}: {
  readonly choice: SystemPromptChoice
  readonly fetch: FetchLike | undefined
  readonly onPick: (text: string) => void
}): React.ReactNode {
  const choices = promptsOf(choice.library, isSession)
  const projectChoices = projectPromptsOf(choice.project, isSession)
  const [picked, setPicked] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // ⚠ Only the latest pick may fill the box: a slow read of an earlier one lands after it otherwise,
  // and the composer holds A's text while the chip says B.
  const latest = useRef('')
  if (choices.length === 0 && projectChoices.length === 0) return null
  const pick = async (ref: string): Promise<void> => {
    latest.current = ref
    setPicked(ref)
    setFailure(undefined)
    const read = await readByRef(ref, choice.threadId, fetchImpl)
    if (latest.current !== ref) return
    if (read.kind === 'loaded') onPick(read.prompt.body)
    else setFailure(read.detail)
  }
  return (
    <>
      <SettingChip
        label="Saved prompt"
        value={picked}
        display={picked === '' ? 'none' : promptName(picked, choice)}
        onChoose={(ref: string): void => void pick(ref)}
      >
        {choices.map((prompt) => (
          <PromptItem key={prompt.id} prompt={prompt} value={prompt.id} />
        ))}
        <ProjectGroup prompts={projectChoices} />
      </SettingChip>
      {failure === undefined ? null : (
        <span role="alert" className="text-xs text-destructive">
          {failure}
        </span>
      )}
    </>
  )
}

function RefusedFiles({
  refused,
  where,
}: {
  refused: readonly EnsoLibraryPromptRefusal[]
  where: string
}): React.ReactNode {
  return refused.map((file) => (
    <span key={`${where}${file.file}`} className="block text-destructive">
      refused {where}
      {file.reason}
    </span>
  ))
}

/** Every refused file by name, and a library that could not be read at all. */
function LibraryProblems({ library }: { library: LibraryState }): React.ReactNode {
  if (library.kind === 'unavailable') {
    return <span className="block text-destructive">prompt library: {library.detail}</span>
  }
  return library.kind === 'loaded' ? <RefusedFiles refused={library.listing.refused} where="" /> : null
}

/**
 * What the project library says (#470): where its prompts are and that they wait on trust, its
 * refused files by name, or that it could not be read. A trusted project with none says nothing.
 */
function ProjectLibraryNote({ project }: { project: ProjectState }): React.ReactNode {
  if (project.kind === 'loading') return null
  if (project.kind === 'unavailable') {
    return <span className="block text-destructive">project prompts: {project.detail}</span>
  }
  if (project.project.kind === 'untrusted') {
    return (
      <span className="block">
        project prompts in {project.project.directory} are not read: the project is not trusted
      </span>
    )
  }
  return <RefusedFiles refused={project.project.listing.refused} where="project " />
}

/** What the libraries say beside the chips: refused files, a library that could not be read, an untrusted project's. */
export function LibraryNotes({ choice }: { readonly choice: SystemPromptChoice }): React.ReactNode {
  return (
    <p className="px-1 text-xs text-muted-foreground empty:hidden">
      <LibraryProblems library={choice.library} />
      <ProjectLibraryNote project={choice.project} />
    </p>
  )
}
