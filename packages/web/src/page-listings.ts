import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { useEffect, useMemo } from 'react'
import type { ListingState } from './listing-store.ts'
import { recentModelIds } from './model-picker.tsx'
import { modelsSettings } from './models-settings.ts'
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

/** The models of the latest threads, most recent first, each once (#880): the model picker's Recent group, from the stored sessions. */
export function useRecentModels(): readonly string[] {
  const { rows } = useStore(storedThreads)
  return useMemo(() => recentModelIds(rows), [rows])
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
    if (isFixtureMode) return
    void projectList.refresh()
    // The models section (#904): the picker, the launch panel and Settings read it.
    void modelsSettings.refresh()
  }, [])
  return { threads, stored, projects }
}
