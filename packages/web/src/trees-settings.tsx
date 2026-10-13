import { type EnsoProject, type EnsoStoredThread, EnsoTreesListing } from '@enso/core'
import { useEffect, useState } from 'react'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { DeleteThreadButton } from './delete-thread-dialog.tsx'
import { describeSize, formatBytes, projectDiskUsage, type SizeSum, totalOf } from './disk-usage.ts'
import { describeFailedResponse } from './stored-threads.ts'

/**
 * Settings' Storage (#578): what thread trees cost on disk, per project — each tree's size, whether
 * it holds work, and its project's snapshot store — so a person can see what to delete and delete
 * it here, through the same dialog as the header's. Read when the section mounts and after each delete;
 * the server walks the disk for it, so nothing polls. A size the server could not read is said as
 * such, never as 0.
 */

export type TreesRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly listing: EnsoTreesListing }
  | { readonly kind: 'failed'; readonly reason: string }

/** `GET /api/trees`, checked against its schema as the delete preview is (`delete-thread.ts`). */
async function readTrees(fetchImpl: FetchLike): Promise<TreesRead> {
  try {
    const response = await fetchImpl('/api/trees')
    if (!response.ok) return { kind: 'failed', reason: await describeFailedResponse(response) }
    const payload: unknown = await response.json()
    if (!Check(EnsoTreesListing, payload))
      return { kind: 'failed', reason: "the server's trees did not match its schema" }
    return { kind: 'read', listing: payload }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The page's `fetch`, read at call time and called as a function. ⚠ Never `globalThis.fetch`
 * itself as a default: the dialog calls `target.fetch(…)`, and a browser's `fetch` refuses any
 * `this` but the window ("Illegal invocation") — the delete failed live while every scripted test
 * passed. Module-level, so the effect that reads the listing sees one function across renders.
 */
const pageFetch: FetchLike = (input, init) => fetch(input, init)

/**
 * `GET /api/trees`, read when the caller mounts and again on `reload` — Storage reloads after a
 * delete, as the tree is gone. The Projects page reads it once (#870). A read answered after the
 * caller unmounted or reloaded is dropped.
 */
export function useTreesListing(fetchImpl: FetchLike | undefined): {
  readonly read: TreesRead
  readonly fetchNow: FetchLike
  readonly reload: () => void
} {
  const fetchNow = fetchImpl ?? pageFetch
  const [read, setRead] = useState<TreesRead>({ kind: 'loading' })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let current = true
    void readTrees(fetchNow).then((next) => {
      if (current) setRead(next)
    })
    return (): void => {
      current = false
    }
  }, [fetchNow, generation])
  return { read, fetchNow, reload: () => setGeneration((count) => count + 1) }
}

/**
 * What a project takes on disk, as the Projects page's card and Storage's project heading both say
 * it (#870): `projectDiskUsage`'s one sum, exact when every part was measured, else "at least" with
 * why — never read as exact.
 */
export function ProjectOnDisk({
  listing,
  projectId,
}: {
  listing: EnsoTreesListing
  projectId: string
}): React.ReactNode {
  const size = projectDiskUsage(listing, projectId)
  return (
    <span>
      <strong className="font-semibold text-foreground tabular-nums">
        {size.kind === 'measured' ? formatBytes(size.bytes) : `at least ${formatBytes(size.bytes)}`}
      </strong>{' '}
      on disk
      {size.kind === 'partial' ? <span className="text-destructive"> (partial: {size.reason})</span> : null}
    </span>
  )
}

/** One project's group of the listing: its trees and its snapshot store. */
type ProjectGroup = EnsoTreesListing['projects'][number]

/** What a tree list needs beyond its group: the delete's fetch and the listing's names, and what follows a delete. */
interface TreeListContext {
  readonly fetchNow: FetchLike
  /** The stored listing: each tree's thread title and last activity, and the dialog's fork names. */
  readonly stored: readonly EnsoStoredThread[]
  /** The server deleted this thread: the listing is read again, and the page leaves it. */
  readonly onDeleted: (threadId: string) => void
}

/**
 * One project's trees, biggest first: each one's size, whether it holds work, and its Delete — the
 * thread menu's dialog (#879), with its holds-work refusal and Delete anyway (#571). Settings › Storage lists one
 * per project; a project page's Storage tab, its own (#871).
 */
function ProjectTreeList({
  group,
  title,
  context: { fetchNow, stored, onDeleted },
}: {
  group: ProjectGroup
  title: string
  context: TreeListContext
}): React.ReactNode {
  /** A refusal force cannot change, said on its tree's row; by thread id. */
  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({})
  if (group.trees.length === 0)
    return <p className="text-sm text-muted-foreground">No thread trees. A tree appears when a thread starts here.</p>
  return (
    // Named apart from the heading: the project's total there reads as a size too.
    <ul aria-label={`each tree of ${title}`} className="grid gap-2">
      {group.trees
        .toSorted(
          // For order only: an unreadable size sorts as 0, and is never shown as one.
          (first, second) =>
            (second.size.kind === 'unreadable' ? 0 : second.size.bytes) -
            (first.size.kind === 'unreadable' ? 0 : first.size.bytes),
        )
        .map((tree) => {
          const { threadId } = tree
          const row = threadId === null ? undefined : stored.find((known) => known.threadId === threadId)
          const name = treeName(threadId, row)
          return (
            <li key={tree.path} className="grid gap-0.5 rounded-md border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                <span className="text-muted-foreground">{tree.kind}</span>
                <span className="tabular-nums">{describeSize(tree.size)}</span>
                {threadId === null ? null : (
                  <DeleteThreadButton
                    target={{ threadId, fetch: fetchNow }}
                    label={`delete thread ${name}`}
                    stored={stored}
                    onDeleted={onDeleted}
                    onRefused={(reason): void => setRefused((all) => ({ ...all, [threadId]: reason }))}
                  />
                )}
              </div>
              <div className="flex gap-2 text-xs text-muted-foreground">
                {row === undefined ? null : <span>last active {new Date(row.lastActivityAt).toLocaleString()}</span>}
                {/* A tree no thread records has no store to compare it with: its work is unchecked, never "clean". */}
                <span className={tree.holdsWork === null ? undefined : 'text-destructive'}>
                  {threadId === null ? 'work not checked: no thread records it' : (tree.holdsWork ?? 'clean')}
                </span>
              </div>
              <span className="truncate text-xs text-muted-foreground" title={tree.path}>
                {tree.path}
              </span>
              {threadId !== null && refused[threadId] !== undefined ? (
                <p role="alert" className="text-xs text-destructive">
                  delete refused: {refused[threadId]}
                </p>
              ) : null}
            </li>
          )
        })}
    </ul>
  )
}

/** The listing as a section says it while it is out or when it failed; undefined once it is read. */
function TreesReadState({ read }: { read: TreesRead }): React.ReactNode {
  if (read.kind === 'loading') return <p className="text-sm text-muted-foreground">Measuring…</p>
  if (read.kind === 'failed')
    return (
      <p role="alert" className="text-sm text-destructive">
        {read.reason}
      </p>
    )
  return undefined
}

export function TreesSection({
  fetch: fetchImpl,
  projects,
  stored,
  onDeleted,
  onOpenProject,
}: {
  fetch?: FetchLike | undefined
  /** The page's project list, for each project's title. */
  projects: readonly EnsoProject[]
  /** The stored listing: each tree's thread title and last activity, and the dialog's fork names. */
  stored: readonly EnsoStoredThread[]
  /** The server deleted this thread: the page leaves it, as the header's Delete does. */
  onDeleted: (threadId: string) => void
  /** Open a project's page at its Storage tab (#871), from its group's heading. */
  onOpenProject: (projectId: string) => void
}): React.ReactNode {
  const { read, fetchNow, reload } = useTreesListing(fetchImpl)
  if (read.kind !== 'read') return <TreesReadState read={read} />
  // A delete reloads the listing — the tree is gone, and its project's snapshots may be smaller.
  const context: TreeListContext = {
    fetchNow,
    stored,
    onDeleted: (threadId: string): void => {
      reload()
      onDeleted(threadId)
    },
  }
  // A project with no tree is still listed when its snapshot store takes room (threads in the checkout snapshot too).
  if (read.listing.projects.length === 0) return <p className="text-sm text-muted-foreground">No thread trees.</p>
  return (
    <div className="grid gap-5">
      <StorageTotals listing={read.listing} />
      {read.listing.projects.map((group) => {
        const known = projects.find((project) => project.projectId === group.projectId)
        const title = known?.title ?? group.projectId
        return (
          <section key={group.projectId} aria-label={`trees of ${title}`} className="grid gap-2">
            <h3 className="flex flex-wrap items-baseline gap-x-2 font-heading text-sm font-semibold">
              {title}
              <span className="text-xs font-normal text-muted-foreground">
                <ProjectOnDisk listing={read.listing} projectId={group.projectId} />
              </span>
              {group.objectStore === null ? null : (
                <span className="text-xs font-normal text-muted-foreground">
                  snapshots {describeSize(group.objectStore)}
                </span>
              )}
              {/* A group whose project is no longer listed (removed since) has no page to open. */}
              {known === undefined ? null : (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="ml-auto"
                  aria-label={`open ${title}'s storage`}
                  onClick={() => onOpenProject(group.projectId)}
                >
                  Open project
                </Button>
              )}
            </h3>
            <ProjectTreeList group={group} title={title} context={context} />
          </section>
        )
      })}
    </div>
  )
}

/**
 * A project page's Storage tab (#871): this project's group of `GET /api/trees`, as Settings ›
 * Storage lists it, under the project's one total (`ProjectOnDisk`, the number its Projects card
 * says) and its snapshot store. A project the listing has no group for takes nothing on disk yet.
 */
export function ProjectStorage({
  fetch: fetchImpl,
  project,
  stored,
  onDeleted,
}: {
  fetch?: FetchLike | undefined
  project: EnsoProject
  stored: readonly EnsoStoredThread[]
  onDeleted: (threadId: string) => void
}): React.ReactNode {
  const { read, fetchNow, reload } = useTreesListing(fetchImpl)
  if (read.kind !== 'read') return <TreesReadState read={read} />
  const group = read.listing.projects.find((candidate) => candidate.projectId === project.projectId)
  if (group === undefined)
    return <p className="text-sm text-muted-foreground">No thread trees. A tree appears when a thread starts here.</p>
  const context: TreeListContext = {
    fetchNow,
    stored,
    onDeleted: (threadId: string): void => {
      reload()
      onDeleted(threadId)
    },
  }
  const count = group.trees.length
  return (
    <section aria-label={`trees of ${project.title}`} className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        <ProjectOnDisk listing={read.listing} projectId={project.projectId} />: {count} {count === 1 ? 'tree' : 'trees'}
        {group.objectStore === null
          ? null
          : `, and ${describeSize(group.objectStore)} in the snapshot store that file restore reads from`}
        .
      </p>
      <ProjectTreeList group={group} title={project.title} context={context} />
    </section>
  )
}

/**
 * A tree's row as the listing names it: no thread when none records it; else its thread's rail
 * title, or its short id when the thread has none — an empty first message is no title.
 */
function treeName(threadId: string | null, row: EnsoStoredThread | undefined): string {
  if (threadId === null) return 'no thread records this tree'
  const title = row?.title?.trim() ?? ''
  return title === '' ? threadId.slice(0, 8) : title
}

/** One total of the row: its value, what it counts, and, for a partial sum, how much of it was read. */
function Total({ label, value, short }: { label: string; value: string; short?: string | undefined }): React.ReactNode {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="order-first font-heading text-xl font-semibold whitespace-nowrap tabular-nums">{value}</dd>
      {short === undefined ? null : <dd className="text-xs text-destructive">{short}</dd>}
    </div>
  )
}

/** A summed size as a total says it: exact when every part was measured, else "at least", with why. */
function SizeTotal({ label, size }: { label: string; size: SizeSum }): React.ReactNode {
  return size.kind === 'measured' ? (
    <Total label={label} value={formatBytes(size.bytes)} />
  ) : (
    <Total label={label} value={`at least ${formatBytes(size.bytes)}`} short={`partial: ${size.reason}`} />
  )
}

/**
 * The totals across every project (#874), summed from the same listing the groups below show: the
 * trees, what they take, and what the projects' snapshot stores take. A sum with a part not fully
 * read is a partial, never exact.
 */
function StorageTotals({ listing }: { listing: EnsoTreesListing }): React.ReactNode {
  const trees = listing.projects.flatMap((project) => project.trees)
  const stores = listing.projects.flatMap((project) => (project.objectStore === null ? [] : [project.objectStore]))
  return (
    <dl aria-label="storage totals" className="grid gap-3 sm:grid-cols-3">
      <Total label={trees.length === 1 ? 'tree' : 'trees'} value={String(trees.length)} />
      <SizeTotal label="in trees" size={totalOf(trees.map((tree) => tree.size))} />
      <SizeTotal label="in snapshot stores" size={totalOf(stores)} />
    </dl>
  )
}
