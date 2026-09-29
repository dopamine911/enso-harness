import type { EnsoLibraryPromptCategory, EnsoLibraryPromptSummary } from '@enso/core'
import { useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Field, FieldDescription, FieldError, FieldLabel } from './components/ui/field.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import { fetchLibraryPrompt, fetchPromptLibrary, type LibraryListing } from './prompt-library-connection.ts'

/**
 * The Start dialog's two library fields (#443): the session's **system prompt** — pi's default, or
 * a `system` / `append` prompt, fixed for the session's life — and a saved **session prompt** that
 * fills the first message. Each prompt shows its estimated size beside its name.
 *
 * ⚠ A FILE THE LIBRARY REFUSED IS NAMED HERE, not left out: a prompt someone saved that does not
 * appear would read as lost, and picking a different one by mistake is how a session runs with the
 * wrong instructions. Choosing pi's default is always possible, and is the default.
 */

/** The select's value for pi's own prompt — a Radix item may not have an empty value. */
export const PI_DEFAULT_SYSTEM_PROMPT = 'pi-default'

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

/** The library, and the system prompt chosen from it — pi's default until one is picked. */
export interface SystemPromptChoice {
  readonly library: LibraryState
  readonly systemPrompt: string
  readonly setSystemPrompt: (value: string) => void
}

export function useSystemPromptChoice(open: boolean, fetchImpl: FetchLike | undefined): SystemPromptChoice {
  const library = usePromptLibrary(open, fetchImpl)
  const [systemPrompt, setSystemPrompt] = useState(PI_DEFAULT_SYSTEM_PROMPT)
  return { library, systemPrompt, setSystemPrompt }
}

/** Both library fields, as the dialog places them: the system prompt, then a saved prompt for the box. */
export function PromptLibraryFields(props: {
  choice: SystemPromptChoice
  fetch: FetchLike | undefined
  onPick: (text: string) => void
}): React.ReactNode {
  const { library, systemPrompt, setSystemPrompt } = props.choice
  return (
    <>
      <SystemPromptField library={library} value={systemPrompt} onChoose={setSystemPrompt} />
      <SessionPromptPicker library={library} fetch={props.fetch} onPick={props.onPick} />
    </>
  )
}

function promptsOf(
  library: LibraryState,
  keep: (prompt: EnsoLibraryPromptSummary) => boolean,
): EnsoLibraryPromptSummary[] {
  return library.kind === 'loaded' ? library.listing.prompts.filter(keep) : []
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

function PromptItem({ prompt }: { prompt: EnsoLibraryPromptSummary }): React.ReactNode {
  const words = CATEGORY_WORDS[prompt.category]
  return (
    <SelectItem value={prompt.id}>
      <span>{prompt.name}</span>
      <span className="text-xs text-muted-foreground">
        {estimateLabel(prompt)}
        {words === undefined ? '' : ` · ${words}`}
      </span>
    </SelectItem>
  )
}

/** Every refused file by name, and a library that could not be read at all. */
function LibraryProblems({ library }: { library: LibraryState }): React.ReactNode {
  if (library.kind === 'unavailable') return <FieldError>prompt library: {library.detail}</FieldError>
  if (library.kind !== 'loaded' || library.listing.refused.length === 0) return null
  return (
    <FieldError>
      {library.listing.refused.map((refused) => (
        <span key={refused.file} className="block">
          refused {refused.reason}
        </span>
      ))}
    </FieldError>
  )
}

function SystemPromptField(props: {
  library: LibraryState
  value: string
  onChoose: (value: string) => void
}): React.ReactNode {
  const choices = promptsOf(props.library, (prompt) => prompt.category !== 'session')
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
            <PromptItem key={prompt.id} prompt={prompt} />
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>fixed for the whole session</FieldDescription>
      <LibraryProblems library={props.library} />
    </Field>
  )
}

/** A saved session prompt, read in full and handed to the prompt box; a read that fails is said here. */
function SessionPromptPicker(props: {
  library: LibraryState
  fetch: FetchLike | undefined
  onPick: (text: string) => void
}): React.ReactNode {
  const choices = promptsOf(props.library, (prompt) => prompt.category === 'session')
  const [picked, setPicked] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // ⚠ Only the latest pick may fill the box: a slow read of an earlier one lands after it otherwise,
  // and the prompt box holds A's text while the field says B.
  const latest = useRef('')
  if (choices.length === 0) return null
  const pick = async (id: string): Promise<void> => {
    latest.current = id
    setPicked(id)
    setFailure(undefined)
    const read = await fetchLibraryPrompt(id, props.fetch)
    if (latest.current !== id) return
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
            <PromptItem key={prompt.id} prompt={prompt} />
          ))}
        </SelectContent>
      </Select>
      {failure === undefined ? null : <FieldError>{failure}</FieldError>}
    </Field>
  )
}
