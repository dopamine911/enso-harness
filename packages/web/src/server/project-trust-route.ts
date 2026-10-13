import { ensoLogger, type EnsoProjectTrust } from '@enso/core'
import { readProjectTierFiles } from '@enso/core/project-config'
import { projectTrusted, saveProjectTrust } from '../host/project-trust.ts'
import type { ProjectRegistry } from './projects.ts'

/**
 * `GET` and `PUT /api/projects/<projectId>/trust` (#873): a project's trust, read and set from its
 * page — pi's `trust.json`, the store a thread's "Trust project" answer writes and every new
 * session reads (`hostedProjectTrust`), with the agent dir they read it from. With it, the files
 * trust turns on and the setup commands they declare, for the confirmation to name.
 *
 * ⚠ ONLY A REGISTERED PROJECT, BY ITS ID: the route never takes a path, so it can trust no folder
 * the person has not added. An allowed interpreter command reaches it as it reaches every route
 * (the page's guard, #717, stops other pages only); it gains nothing, since such a command can
 * write `trust.json` itself.
 *
 * ⚠ A GRANT REACHES THE NEXT BUILD: a session reads trust when it is built, so an open one picks a
 * grant up when it is next built. A REVOKE FAILS CLOSED AT ONCE: `project-routes.ts` refuses it
 * while one of the project's threads runs, and retires the others, as removal does.
 */

const log = ensoLogger('server', 'http')

interface ProjectTrustRouteDeps {
  readonly projects: Pick<ProjectRegistry, 'get'>
  /** pi's agent directory, whose `trust.json` is the store every session reads. */
  readonly agentDir: string
}

/** The route's answer: the project's trust, or 404 for an id this server has not registered. */
export type ProjectTrustRouteAnswer =
  | { readonly kind: 'trust'; readonly trust: EnsoProjectTrust }
  | { readonly kind: 'refused'; readonly status: 404; readonly reason: string }

export function createProjectTrustRoute(deps: ProjectTrustRouteDeps): {
  read(projectId: string): ProjectTrustRouteAnswer
  write(projectId: string, trusted: boolean): ProjectTrustRouteAnswer
} {
  function answer(projectId: string, change?: boolean): ProjectTrustRouteAnswer {
    const project = deps.projects.get(projectId)
    if (project === undefined) {
      return { kind: 'refused', status: 404, reason: `no registered project has the id ${projectId}` }
    }
    if (change !== undefined) saveProjectTrust(project.path, deps.agentDir, change)
    return {
      kind: 'trust',
      trust: {
        projectId,
        path: project.path,
        trusted: projectTrusted(project.path, deps.agentDir),
        files: readProjectTierFiles(project.path),
      },
    }
  }
  return {
    read: (projectId) => answer(projectId),
    write(projectId, trusted) {
      const answered = answer(projectId, trusted)
      if (answered.kind === 'trust') {
        log.info('project {projectId}: {decision} from its page; new threads and trees follow it', {
          projectId,
          path: answered.trust.path,
          decision: trusted ? 'trusted' : 'trust revoked',
        })
      } else log.warn('project {projectId}: trust not changed: {reason}', { projectId, reason: answered.reason })
      return answered
    },
  }
}
