import { type EnsoGitFileChange, type EnsoGitRepository, EnsoThreadChanges } from '@enso/core'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import {
  type Expansion,
  expansionOf,
  type FileSyntax,
  type ReadChangedFile,
  readChangedFile,
  useChangedFile,
  useFileSyntax,
} from './changed-file.ts'
import type { SyntaxToken } from './diff-highlight.ts'
import {
  type DiffHunk,
  type DiffLine,
  type HiddenRun,
  hiddenAfter,
  hiddenBefore,
  hiddenRows,
  parsePatch,
  type SplitRow,
  splitRows,
} from './diff-rows.ts'
import { buildFileTree, filesInOrder, type TreeNode } from './file-tree.ts'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, readThreadRoute, type ThreadReadOutcome } from './route-read.ts'
import { useThreadStores } from './store.ts'
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
 * ⚠ GIT'S PATCH, THEN THE FILE WHOLE (#461). The diff is git's patch: three lines of context around
 * each change and a count of the unchanged lines it left out. Clicking a count shows those lines,
 * numbered on both sides, from the file read whole (`changed-file.ts`, `GET …/changes/file`) —
 * the same read colours each side's syntax. A file whose old side is past the size a patch may be
 * stays unexpandable and says so; a binary file, one past the size a page is sent, or one git did
 * not diff says so instead of a diff.
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
  syntax,
}: {
  readonly line: DiffLine | null
  readonly side: 'old' | 'new'
  readonly marked: boolean
  readonly syntax: FileSyntax
}): React.ReactNode {
  if (line === null) return <td colSpan={2} aria-hidden="true" className="bg-muted/40" />
  const marker = MARKER[line.kind]
  const number = side === 'old' ? line.oldNumber : line.newNumber
  return (
    <>
      <td className={`w-12 border-r px-2 text-right text-muted-foreground select-none ${CELL_CLASS[line.kind]}`}>
        {number}
      </td>
      <td className={`px-2 break-all whitespace-pre-wrap ${CELL_CLASS[line.kind]}`}>
        <span aria-hidden={marked ? undefined : true} className="text-muted-foreground select-none">
          {marker}{' '}
        </span>
        <LineText text={line.text} tokens={number === null ? undefined : syntax[side]?.[number - 1]} />
        {line.noNewline ? <span className="ml-2 text-muted-foreground">(no newline at end of file)</span> : null}
      </td>
    </>
  )
}

/**
 * A line's text, in its syntax's tokens when they spell exactly that text (#461) — tokens from a
 * file that does not match the patch never colour a line they are not — else as it is. A CRLF
 * line's `\r` is not drawn.
 */
function LineText({
  text,
  tokens,
}: {
  readonly text: string
  readonly tokens: readonly SyntaxToken[] | undefined
}): React.ReactNode {
  const shown = text.replace(/\r$/, '')
  if (tokens === undefined || tokens.map((token) => token.text).join('') !== shown) return shown
  let offset = 0
  return tokens.map((token) => {
    const at = offset
    offset += token.text.length
    return (
      <span key={at} className={token.className === '' ? undefined : token.className}>
        {token.text}
      </span>
    )
  })
}

/** A row's key: its two line numbers, which no other row in its hunk shares. */
const rowKey = (row: SplitRow): string => `${row.left?.oldNumber ?? ''}:${row.right?.newNumber ?? ''}`

/** What every row of a file is drawn with: whether its markers are heard (#847), and its syntax (#461). */
interface RowLook {
  readonly marked: boolean
  readonly syntax: FileSyntax
}

function Rows({ rows, look }: { readonly rows: readonly SplitRow[]; readonly look: RowLook }): React.ReactNode {
  return rows.map((row) => (
    <tr key={rowKey(row)} className="align-top">
      <Side line={row.left} side="old" marked={look.marked} syntax={look.syntax} />
      <Side line={row.right} side="new" marked={look.marked} syntax={look.syntax} />
    </tr>
  ))
}

/** A run of unchanged lines git left out, how the file can show it, and whether it is open (#461). */
interface RunControl {
  readonly run: HiddenRun
  readonly expansion: Expansion
  readonly open: boolean
  readonly onToggle: () => void
}

/**
 * `⋯ N unchanged lines` — a button that shows them, numbered on both sides, and hides them again,
 * while the file can show them; plain text, with why not beside it, when it cannot (#461).
 */
function RunCount({ control }: { readonly control: RunControl }): React.ReactNode {
  const { run, expansion, open, onToggle } = control
  const words = run.count === 1 ? '1 unchanged line' : `${run.count} unchanged lines`
  if (expansion.kind === 'ready' || expansion.kind === 'reading') {
    return (
      <button
        type="button"
        aria-expanded={open}
        title={open ? `Hide the ${words}` : `Show the ${words}`}
        onClick={onToggle}
        className="mr-3 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        ⋯ {words}
      </button>
    )
  }
  return (
    <span className="mr-3 text-muted-foreground">
      <span>⋯ {words}</span>
      {expansion.kind === 'blocked' ? <span title={expansion.detail}> · {expansion.why}</span> : null}
    </span>
  )
}

/** An open run's lines, numbered on both sides — or, while the file is still being read, that it is. */
function RunRows({ control, look }: { readonly control: RunControl; readonly look: RowLook }): React.ReactNode {
  const { run, expansion, open } = control
  if (!open || run.count === 0) return null
  if (expansion.kind === 'reading') {
    return (
      <tr>
        <td colSpan={4} className="px-3 py-1 text-muted-foreground">
          reading the file…
        </td>
      </tr>
    )
  }
  if (expansion.kind !== 'ready') return null
  return <Rows rows={hiddenRows(run, expansion.lines, expansion.side)} look={look} />
}

/** The row a run's count sits in: a hunk's header row, or the row after the last hunk. */
const COUNT_ROW = 'border-y bg-background px-3 py-1 text-chart-1'

function Hunk({
  hunk,
  before,
  look,
}: {
  readonly hunk: DiffHunk
  readonly before: RunControl
  readonly look: RowLook
}): React.ReactNode {
  return (
    <tbody>
      <RunRows control={before} look={look} />
      <tr>
        <td colSpan={4} className={COUNT_ROW}>
          {before.run.count === 0 ? null : <RunCount control={before} />}
          {hunk.header}
        </td>
      </tr>
      <Rows rows={splitRows(hunk)} look={look} />
    </tbody>
  )
}

/** The unchanged lines after the last hunk, once the file is read and says how many (#461). */
function RunAfter({ control, look }: { readonly control: RunControl; readonly look: RowLook }): React.ReactNode {
  if (control.run.count === 0) return null
  return (
    <tbody>
      <tr>
        <td colSpan={4} className={COUNT_ROW}>
          <RunCount control={control} />
        </td>
      </tr>
      <RunRows control={control} look={look} />
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

function FileDiff({
  change,
  readFile,
}: {
  readonly change: EnsoGitFileChange
  readonly readFile: ReadChangedFile | undefined
}): React.ReactNode {
  const hunks = useMemo(() => (change.patch === null ? [] : parsePatch(change.patch)), [change.patch])
  const outcome = useChangedFile(readFile, change)
  const syntax = useFileSyntax(change.path, outcome)
  const expansion = useMemo(() => expansionOf(readFile, outcome, change, hunks), [readFile, outcome, change, hunks])
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const oneSided = oneSidedLabel(change.status)
  const look: RowLook = { marked: oneSided === undefined, syntax }
  // A run is known by where it starts, so one stays open across a read that moved another.
  const control = (run: HiddenRun, key: string): RunControl => ({
    run,
    expansion,
    open: opened.has(key),
    onToggle: () => setOpened((current) => toggled(current, key)),
  })
  const last = hunks.at(-1)
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
      {last === undefined ? (
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
            {hunks.map((hunk, hunkIndex) => {
              const run = hiddenBefore(hunk, hunks[hunkIndex - 1])
              return (
                <Hunk
                  key={hunk.header + String(hunkIndex)}
                  hunk={hunk}
                  before={control(run, `${run.oldStart}`)}
                  look={look}
                />
              )
            })}
            {expansion.kind === 'ready' ? (
              <RunAfter control={control(hiddenAfter(last, expansion.lines, expansion.side), 'end')} look={look} />
            ) : null}
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
 * Where the changed files' paths start from: `root`, the absolute folder they are relative to (a
 * repository's top level, a copy's tree), and `scope`, the thread's folder within it (`''` at the
 * top, else `/`-ended) — what a call's relative path is relative to.
 */
interface FilesPlace {
  readonly root: string
  readonly scope: string
}

/**
 * The changed file a call's path names (#920). The path is first read as pi's tools read it: a
 * leading `@` (pi's mention mark) dropped. A path that then places cleanly under `place.root` — an
 * absolute one under the root loses it, a relative one without a `..` gains the thread's `scope` —
 * names exactly the file at that path, or none: a same-named file elsewhere is a different file,
 * even when the named one is missing from the list (truncated, or written back to its baseline).
 * Only a path that cannot be placed here falls back to a shared suffix, and then the longest such
 * file: one pi expands on the host (`~`, `~/…`, a `file:` URL — this page knows no home folder),
 * a root reached through a symlink, a `..`.
 */
function namedFile(
  ordered: readonly EnsoGitFileChange[],
  named: string,
  place: FilesPlace,
): EnsoGitFileChange | undefined {
  const asked = named.replace(/^@/, '').replace(/^\.\//, '')
  const rootPrefix = `${place.root.replace(/\/$/, '')}/`
  const absolute = asked.startsWith('/')
  const expandedByPi = asked === '~' || asked.startsWith('~/') || asked.startsWith('file:')
  const placeable = !expandedByPi && (!absolute || asked.startsWith(rootPrefix))
  if (placeable && !asked.split('/').includes('..')) {
    const relative = absolute ? asked.slice(rootPrefix.length) : `${place.scope}${asked}`
    return ordered.find((change) => change.path === relative)
  }
  const sharing = ordered.filter((change) => asked.endsWith(`/${change.path}`) || change.path.endsWith(`/${asked}`))
  return sharing.reduce<EnsoGitFileChange | undefined>(
    (longest, change) => (longest === undefined || change.path.length > longest.path.length ? change : longest),
    undefined,
  )
}

/** The file a tool card's "open in Diff" asks for, when there is an ask and a `place` to read it in. */
function askedFile(
  ordered: readonly EnsoGitFileChange[],
  focus: { readonly path: string } | undefined,
  place: FilesPlace | undefined,
): EnsoGitFileChange | undefined {
  return focus === undefined || place === undefined ? undefined : namedFile(ordered, focus.path, place)
}

/**
 * The Diff header — `description` says what the files are compared with — then the changed files
 * as a tree and the chosen file's diff: a repository's and a copy's alike, and the Diff Viewer's
 * two snapshots (#553) under a `title` of its own. Only the Diff view has a `place`: a tool card's
 * "open in Diff" (#920) asks it for a file, and the Diff Viewer, without one, keeps its own choice.
 */
export function ChangedFiles({
  title = 'Diff',
  description,
  place,
  files,
  truncated,
  nothingText,
  readFile,
}: {
  readonly title?: string
  readonly description: React.ReactNode
  readonly place?: FilesPlace
  readonly files: readonly EnsoGitFileChange[]
  readonly truncated: boolean
  readonly nothingText: string
  readonly readFile: ReadChangedFile | undefined
}): React.ReactNode {
  const focus = useContext(DiffFocusContext)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  // A tool card's "open in Diff" (#920) asks for its file afresh: a click in the tree before it yields.
  useEffect(() => setChosen(undefined), [focus])
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const tree = buildFileTree(files)
  const ordered = filesInOrder(tree)
  // The chosen file while it still differs; else the asked-for file; otherwise the first in the tree.
  const shown = ordered.find((change) => change.path === chosen) ?? askedFile(ordered, focus, place) ?? ordered[0]
  const added = files.reduce((sum, change) => sum + (change.added ?? 0), 0)
  const removed = files.reduce((sum, change) => sum + (change.removed ?? 0), 0)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2 text-sm">
        <h2 className="font-heading font-semibold text-foreground">{title}</h2>
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
          <div className="min-w-0 flex-1 overflow-auto">
            {/* Keyed by the file: another file's open runs and reads never carry over. */}
            {shown === undefined ? null : <FileDiff key={shown.path} change={shown} readFile={readFile} />}
          </div>
        </div>
      )}
    </div>
  )
}

function RepositoryChanges({
  repository,
  files,
  truncated,
  readFile,
}: {
  readonly repository: EnsoGitRepository
  readonly files: readonly EnsoGitFileChange[]
  readonly truncated: boolean
  readonly readFile: ReadChangedFile | undefined
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
      place={repository}
      files={files}
      truncated={truncated}
      readFile={readFile}
      nothingText="Nothing differs: the tree matches the baseline."
    />
  )
}

/**
 * A thread's copy of its project (#650): no repository, so no branch, baseline or ahead/behind —
 * the files changed since the copy was made, off its snapshot store, relative to the copy's tree:
 * the thread's folder, `cwd`.
 */
function CopyChanges({
  project,
  cwd,
  files,
  truncated,
  readFile,
}: {
  readonly project: string
  readonly cwd: string
  readonly files: readonly EnsoGitFileChange[]
  readonly truncated: boolean
  readonly readFile: ReadChangedFile | undefined
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
      place={{ root: cwd, scope: '' }}
      files={files}
      truncated={truncated}
      readFile={readFile}
      nothingText="Nothing differs: the copy matches the project as it was copied."
    />
  )
}

/**
 * Pure view of the outcome: every state said as what it is. `readFile` reads a changed file whole,
 * to expand its unchanged lines and colour its syntax (#461); without one — a static render — the
 * counts stay counts.
 */
export function ThreadChangesView({
  outcome,
  readFile,
}: {
  readonly outcome: ChangesOutcome
  readonly readFile?: ReadChangedFile
}): React.ReactNode {
  if (outcome.kind === 'reading') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">reading the changes…</p>
  }
  if (outcome.kind === 'none') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">Nothing has run in this thread yet.</p>
  }
  if (outcome.kind === 'failed') {
    return <p className="px-4 py-6 text-sm text-refuse">The changes could not be read: {outcome.problem}</p>
  }
  const { cwd, git, files, truncated, copy } = outcome.payload
  if (copy !== null) {
    return <CopyChanges project={copy.project} cwd={cwd} files={files} truncated={truncated} readFile={readFile} />
  }
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
  return <RepositoryChanges repository={git} files={files} truncated={truncated} readFile={readFile} />
}

/**
 * The view wired to its thread: read on open, whenever `moment` changes (a tool result settled, the
 * run started or ended) and whenever the thread's usage moves. A changed file is read whole through
 * the thread's own `fetch`, as its other reads are.
 */
export function ThreadChanges({ moment }: { readonly moment: string }): React.ReactNode {
  const outcome = useReadOnUsage<ChangesOutcome>(readThreadChanges, ANALYSIS_READING, moment)
  const stores = useThreadStores()
  const readFile = useCallback<ReadChangedFile>(
    (change) => readChangedFile(stores.threadId, change, stores.fetch),
    [stores],
  )
  return <ThreadChangesView outcome={outcome} readFile={readFile} />
}
