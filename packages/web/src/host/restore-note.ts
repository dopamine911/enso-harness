import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import { type EnsoTranscriptEntry, readEnsoTreeRestored } from '@enso/core'
import { snapshotAtEntry } from './thread-trees.ts'
import { transcriptOf } from './transcript.ts'

/**
 * What pi is told after a restore (#652). "Restore files to here" puts a thread's FILES back to how
 * they were when an earlier prompt began, and leaves the conversation as it was — so pi's next turn
 * worked from a picture of the files that was no longer true. Measured twice in the arena: an agent
 * had to tell pi itself ("ignore the priority change"), and once only the stale-write guard caught
 * pi writing against the old picture.
 *
 * ⚠ ON THE NEXT PROMPT, NOT AT THE RESTORE. A note appended at the restore would be the branch's last
 * message, and a branch ending on a message pi has not answered reads as a torn run (`continuation.ts`):
 * an idle thread would offer Continue. So the note goes with the next prompt, from `before_agent_start`,
 * which pi persists with the run as a `custom_message` — and a prompt refused before it runs carries
 * nothing. A restore, its undo and another restore since the last message collapse into one note that
 * says where the files ARE. A continued run (#436) passes no `before_agent_start` and carries none.
 */

/** The `custom_message` type the note is recorded as: in the branch, and in the model's context as a user turn. */
const ENSO_RESTORE_NOTE = 'enso-restore-note'

/** The note's extension, named so `loadedExtensionPaths` says what it is (the load receipt's pin names it). */
const RESTORE_NOTE_EXTENSION_NAME = 'enso-host-restore-note'
export const RESTORE_NOTE_EXTENSION_PATH = `<inline:${RESTORE_NOTE_EXTENSION_NAME}>`

/** The longest stretch of the prompt the note quotes, so pi can tell which one. */
const QUOTED_PROMPT_LENGTH = 80

/** An entry pi sends the model: a prompt, a reply, a tool result, or a custom message (this note's kind among them). */
function reachesTheModel(entry: EnsoTranscriptEntry): boolean {
  if (entry.kind === 'message' || entry.kind === 'tool-result') return true
  return entry.kind === 'other' && (entry.type === 'custom_message' || entry.type.startsWith('message:'))
}

/** The user prompt whose start the tree was snapshotted at `hash`, numbered among the branch's prompts. */
function promptAt(
  transcript: readonly EnsoTranscriptEntry[],
  hash: string,
): { readonly number: number; readonly text: string } | undefined {
  let number = 0
  for (const transcriptEntry of transcript) {
    if (transcriptEntry.kind !== 'message' || transcriptEntry.role !== 'user') continue
    number += 1
    if (snapshotAtEntry(transcript, transcriptEntry.id)?.hash !== hash) continue
    const text = transcriptEntry.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ')
    return { number, text: text.length > QUOTED_PROMPT_LENGTH ? `${text.slice(0, QUOTED_PROMPT_LENGTH - 1)}…` : text }
  }
  return undefined
}

/**
 * The note for the next request, or undefined when the files have not been put back since pi last
 * heard anything: the newest restore after the last entry the model was sent, named by the prompt it
 * went back to — or, for an undo (its files are no prompt's start), said as files changed outside it.
 */
function restoreNoteOf(transcript: readonly EnsoTranscriptEntry[]): string | undefined {
  const lastSent = transcript.findLastIndex(reachesTheModel)
  const restore = transcript
    .slice(lastSent + 1)
    .flatMap((transcriptEntry) =>
      transcriptEntry.kind === 'custom' ? [readEnsoTreeRestored(transcriptEntry.customType, transcriptEntry.data)] : [],
    )
    .findLast((restored) => restored !== undefined)
  if (restore === undefined) return undefined
  const prompt = promptAt(transcript, restore.hash)
  const where =
    prompt === undefined
      ? 'the person put this thread\u2019s files back from an earlier restore (an undo), so they may not match what this conversation describes'
      : `the person restored this thread\u2019s files to how they were when prompt ${prompt.number} began ("${prompt.text}"); every change to the files made after that is gone, though this conversation still describes it`
  return `Note from Enso, not from the person: before this request, ${where}. This conversation was not changed. Read a file again before you rely on it or edit it.`
}

/** The host's extension that adds the note to the next request (#652): read off the branch the prompt runs on. */
export const restoreNoteExtension: InlineExtension = {
  name: RESTORE_NOTE_EXTENSION_NAME,
  factory: (pi: ExtensionAPI): void => {
    pi.on('before_agent_start', (_event, context) => {
      const note = restoreNoteOf(transcriptOf(context.sessionManager.getBranch()))
      return note === undefined
        ? undefined
        : { message: { customType: ENSO_RESTORE_NOTE, content: note, display: false } }
    })
  },
}
