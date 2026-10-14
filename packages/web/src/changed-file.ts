import { type EnsoGitFileChange, type EnsoGitFileText, EnsoThreadChangedFile } from '@enso/core'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { type HighlightedLines, highlightLines, languageOf, type SyntaxLanguage } from './diff-highlight.ts'
import { agreesWith, type DiffHunk, linesOf, type Side, sameHiddenLines } from './diff-rows.ts'
import { readSchemaRoute } from './route-read.ts'

/**
 * One changed file whole, for the Diff view (#461): `GET …/changes/file` read, then what the view
 * makes of it — the lines it expands the unchanged runs between hunks from, and each side's syntax.
 *
 * ⚠ THE FILE MUST BE THE ONE THE PATCH WAS CUT FROM. The file is read after the patch, and the
 * agent may have changed it in between; lines from a newer file would be shown under the patch's
 * numbers. So a side is used only when every line the hunks show of it is the file's line at its
 * number (`agreesWith`) — and that holds only the lines the hunks show. The runs come from the old
 * side, a blob at the baseline, which does not change; where the hunks show the new side as text
 * too, the two must hold the same unchanged lines (`sameHiddenLines`), so an edit inside a run
 * since the patch is caught on whichever side made it. The new side alone never fills a run:
 * nothing would hold its runs, and a line written past the last hunk since would show as
 * unchanged. So with the old side too large or unreadable the runs stay counts, and a file not
 * there before — whose old side holds no lines — must be all its hunks show. A file that fails
 * waits for the next read of the changes, which brings a new patch and reads the file again.
 */

/** What `GET …/changes/file` gave: the file, or why not. */
export type ChangedFileOutcome =
  | { readonly kind: 'read'; readonly file: EnsoThreadChangedFile }
  | { readonly kind: 'failed'; readonly problem: string }

/** The view's one way to the route; a test hands in its own. */
export type ReadChangedFile = (change: Pick<EnsoGitFileChange, 'path' | 'oldPath'>) => Promise<ChangedFileOutcome>

/** `GET /api/threads/:threadId/changes/file?path=…[&oldPath=…]`: a changed file whole, or why not. */
export async function readChangedFile(
  threadId: string,
  change: Pick<EnsoGitFileChange, 'path' | 'oldPath'>,
  fetchImpl: FetchLike,
): Promise<ChangedFileOutcome> {
  const query = new URLSearchParams({ path: change.path })
  if (change.oldPath !== null) query.set('oldPath', change.oldPath)
  const route = `/api/threads/${encodeURIComponent(threadId)}/changes/file?${query.toString()}`
  const read = await readSchemaRoute(route, EnsoThreadChangedFile, 'changed file', fetchImpl)
  if (read.kind === 'read') return { kind: 'read', file: read.payload }
  return { kind: 'failed', problem: read.kind === 'absent' ? 'the thread is no longer held here' : read.problem }
}

/**
 * `change` read whole with `readFile` — again whenever its patch changes, which is when the file may
 * have — or `undefined` while the read is out, and without a reader.
 */
export function useChangedFile(
  readFile: ReadChangedFile | undefined,
  change: EnsoGitFileChange,
): ChangedFileOutcome | undefined {
  const { path, oldPath, patch } = change
  const [held, setHeld] = useState<{ readonly asked: string; readonly outcome: ChangedFileOutcome } | undefined>()
  const asked = `${path}\0${oldPath ?? ''}\0${patch ?? ''}`
  useEffect(() => {
    if (readFile === undefined || patch === null) return undefined
    let current = true
    void readFile({ path, oldPath }).then((outcome) => {
      if (current) setHeld({ asked, outcome })
    })
    return () => {
      current = false
    }
  }, [readFile, asked, path, oldPath, patch])
  return held?.asked === asked ? held.outcome : undefined
}

/**
 * Whether the unchanged runs can be shown: off (no reader — a static render), still reading, ready
 * with the lines to show them from and which side those lines are, or blocked, with why in short
 * and in full.
 */
export type Expansion =
  | { readonly kind: 'off' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'ready'; readonly lines: readonly string[]; readonly side: Side }
  | { readonly kind: 'blocked'; readonly why: string; readonly detail: string }

/** A side's lines when it is text and the file the hunks were cut from; otherwise `undefined`. */
function agreeingLines(text: EnsoGitFileText, hunks: readonly DiffHunk[], side: Side): string[] | undefined {
  if (text.kind !== 'text') return undefined
  const lines = linesOf(text.text)
  return agreesWith(hunks, lines, side) ? lines : undefined
}

/** Whether the hunks number any line on the new side — whether there is a new file of the patch's at all. */
const showsNew = (hunks: readonly DiffHunk[]): boolean =>
  hunks.some((hunk) => hunk.lines.some((line) => line.newNumber !== null))

const CHANGED_SINCE: Expansion = {
  kind: 'blocked',
  why: 'changed since this diff',
  detail: 'the file changed after this diff was read; it expands once the diff reads again',
}

/**
 * A type change (a file become a symbolic link, or one become a file) is two patches of two files
 * — all of one removed, all of the other added — and has no unchanged lines between them.
 */
const TYPE_CHANGED: Expansion = {
  kind: 'blocked',
  why: 'a type change',
  detail: 'the old and new sides are different kinds of file, with no unchanged lines between them',
}

/** Why the runs cannot be shown from `side`, the side they would come from. */
function blockedBy(side: EnsoGitFileText): Expansion {
  switch (side.kind) {
    case 'too-large':
      return {
        kind: 'blocked',
        why: 'too large to expand',
        detail: `the file is ${Math.ceil(side.bytes / 1024)} KiB, past the most sent to the page`,
      }
    case 'text':
      return CHANGED_SINCE
    case 'binary':
      return { kind: 'blocked', why: 'a binary file', detail: 'a binary file has no lines' }
    case 'unavailable':
      return { kind: 'blocked', why: "can't be read", detail: side.reason }
    case 'none':
      return { kind: 'blocked', why: "can't be read", detail: 'the file is on neither side' }
  }
}

/**
 * What the unchanged runs of a file whose patch is `hunks` can be shown from: the old side's lines,
 * while they agree with the patch — held to the new side's unchanged lines too when the hunks show
 * the new side as text. A file not there before has none: its new side must be all the hunks show.
 * Never for a type change.
 */
export function expansionOf(
  readFile: ReadChangedFile | undefined,
  outcome: ChangedFileOutcome | undefined,
  change: Pick<EnsoGitFileChange, 'status'>,
  hunks: readonly DiffHunk[],
): Expansion {
  if (readFile === undefined) return { kind: 'off' }
  if (change.status === 'type-changed') return TYPE_CHANGED
  if (outcome === undefined) return { kind: 'reading' }
  if (outcome.kind === 'failed') return { kind: 'blocked', why: "can't be read", detail: outcome.problem }
  const { file } = outcome
  const newLines = file.newText.kind === 'text' ? linesOf(file.newText.text) : undefined
  if (file.oldText.kind === 'none') {
    // No old file, no unchanged lines: a line of the new one past what the hunks show came since.
    if (newLines === undefined) return blockedBy(file.newText)
    const whole = agreesWith(hunks, newLines, 'new') && sameHiddenLines(hunks, [], newLines)
    return whole ? { kind: 'ready', lines: newLines, side: 'new' } : CHANGED_SINCE
  }
  const oldLines = agreeingLines(file.oldText, hunks, 'old')
  if (oldLines === undefined) return blockedBy(file.oldText)
  // The new side, where the hunks show it as text, must hold the same unchanged lines.
  const held = newLines === undefined || !showsNew(hunks) || sameHiddenLines(hunks, oldLines, newLines)
  return held ? { kind: 'ready', lines: oldLines, side: 'old' } : CHANGED_SINCE
}

/** Each side's lines as tokens, where the file's language is one the view highlights. */
export type FileSyntax = Readonly<Record<Side, HighlightedLines | undefined>>

const NO_SYNTAX: FileSyntax = { old: undefined, new: undefined }

/** Both sides highlighted; a highlighter that cannot load leaves the file plain. */
async function highlightFile(file: EnsoThreadChangedFile, language: SyntaxLanguage): Promise<FileSyntax> {
  try {
    const [old, current] = await Promise.all(
      [file.oldText, file.newText].map((side) =>
        side.kind === 'text' ? highlightLines(side.text, language) : Promise.resolve(undefined),
      ),
    )
    return { old, new: current }
  } catch {
    return NO_SYNTAX
  }
}

/**
 * The syntax of the file `outcome` read, when its path names a language the view highlights —
 * nothing until it is tokenised, and nothing for a file read as no text. Each line is drawn from
 * its tokens only when they spell exactly its text (`thread-changes.tsx`'s `LineText`).
 */
export function useFileSyntax(path: string, outcome: ChangedFileOutcome | undefined): FileSyntax {
  const file = outcome?.kind === 'read' ? outcome.file : undefined
  const [held, setHeld] = useState<{ readonly file: EnsoThreadChangedFile; readonly syntax: FileSyntax } | undefined>()
  useEffect(() => {
    const language = languageOf(path)
    if (file === undefined || language === undefined) return undefined
    let current = true
    void highlightFile(file, language).then((syntax) => {
      if (current) setHeld({ file, syntax })
    })
    return () => {
      current = false
    }
  }, [path, file])
  return held !== undefined && held.file === file ? held.syntax : NO_SYNTAX
}
