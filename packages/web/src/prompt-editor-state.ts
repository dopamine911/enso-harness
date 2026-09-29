import {
  type EnsoLibraryPrompt,
  type EnsoLibraryPromptCategory,
  type EnsoLibraryPromptWrite,
  type EnsoSystemPromptPreview,
  isLibraryPromptId,
  serializeLibraryPrompt,
  utf8Bytes,
} from '@enso/core'
import type { FetchLike } from './browser-logging.ts'
import { deleteLibraryPrompt, writeLibraryPrompt } from './prompt-library-connection.ts'

/**
 * The prompt manager's editor, as data (#443): the draft on screen, the file it was opened from,
 * and the rules a save follows — kept apart from the React so each is tested as the value it is.
 *
 * ⚠ A RENAME IS A WRITE, THEN A DELETE — in that order, and never over another prompt. The id is
 * the file name; the new file is written first so a failed delete leaves two copies rather than
 * none, and a name another prompt already has is refused before anything is written.
 */

/** Everything the editor edits: the file's name (`id`) and its fields. */
export interface EditorDraft extends EnsoLibraryPromptWrite {
  readonly id: string
}

/** The draft, and the file it was opened from — `undefined` for a prompt not yet saved. */
export interface EditorState {
  readonly saved: EditorDraft | undefined
  readonly draft: EditorDraft
}

function draftOf(prompt: EnsoLibraryPrompt): EditorDraft {
  const { id, name, description, category, body } = prompt
  return { id, name, description, category, body }
}

/** Opened from a saved file: nothing to save until something changes. */
export function openedState(prompt: EnsoLibraryPrompt): EditorState {
  const draft = draftOf(prompt)
  return { saved: draft, draft }
}

/**
 * The editor once a save of `sent` answered with `prompt`: the file is the new baseline, and a draft
 * typed on since the save went out stays — still unsaved — instead of being put back to what was sent.
 */
export function savedState(
  current: EditorState | undefined,
  sent: EditorDraft,
  prompt: EnsoLibraryPrompt,
): EditorState {
  const opened = openedState(prompt)
  if (current === undefined || current.draft === sent) return opened
  return { saved: opened.saved, draft: current.draft }
}

/** A new prompt, not yet a file. */
export function newState(draft: EditorDraft): EditorState {
  return { saved: undefined, draft }
}

export function blankDraft(): EditorDraft {
  return { id: '', name: '', description: '', category: 'system', body: '' }
}

/** A copy of another prompt, under a name that is not its own. */
export function copyDraft(source: EditorDraft): EditorDraft {
  return { ...source, id: `${source.id}-copy`.slice(0, 64), name: `${source.name} (copy)`.slice(0, 120) }
}

/** The sections pi drops when a `system` prompt replaces its preamble — copied, they rebuild pi's own. */
const REPLACED_BY_A_SYSTEM_PROMPT: ReadonlySet<string> = new Set(['preamble', 'tools', 'rules', 'docs'])

/**
 * pi's default as a new `system` prompt: the preamble and the three sections a custom preamble
 * takes the place of, so the copy starts as exactly what pi would have said there.
 */
export function runtimeDefaultDraft(preview: EnsoSystemPromptPreview): EditorDraft {
  const body = preview.sections
    .filter((section) => REPLACED_BY_A_SYSTEM_PROMPT.has(section.name))
    .map((section) => section.text)
    .join('\n\n')
  return { id: 'pi-default-copy', name: "pi's default (copy)", description: '', category: 'system', body }
}

export function isDirty(state: EditorState): boolean {
  const { saved, draft } = state
  if (saved === undefined) return true
  return (
    saved.id !== draft.id ||
    saved.name !== draft.name ||
    saved.description !== draft.description ||
    saved.category !== draft.category ||
    saved.body !== draft.body
  )
}

/** The file's size as it would be written — the frontmatter included, exact. */
export function fileBytes(draft: EditorDraft): number {
  return utf8Bytes(serializeLibraryPrompt(draft))
}

/** Why the draft cannot be saved, or `undefined`. `taken` is every id the library already has. */
export function saveRefusal(state: EditorState, taken: ReadonlySet<string>): string | undefined {
  const { draft, saved } = state
  if (!isLibraryPromptId(draft.id)) return 'the file name is lowercase words joined by hyphens (a-z, 0-9, -)'
  if (draft.name.trim().length === 0) return 'the prompt needs a name'
  if (draft.id !== saved?.id && taken.has(draft.id)) return `a prompt is already saved as ${draft.id}.md`
  return undefined
}

export type SaveOutcome =
  | { readonly kind: 'saved'; readonly prompt: EnsoLibraryPrompt }
  | { readonly kind: 'refused'; readonly reason: string }

/** Write the draft; on a rename, then delete the old file. The reason when either did not happen. */
export async function saveDraft(
  state: EditorState,
  taken: ReadonlySet<string>,
  fetchImpl?: FetchLike,
): Promise<SaveOutcome> {
  const refusal = saveRefusal(state, taken)
  if (refusal !== undefined) return { kind: 'refused', reason: refusal }
  const { id, ...fields } = state.draft
  const written = await writeLibraryPrompt(id, fields, fetchImpl)
  if (written.kind !== 'loaded') return { kind: 'refused', reason: written.detail }
  const renamedFrom = state.saved?.id
  if (renamedFrom !== undefined && renamedFrom !== id) {
    const removed = await deleteLibraryPrompt(renamedFrom, fetchImpl)
    if (removed.kind !== 'deleted') {
      return { kind: 'refused', reason: `saved as ${id}.md, but ${renamedFrom}.md was not removed: ${removed.detail}` }
    }
  }
  return { kind: 'saved', prompt: written.prompt }
}

/** A category's name, as the editor and the list say it. */
export const CATEGORY_LABELS: Readonly<Record<EnsoLibraryPromptCategory, string>> = {
  system: 'System — replaces pi’s prompt',
  append: 'Append — adds to pi’s prompt',
  session: 'Session — fills the first message',
}
