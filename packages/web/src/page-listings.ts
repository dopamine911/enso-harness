import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { useEffect } from 'react'
import type { ListingState } from './listing-store.ts'
import { isFixtureMode } from './page-mode.ts'
import { createProjectsStore, projectOf } from './project-list.ts'
import { useStore } from './store.ts'
import { createStoredThreadsStore } from './stored-threads.ts'
import { type ThreadSummary, threadListStore } from './thread-stores.ts'

/**
 * The page's listings (#95, #395): the server's stored sessions and its projects, one store each per
 * page, and the hook that fetches them.
 */

/**
 * The stored sessions the rail can come back to (#95). Page-level, refreshed on load and
 * whenever a run settles — the moments a session file appears or grows.
 */
export const storedThreads = createStoredThreadsStore()

/** The projects the rail groups threads under (#395). Page-level, fetched on load. */
export const projectList = createProjectsStore()

/** The project a thread runs in, as the page lists it — a thread with none is the launch directory's. */
export function useThreadProject(projectId: string | undefined): EnsoProject | undefined {
  return projectOf(useStore(projectList).rows, projectId)
}

/** The page's three listings: its own threads, the server's stored sessions, and the projects. */
export interface PageListings {
  readonly threads: readonly ThreadSummary[]
  readonly stored: ListingState<EnsoStoredThread>
  readonly projects: ListingState<EnsoProject>
}

/** The page's listings, fetched on load; the stored sessions again each time the page's runs settle. */
export function usePageListings(): PageListings {
  const threads = useStore(threadListStore)
  const stored = useStore(storedThreads)
  const projects = useStore(projectList)
  const anyBusy = threads.some((thread) => thread.busy)
  useEffect(() => {
    // Load, and every time the page goes from a run in flight to none: something settled.
    if (!(anyBusy || isFixtureMode)) void storedThreads.refresh()
  }, [anyBusy])
  useEffect(() => {
    if (!isFixtureMode) void projectList.refresh()
  }, [])
  return { threads, stored, projects }
}
