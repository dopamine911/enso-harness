import { type EnsoProject, type EnsoStoredThread, EnsoTreesListing } from '@enso/core'
import { useEffect, useState } from 'react'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { DeleteThread } from './delete-thread-dialog.tsx'
import { describeSize } from './disk-usage.ts'
import { describeFailedResponse } from './stored-threads.ts'

/**
 * Settings' Trees (#578): what thread trees cost on disk, per project — each tree's size, whether
 * it holds work, and its project's snapshot store — so a person can see what to delete and delete
 * it here, through the same dialog as the header's. Read when the tab mounts and after each delete;
 * the server walks the disk for it, so nothing polls. A size the server could not read is said as
 * such, never as 0.
 */

type TreesRead =
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
  const fetchNow = fetchImpl ?? pageFetch
  const [read, setRead] = useState<TreesRead>({ kind: 'loading' })
  const [generation, setGeneration] = useState(0)
  /** A refusal force cannot change, said on its tree's row; by thread id. */
  const [refused, setRefused] = useState<Readonly<Record<string, string>>>({})
  useEffect(() => {
    let current = true
    void readTrees(fetchNow).then((next) => {
      if (current) setRead(next)
    })
    return (): void => {
      current = false
    }
  }, [fetchNow, generation])
  // A delete reloads the listing — the tree is gone, and its project's snapshots may be smaller.
  const deleted = (threadId: string): void => {
    setGeneration((count) => count + 1)
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
      {read.listing.projects.map((project) => {
        const title = projects.find((known) => known.projectId === project.projectId)?.title ?? project.projectId
        return (
          <section key={project.projectId} aria-label={`trees of ${title}`}>
            <h3 className="flex items-baseline gap-2 font-heading text-sm font-semibold">
              {title}
              {project.objectStore === null ? null : (
                <span className="text-xs font-normal text-muted-foreground">
                  snapshots {describeSize(project.objectStore)}
                </span>
              )}
            </h3>
            {project.trees.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No thread trees.</p> : null}
            <ul className="mt-2 grid gap-2">
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
