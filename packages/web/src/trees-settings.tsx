import { type EnsoProject, type EnsoStoredThread, EnsoTreesListing } from '@enso/core'
import { useEffect, useState } from 'react'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { DeleteThread } from './delete-thread-dialog.tsx'
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

export function TreesSection({
  fetch: fetchImpl,
  projects,
  stored,
  onDeleted,
}: {
  fetch?: FetchLike | undefined
  /** The page's project list, for each project's title. */
  projects: readonly EnsoProject[]
  /** The stored listing: each tree's thread title and last activity, and the dialog's fork names. */
  stored: readonly EnsoStoredThread[]
  /** The server deleted this thread: the page leaves it, as the header's Delete does. */
  onDeleted: (threadId: string) => void
}): React.ReactNode {
  const { read, fetchNow, reload } = useTreesListing(fetchImpl)
  /** A refusal force cannot change, said on its tree's row; by thread id. */
  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({})
  // A delete reloads the listing — the tree is gone, and its project's snapshots may be smaller.
  const deleted = (threadId: string): void => {
    reload()
    onDeleted(threadId)
  }

  if (read.kind === 'loading') return <p className="text-sm text-muted-foreground">Measuring…</p>
  if (read.kind === 'failed')
    return (
      <p role="alert" className="text-sm text-destructive">
        {read.reason}
      </p>
    )
  // A project with no tree is still listed when its snapshot store takes room (threads in the checkout snapshot too).
  if (read.listing.projects.length === 0) return <p className="text-sm text-muted-foreground">No thread trees.</p>
  return (
    <div className="grid gap-5">
      <StorageTotals listing={read.listing} />
      {read.listing.projects.map((project) => {
        const title = projects.find((known) => known.projectId === project.projectId)?.title ?? project.projectId
        return (
          <section key={project.projectId} aria-label={`trees of ${title}`}>
            <h3 className="flex flex-wrap items-baseline gap-x-2 font-heading text-sm font-semibold">
              {title}
              <span className="text-xs font-normal text-muted-foreground">
                <ProjectOnDisk listing={read.listing} projectId={project.projectId} />
              </span>
              {project.objectStore === null ? null : (
                <span className="text-xs font-normal text-muted-foreground">
                  snapshots {describeSize(project.objectStore)}
                </span>
              )}
            </h3>
            {project.trees.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No thread trees.</p> : null}
            {/* Named apart from the heading: the project's total there reads as a size too. */}
            <ul aria-label={`each tree of ${title}`} className="mt-2 grid gap-2">
              {project.trees
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
                          <DeleteThread
                            target={{ threadId, fetch: fetchNow }}
                            label={`delete thread ${name}`}
                            stored={stored}
                            onDeleted={deleted}
                            onRefused={(reason): void => setRefused((all) => ({ ...all, [threadId]: reason }))}
                          />
                        )}
                      </div>
                      <div className="flex gap-2 text-xs text-muted-foreground">
                        {row === undefined ? null : (
                          <span>last active {new Date(row.lastActivityAt).toLocaleString()}</span>
                        )}
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
          </section>
        )
      })}
    </div>
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
