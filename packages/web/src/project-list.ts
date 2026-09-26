import { EnsoProject } from '@enso/core'
import { createListingStore, type ListingStore } from './listing-store.ts'
import { describeFailedResponse } from './stored-threads.ts'

/**
 * The projects the rail groups threads under (#395): the launch directory first, then the ones
 * registered under the install's roots, as `GET /api/projects` lists them. Refreshed on load
 * (`listing-store.ts` has the rules). A page names a project by its id, never by its path.
 */
export type ProjectsStore = ListingStore<EnsoProject>

export function createProjectsStore(fetchProjects: () => Promise<unknown> = fetchProjectList): ProjectsStore {
  return createListingStore(EnsoProject, 'project listing', fetchProjects)
}

async function fetchProjectList(): Promise<unknown> {
  const response = await fetch('/api/projects')
  if (!response.ok) throw new Error(await describeFailedResponse(response))
  return response.json()
}
