import { type EnsoGitFileChange, type EnsoGitRepository, EnsoThreadChanges } from '@enso/core'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { type DiffHunk, type DiffLine, hiddenBefore, parsePatch, type SplitRow, splitRows } from './diff-rows.ts'
import { buildFileTree, filesInOrder, type TreeNode } from './file-tree.ts'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, readThreadRoute, type ThreadReadOutcome } from './route-read.ts'
import { baselineText } from './thread-git.tsx'

/**
 * The Diff view (#452): every file in the thread's project that differs from the last push, as
 * a tree, and the chosen file's diff side by side — the old file on the left, the new on the right.
 * A project inside a larger repository shows its own directory's files only (`scope`).
 * Off `GET /api/threads/:threadId/changes`, which diffs the working tree against the baseline #453
 * resolves, so unpushed commits, staged and unstaged edits and new files all show, however they
 * were made: an `edit`, a `write`, or a `sed -i` in `bash`. A thread whose tree is a copy of its
 * project (#650) has no repository: its files changed since the copy was made, off its store.
 *
 * ⚠ READ WHEN THE TREE MAY HAVE MOVED — the status bar's git readout's rule: on open, whenever a
 * tool result settles or the run flag changes (`moment`), and when the thread's usage moves. The
 * file on screen stays chosen across reads while it still differs.
 *
 * ⚠ ONLY WHAT GIT SENT. Unchanged lines between hunks are git's three lines of context and a count
 * of what it left out; a binary file, one past the size a page is sent, or one git did not diff says
 * so instead of a diff. Nothing here reads the files themselves.
 */

/**
 * What the view holds: not read yet, nothing (a thread nothing has run in: the route's 404), the
 * changes, or why not. ⚠ `reading` is its own state (#657): the shared `THREAD_READ_NONE` is also
 * where a read STARTS, and the tab said "Nothing has run in this thread yet" until its first answer
 * came back — an agent that looked at once was told so on a thread that had run.
 */
export type ChangesOutcome = ThreadReadOutcome<EnsoThreadChanges> | typeof ANALYSIS_READING

/** `GET /api/threads/:threadId/changes`: the settled half of what the view holds — the changes, nothing (404), or why not. */
export const readThreadChanges = (
  threadId: string,
  fetchImpl: FetchLike,
): Promise<ThreadReadOutcome<EnsoThreadChanges>> => readThreadRoute(threadId, 'changes', EnsoThreadChanges, fetchImpl)

// ── the tree ─────────────────────────────────────────────────────────────────────────────────

/** git's letter for a status, as the tree marks a file. */
const STATUS_LETTER: Readonly<Record<EnsoGitFileChange['status'], string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: 'U',
}

const STATUS_CLASS: Readonly<Record<EnsoGitFileChange['status'], string>> = {
  added: 'text-ok',
  untracked: 'text-ok',
  deleted: 'text-refuse',
  modified: 'text-evidence',
  renamed: 'text-evidence',
  copied: 'text-evidence',
  'type-changed': 'text-evidence',
}

/** `+3 −1`, or what stands in for counts git could not give. */
function Counts({
  added,
  removed,
}: {
  readonly added: number | null
  readonly removed: number | null
}): React.ReactNode {
  if (added === null || removed === null) return <span className="shrink-0 text-muted-foreground">—</span>
  return (
    <span className="shrink-0 whitespace-nowrap tabular-nums">
      <span className="text-ok">+{added}</span> <span className="text-refuse">−{removed}</span>
    </span>
  )
}

/** A tree row — the prototype's `.diff-file` (#417): rounded, card on hover, accent when chosen. */
const TREE_ROW =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors hover:bg-card focus-visible:outline-2 focus-visible:outline-ring'

interface TreeProps {
  readonly nodes: readonly TreeNode[]
  readonly depth: number
  readonly selected: string | undefined
  readonly closed: ReadonlySet<string>
  readonly onSelect: (path: string) => void
  readonly onToggle: (path: string) => void
}

/** Indentation per level, as padding: the tree's one arbitrary measure. */
const indent = (depth: number): React.CSSProperties => ({ paddingLeft: `${depth * 0.75 + 0.25}rem` })

function TreeLevel({ nodes, depth, selected, closed, onSelect, onToggle }: TreeProps): React.ReactNode {
  return (
    <ul className="grid grid-cols-1 gap-0.5">
      {nodes.map((node) => {
        if (node.kind === 'file') {
          const { change } = node
          const current = change.path === selected
          return (
            <li key={change.path}>
              <button
                type="button"
                className={`${TREE_ROW} ${current ? 'bg-accent text-foreground hover:bg-accent' : 'text-muted-foreground'}`}
                style={indent(depth)}
                aria-current={current ? 'true' : undefined}
                title={change.oldPath === null ? change.path : `${change.oldPath} → ${change.path}`}
                onClick={(): void => onSelect(change.path)}
              >
                <span className={`w-3 shrink-0 font-semibold ${STATUS_CLASS[change.status]}`} title={change.status}>
                  {STATUS_LETTER[change.status]}
                </span>
                <span className="min-w-0 flex-1 truncate-start">
                  <bdi dir="ltr">{node.name}</bdi>
                </span>
                <Counts added={change.added} removed={change.removed} />
              </button>
            </li>
          )
        }
        const open = !closed.has(node.path)
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`${TREE_ROW} text-foreground`}
              style={indent(depth)}
              aria-expanded={open}
              onClick={(): void => onToggle(node.path)}
            >
              {open ? (
                <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
              ) : (
                <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate-start">
                <bdi dir="ltr">{node.name}</bdi>
              </span>
              <Counts added={node.added} removed={node.removed} />
            </button>
            {open ? (
              <TreeLevel
                nodes={node.children}
                depth={depth + 1}
                selected={selected}
                closed={closed}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

// ── the diff ─────────────────────────────────────────────────────────────────────────────────

/** The sign before a line's text, as a diff reader expects it. */
const MARKER: Readonly<Record<DiffLine['kind'], string>> = { context: ' ', removed: '−', added: '+' }

const CELL_CLASS: Readonly<Record<DiffLine['kind'], string>> = {
  context: '',
  removed: 'bg-refuse/15',
  added: 'bg-ok/15',
}

/**
 * One side of a row: its line number on that side and its text, or an empty cell where the other side has more.
 * `marked`: whether a reader hears the line's `+`/`−`, which is what says which side a line is on (#847).
 *
 * ⚠ THE EMPTY CELL IS HIDDEN FROM READERS (#847). A label on it is read in the cell and again in the row's
 * name, so a one-sided file repeats it twice a line. A one-sided file says its missing side once, on the
 * table; in a file with both sides the line's own marker says which side it is on.
 */
function Side({
  line,
  side,
  marked,
}: {
  readonly line: DiffLine | null
  readonly side: 'old' | 'new'
  readonly marked: boolean
}): React.ReactNode {
  if (line === null) return <td colSpan={2} aria-hidden="true" className="bg-muted/40" />
  const marker = MARKER[line.kind]
  return (
    <>
      <td className={`w-12 border-r px-2 text-right text-muted-foreground select-none ${CELL_CLASS[line.kind]}`}>
        {side === 'old' ? line.oldNumber : line.newNumber}
      </td>
      <td className={`px-2 break-all whitespace-pre-wrap ${CELL_CLASS[line.kind]}`}>
        <span aria-hidden={marked ? undefined : true} className="text-muted-foreground select-none">
          {marker}{' '}
        </span>
        {line.text}
        {line.noNewline ? <span className="ml-2 text-muted-foreground">(no newline at end of file)</span> : null}
      </td>
    </>
  )
}

/** A row's key: its two line numbers, which no other row in its hunk shares. */
const rowKey = (row: SplitRow): string => `${row.left?.oldNumber ?? ''}:${row.right?.newNumber ?? ''}`

function Hunk({
  hunk,
  previous,
  marked,
}: {
  readonly hunk: DiffHunk
  readonly previous: DiffHunk | undefined
  readonly marked: boolean
}): React.ReactNode {
  const hidden = hiddenBefore(hunk, previous)
  return (
    <tbody>
      <tr>
        <td colSpan={4} className="border-y bg-background px-3 py-1 text-chart-1">
          {hidden === 0 ? null : (
            <span className="mr-3 text-muted-foreground">
              ⋯ {hidden === 1 ? '1 unchanged line' : `${hidden} unchanged lines`}
            </span>
          )}
          {hunk.header}
        </td>
      </tr>
      {splitRows(hunk).map((row) => (
        <tr key={rowKey(row)} className="align-top">
          <Side line={row.left} side="old" marked={marked} />
          <Side line={row.right} side="new" marked={marked} />
        </tr>
      ))}
    </tbody>
  )
}

/**
 * What a reader is told once of a file with no old side (added or untracked) or no new side (deleted), or
 * `undefined` for a file with both (#847).
 *
 * ⚠ FROM GIT'S STATUS, NOT THE PATCH. Under `diff.context = 0` an insertion into an existing file is all
 * `+` lines, and at the top of the file its header is a new file's (`@@ -0,0 +1 @@`); a deletion from
 * the top is a deleted file's (`+0,0`). Neither the line kinds nor the hunk ranges tell them apart.
 */
function oneSidedLabel(status: EnsoGitFileChange['status']): string | undefined {
  if (status === 'added' || status === 'untracked') return 'the old side has no lines: every line here is added'
  if (status === 'deleted') return 'the new side has no lines: every line here is removed'
  return undefined
}

/** Why a file has no diff to draw. */
function omittedText(change: EnsoGitFileChange): string {
  if (change.omitted === 'binary') return 'A binary file: there are no lines to compare.'
  if (change.omitted === 'too-large') return 'Too large to show here. Run git diff on this file to see it.'
  if (change.omitted === 'unavailable') return 'git did not produce this diff. Run git diff on this file to see it.'
  return 'git reported no line changes: a mode change, or an empty file.'
}

function FileDiff({ change }: { readonly change: EnsoGitFileChange }): React.ReactNode {
  const hunks = change.patch === null ? [] : parsePatch(change.patch)
  const oneSided = oneSidedLabel(change.status)
  return (
    <section aria-label={`changes to ${change.path}`} className="min-w-0 p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 pb-3">
        <h3 className="font-mono text-sm break-all text-foreground">
          {change.oldPath === null ? change.path : `${change.oldPath} → ${change.path}`}
        </h3>
        <span className={`text-xs ${STATUS_CLASS[change.status]}`}>{change.status}</span>
        <span className="font-mono text-xs">
          <Counts added={change.added} removed={change.removed} />
        </span>
      </header>
      {hunks.length === 0 ? (
        <p className="rounded-sm border bg-card px-3 py-4 text-sm text-muted-foreground">{omittedText(change)}</p>
      ) : (
        // The prototype's `.diff-code` (#417): one bordered card block of relaxed lines; the split view kept.
        <div className="overflow-hidden rounded-sm border bg-card">
          <table aria-label={oneSided} className="w-full table-fixed border-collapse font-mono text-xs leading-relaxed">
            <colgroup>
              <col className="w-12" />
              <col />
              <col className="w-12" />
              <col />
            </colgroup>
            {hunks.map((hunk, hunkIndex) => (
              <Hunk
                key={hunk.header + String(hunkIndex)}
                hunk={hunk}
                previous={hunks[hunkIndex - 1]}
                marked={oneSided === undefined}
              />
            ))}
          </table>
        </div>
      )}
    </section>
  )
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────

function toggled(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(set)
  if (!next.delete(path)) next.add(path)
  return next
}

/**
 * The file a tool card asked the Diff view to show (#920), as the call named it — relative to the
 * thread's folder or absolute — and a fresh object per ask, so asking for the same file again shows it
 * again. Provided by the views' box (`chat-layout.tsx`).
 */
export const DiffFocusContext = createContext<{ readonly path: string } | undefined>(undefined)

/**
 * Whether a changed file (relative to the repository) is the one a call named: the same path, or
 * one ending in the other — an absolute path ends in the repository's, and a path relative to a
 * folder inside the repository is the end of the repository's.
 */
function samePath(changed: string, named: string): boolean {
  const asked = named.replace(/^\.\//, '')
  return changed === asked || asked.endsWith(`/${changed}`) || changed.endsWith(`/${asked}`)
}

/**
 * The Diff header — `description` says what the files are compared with — then the changed files
 * as a tree and the chosen file's diff: a repository's and a copy's alike.
 */
function ChangedFiles({
  description,
  files,
  truncated,
  nothingText,
}: {
  readonly description: React.ReactNode
  readonly files: readonly EnsoGitFileChange[]
  readonly truncated: boolean
  readonly nothingText: string
}): React.ReactNode {
  const focus = useContext(DiffFocusContext)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  // A tool card's "open in Diff" (#920) asks for its file afresh: a click in the tree before it yields.
  useEffect(() => setChosen(undefined), [focus])
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const tree = buildFileTree(files)
  const ordered = filesInOrder(tree)
  // The chosen file while it still differs; else the asked-for file; otherwise the first in the tree.
  const shown =
    ordered.find((change) => change.path === chosen) ??
    (focus === undefined ? undefined : ordered.find((change) => samePath(change.path, focus.path))) ??
    ordered[0]
  const added = files.reduce((sum, change) => sum + (change.added ?? 0), 0)
  const removed = files.reduce((sum, change) => sum + (change.removed ?? 0), 0)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2 text-sm">
        <h2 className="font-heading font-semibold text-foreground">Diff</h2>
        {description}
        <span className="ml-auto text-xs text-muted-foreground">
          {files.length}
          {truncated ? '+' : ''} {files.length === 1 ? 'file' : 'files'} · <Counts added={added} removed={removed} />
        </span>
      </header>
      {truncated ? (
        <p className="border-b px-4 py-1 text-xs text-muted-foreground">
          More files differ than are shown here; the first {files.length} are listed.
        </p>
      ) : null}
      {files.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{nothingText}</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="changed files"
            className="w-changes-tree shrink-0 overflow-y-auto border-r p-3 font-mono text-xs"
          >
            <TreeLevel
              nodes={tree.children}
              depth={0}
              selected={shown?.path}
              closed={closed}
              onSelect={setChosen}
              onToggle={(path: string): void => setClosed((current) => toggled(current, path))}
            />
          </nav>
          <div className="min-w-0 flex-1 overflow-auto">{shown === undefined ? null : <FileDiff change={shown} />}</div>
        </div>
      )}
    </div>
  )
}

function RepositoryChanges({
  repository,
  files,
  truncated,
}: {
  readonly repository: EnsoGitRepository
  readonly files: readonly EnsoGitFileChange[]
  readonly truncated: boolean
}): React.ReactNode {
  return (
    <ChangedFiles
      description={
        <>
          <span className="text-muted-foreground" title="as this clone last saw the remote — Enso never fetches">
            {baselineText(repository)}
          </span>
          {repository.scope === '' ? null : (
            <span
              className="font-mono text-xs text-muted-foreground"
              title="files outside this directory are not compared"
            >
              in {repository.scope}
            </span>
          )}
        </>
      }
      files={files}
      truncated={truncated}
      nothingText="Nothing differs: the tree matches the baseline."
    />
  )
}

/**
 * A thread's copy of its project (#650): no repository, so no branch, baseline or ahead/behind —
 * the files changed since the copy was made, off its snapshot store.
 */
function CopyChanges({
  project,
  files,
  truncated,
}: {
  readonly project: string
  readonly files: readonly EnsoGitFileChange[]
  readonly truncated: boolean
}): React.ReactNode {
  // The project directory's name; the whole path is its title.
  const name = project.split('/').findLast((part) => part !== '') ?? project
  return (
    <ChangedFiles
      description={
        <span className="text-muted-foreground" title={project}>
          Changes in this thread&apos;s copy of {name} since the copy was made
        </span>
      }
      files={files}
      truncated={truncated}
      nothingText="Nothing differs: the copy matches the project as it was copied."
    />
  )
}

/** Pure view of the outcome: every state said as what it is. */
export function ThreadChangesView({ outcome }: { readonly outcome: ChangesOutcome }): React.ReactNode {
  if (outcome.kind === 'reading') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">reading the changes…</p>
  }
  if (outcome.kind === 'none') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">Nothing has run in this thread yet.</p>
  }
  if (outcome.kind === 'failed') {
    return <p className="px-4 py-6 text-sm text-refuse">The changes could not be read: {outcome.problem}</p>
  }
  const { git, files, truncated, copy } = outcome.payload
  if (copy !== null) return <CopyChanges project={copy.project} files={files} truncated={truncated} />
  if (git.kind === 'not-a-repository') {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        This thread&apos;s folder is not in a git repository, so there is nothing to compare with.
      </p>
    )
  }
  if (git.kind === 'unavailable') {
    return <p className="px-4 py-6 text-sm text-refuse">git could not answer: {git.reason}</p>
  }
  return <RepositoryChanges repository={git} files={files} truncated={truncated} />
}

/**
 * The view wired to its thread: read on open, whenever `moment` changes (a tool result settled, the
 * run started or ended) and whenever the thread's usage moves.
 */
export function ThreadChanges({ moment }: { readonly moment: string }): React.ReactNode {
  const outcome = useReadOnUsage<ChangesOutcome>(readThreadChanges, ANALYSIS_READING, moment)
  return <ThreadChangesView outcome={outcome} />
}
