import { type EnsoGitFileChange, type EnsoGitRepository, EnsoThreadChanges } from '@enso/core'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { type DiffHunk, type DiffLine, hiddenBefore, parsePatch, type SplitRow, splitRows } from './diff-rows.ts'
import { buildFileTree, filesInOrder, type TreeNode } from './file-tree.ts'
import { useReadOnUsage } from './read-on-usage.ts'
import { readThreadRoute, THREAD_READ_NONE, type ThreadReadOutcome } from './route-read.ts'
import { baselineText } from './thread-git.tsx'

/**
 * The Changes view (#452): every file in the thread's project that differs from the last push, as
 * a tree, and the chosen file's diff side by side — the old file on the left, the new on the right.
 * A project inside a larger repository shows its own directory's files only (`scope`).
 * Off `GET /api/threads/:threadId/changes`, which diffs the working tree against the baseline #453
 * resolves, so unpushed commits, staged and unstaged edits and new files all show, however they
 * were made: an `edit`, a `write`, or a `sed -i` in `bash`.
 *
 * ⚠ READ WHEN THE TREE MAY HAVE MOVED — the status bar's git readout's rule: on open, whenever a
 * tool result settles or the run flag changes (`moment`), and when the thread's usage moves. The
 * file on screen stays chosen across reads while it still differs.
 *
 * ⚠ ONLY WHAT GIT SENT. Unchanged lines between hunks are git's three lines of context and a count
 * of what it left out; a binary file, one past the size a page is sent, or one git did not diff says
 * so instead of a diff. Nothing here reads the files themselves.
 */

/** What the view holds: nothing yet (a thread nothing has run in), the changes, or why not. */
export type ChangesOutcome = ThreadReadOutcome<EnsoThreadChanges>

/** `GET /api/threads/:threadId/changes`, as the view holds it. */
export const readThreadChanges = (threadId: string, fetchImpl: FetchLike): Promise<ChangesOutcome> =>
  readThreadRoute(threadId, 'changes', EnsoThreadChanges, fetchImpl)

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
  if (added === null || removed === null) return <span className="text-muted-foreground">—</span>
  return (
    <span className="tabular-nums">
      <span className="text-ok">+{added}</span> <span className="text-refuse">−{removed}</span>
    </span>
  )
}

const TREE_ROW =
  'flex w-full items-center gap-1.5 rounded-sm py-0.5 pr-2 text-left hover:bg-popover focus-visible:outline-2 focus-visible:outline-ring'

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
    <ul>
      {nodes.map((node) => {
        if (node.kind === 'file') {
          const { change } = node
          const current = change.path === selected
          return (
            <li key={change.path}>
              <button
                type="button"
                className={`${TREE_ROW} ${current ? 'bg-popover text-foreground' : 'text-muted-foreground'}`}
                style={indent(depth)}
                aria-current={current ? 'true' : undefined}
                title={change.oldPath === null ? change.path : `${change.oldPath} → ${change.path}`}
                onClick={(): void => onSelect(change.path)}
              >
                <span className={`w-3 shrink-0 font-semibold ${STATUS_CLASS[change.status]}`} title={change.status}>
                  {STATUS_LETTER[change.status]}
                </span>
                <span className="min-w-0 flex-1 truncate">{node.name}</span>
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
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
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

/** One side of a row: its line number on that side and its text, or an empty cell where the other side has more. */
function Side({ line, side }: { readonly line: DiffLine | null; readonly side: 'old' | 'new' }): React.ReactNode {
  if (line === null) return <td colSpan={2} aria-label="no line on this side" className="bg-muted/40" />
  const marker = MARKER[line.kind]
  return (
    <>
      <td className={`w-12 border-r px-2 text-right text-muted-foreground select-none ${CELL_CLASS[line.kind]}`}>
        {side === 'old' ? line.oldNumber : line.newNumber}
      </td>
      <td className={`px-2 break-all whitespace-pre-wrap ${CELL_CLASS[line.kind]}`}>
        <span aria-hidden="true" className="text-muted-foreground select-none">
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
}: {
  readonly hunk: DiffHunk
  readonly previous: DiffHunk | undefined
}): React.ReactNode {
  const hidden = hiddenBefore(hunk, previous)
  return (
    <tbody>
      <tr>
        <td colSpan={4} className="border-y bg-muted/60 px-2 py-1 text-muted-foreground">
          {hidden === 0 ? null : (
            <span className="mr-3">⋯ {hidden === 1 ? '1 unchanged line' : `${hidden} unchanged lines`}</span>
          )}
          {hunk.header}
        </td>
      </tr>
      {splitRows(hunk).map((row) => (
        <tr key={rowKey(row)} className="align-top">
          <Side line={row.left} side="old" />
          <Side line={row.right} side="new" />
        </tr>
      ))}
    </tbody>
  )
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
  return (
    <section aria-label={`changes to ${change.path}`} className="min-w-0">
      <header className="sticky top-0 z-10 flex flex-wrap items-baseline gap-x-3 border-b bg-background px-3 py-2">
        <h3 className="font-mono text-sm text-foreground">
          {change.oldPath === null ? change.path : `${change.oldPath} → ${change.path}`}
        </h3>
        <span className={`text-xs ${STATUS_CLASS[change.status]}`}>{change.status}</span>
        <span className="text-xs">
          <Counts added={change.added} removed={change.removed} />
        </span>
      </header>
      {hunks.length === 0 ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">{omittedText(change)}</p>
      ) : (
        <table className="w-full table-fixed border-collapse font-mono text-xs">
          <colgroup>
            <col className="w-12" />
            <col />
            <col className="w-12" />
            <col />
          </colgroup>
          {hunks.map((hunk, hunkIndex) => (
            <Hunk key={hunk.header + String(hunkIndex)} hunk={hunk} previous={hunks[hunkIndex - 1]} />
          ))}
        </table>
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

function RepositoryChanges({
  repository,
  files,
  truncated,
}: {
  readonly repository: EnsoGitRepository
  readonly files: readonly EnsoGitFileChange[]
  readonly truncated: boolean
}): React.ReactNode {
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const tree = buildFileTree(files)
  const ordered = filesInOrder(tree)
  // The chosen file while it still differs; otherwise the first in the tree.
  const shown = ordered.find((change) => change.path === chosen) ?? ordered[0]
  const added = files.reduce((sum, change) => sum + (change.added ?? 0), 0)
  const removed = files.reduce((sum, change) => sum + (change.removed ?? 0), 0)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2 text-sm">
        <h2 className="font-medium text-foreground">Changes</h2>
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
        <p className="px-4 py-6 text-sm text-muted-foreground">Nothing differs: the tree matches the baseline.</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="changed files"
            className="w-changes-tree shrink-0 overflow-y-auto border-r py-1 font-mono text-xs"
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

/** Pure view of the outcome: every state said as what it is. */
export function ThreadChangesView({ outcome }: { readonly outcome: ChangesOutcome }): React.ReactNode {
  if (outcome.kind === 'none') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">Nothing has run in this thread yet.</p>
  }
  if (outcome.kind === 'failed') {
    return <p className="px-4 py-6 text-sm text-refuse">The changes could not be read: {outcome.problem}</p>
  }
  const { git, files, truncated } = outcome.payload
  if (git.kind === 'not-a-repository') {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        This thread&apos;s project is not in a git repository, so there is nothing to compare with.
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
  const outcome = useReadOnUsage(readThreadChanges, THREAD_READ_NONE, moment)
  return <ThreadChangesView outcome={outcome} />
}
