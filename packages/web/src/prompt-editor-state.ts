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
import { deleteLibraryPrompt, type LibraryPrecondition, writeLibraryPrompt } from './prompt-library-connection.ts'

/**
 * The prompt manager's editor, as data (#443): the draft on screen, the file it was opened from,
 * and the rules a save follows — kept apart from the React so each is tested as the value it is.
 *
 * ⚠ A RENAME IS A WRITE, THEN A DELETE — in that order, and never over another prompt. The id is
 * the file name; the new file is written first so a failed delete leaves two copies rather than
 * none, and a name another prompt already has is refused before anything is written.
 *
 * ⚠ EVERY WRITE NAMES WHAT IT EXPECTS ON DISK. A new file, or a rename's new name, is a create
 * (`If-None-Match: *`): the server refuses it over any file there, one another tab or editor saved
 * since the list was read included. A save of an opened file replaces only the version it opened
 * (`If-Match`, the `etag` it was read with); a different one on disk is a `conflict`, which the
 * person settles — reload it, or overwrite it with theirs.
 */

/** Everything the editor edits: the file's name (`id`) and its fields. */
export interface EditorDraft extends EnsoLibraryPromptWrite {
  readonly id: string
}

/** A file as the editor opened or saved it: its fields, and the version it read (`etag`). */
export interface SavedFile extends EditorDraft {
  readonly etag: string
}

/** The draft, and the file it was opened from — `undefined` for a prompt not yet saved. */
export interface EditorState {
  readonly saved: SavedFile | undefined
  readonly draft: EditorDraft
}

function draftOf(prompt: EnsoLibraryPrompt): EditorDraft {
  const { id, name, description, category, body } = prompt
  return { id, name, description, category, body }
}

/** Opened from a saved file, at the version `etag`: nothing to save until something changes. */
export function openedState(prompt: EnsoLibraryPrompt, etag: string): EditorState {
  const draft = draftOf(prompt)
  return { saved: { ...draft, etag }, draft }
}

/**
 * The editor once a save of `sent` answered with `prompt` at `etag`: the file is the new baseline, and
 * a draft typed on since the save went out stays — still unsaved — instead of being put back to what was sent.
 */
export function savedState(
  current: EditorState | undefined,
  sent: EditorDraft,
  prompt: EnsoLibraryPrompt,
  etag: string,
): EditorState {
  const opened = openedState(prompt, etag)
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

/** Why the draft cannot be saved, or `undefined`. `taken` is every id the library already has a file for, refused ones included. */
export function saveRefusal(state: EditorState, taken: ReadonlySet<string>): string | undefined {
  const { draft, saved } = state
  if (!isLibraryPromptId(draft.id)) return 'the file name is lowercase words joined by hyphens (a-z, 0-9, -)'
  if (draft.name.trim().length === 0) return 'the prompt needs a name'
  if (draft.id !== saved?.id && taken.has(draft.id)) return `${draft.id}.md is already in the library`
  return undefined
}

export type SaveOutcome =
  /** Written, at `etag`. `warning` when it was a rename and the old file is still there — listed, for the person to remove. */
  | { readonly kind: 'saved'; readonly prompt: EnsoLibraryPrompt; readonly etag: string; readonly warning?: string }
  | { readonly kind: 'refused'; readonly reason: string }
  /** The opened file changed on disk since it was read: nothing was written; reload it, or overwrite it. */
  | { readonly kind: 'conflict'; readonly reason: string }

/**
 * Write the draft; on a rename, then delete the old file. Refused when nothing was written. A write
 * that landed is a save even when the old file stays: the new file exists, and the editor must show it.
 * `overwrite` is the person's answer to a `conflict`: replace whatever is on disk with the draft.
 */
export async function saveDraft(
  state: EditorState,
  taken: ReadonlySet<string>,
  fetchImpl?: FetchLike,
  overwrite = false,
): Promise<SaveOutcome> {
  const refusal = saveRefusal(state, taken)
  if (refusal !== undefined) return { kind: 'refused', reason: refusal }
  const { id, ...fields } = state.draft
  const { saved } = state
  const replacing = saved !== undefined && saved.id === id
  let precondition: LibraryPrecondition = { kind: 'create' }
  if (replacing) precondition = overwrite ? { kind: 'overwrite' } : { kind: 'replace', etag: saved.etag }
  const written = await writeLibraryPrompt(id, fields, precondition, fetchImpl)
  // A create that finds a file is a name taken since the list was read — never overwritten from here.
  if (written.kind === 'conflict') return { kind: replacing ? 'conflict' : 'refused', reason: written.detail }
  if (written.kind !== 'loaded') return { kind: 'refused', reason: written.detail }
  if (saved !== undefined && !replacing) {
    // Only the version that was opened: an old file edited since is kept, and said.
    const removed = await deleteLibraryPrompt(saved.id, { kind: 'replace', etag: saved.etag }, fetchImpl)
    if (removed.kind !== 'deleted') {
      return {
        kind: 'saved',
        prompt: written.prompt,
        etag: written.etag,
        warning: `saved as ${id}.md, but ${saved.id}.md was not removed: ${removed.detail}`,
      }
    }
  }
  return { kind: 'saved', prompt: written.prompt, etag: written.etag }
}

/** A category's name, as the editor and the list say it. */
export const CATEGORY_LABELS: Readonly<Record<EnsoLibraryPromptCategory, string>> = {
  system: 'System — replaces pi’s prompt',
  append: 'Append — adds to pi’s prompt',
  session: 'Session — fills the first message',
}
