import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import {
  type EnsoProject,
  type EnsoProjectRegistration,
  EnsoProjectsState,
  ensoLogger,
  isEnsoProjectId,
} from '@enso/core'
import { realpathOrSelf } from '@enso/core/paths'
import { Compile } from 'typebox/compile'

/**
 * The projects one server runs threads in (#395).
 *
 * ⚠ THE BLAST RADIUS IS STILL CHOSEN OUTSIDE THE BROWSER. With no sandbox (#24) a session's
 * directory is what it can reach, so the directories that can be projects are the launch
 * directory and directories STRICTLY UNDER a root the install declares (`projects.roots` in
 * `enso.config.json`). A page registers one by path — the only request that carries a path —
 * and every request after names it by id. The path is resolved (`realpath`) BEFORE it is
 * checked, so a symlink under a root cannot lead out of it, and no segment below the root may be
 * hidden (`.ssh`, `.config`, `.enso` — dot-directories hold credentials and config, not projects).
 *
 * A project's id is derived from its canonical path: the same directory is always the same
 * project, across restarts, with nothing stored to keep it so. Registrations are server state in
 * `.enso/projects.json`; removing one forgets only the registration — its sessions stay on disk
 * and are served again when the directory is registered again.
 *
 * A NEW thread's project is the one a page named for it (`X-Enso-Project`, `claim`), else the
 * launch project — today's behaviour. Once the thread has a session, the session's own directory
 * decides (pi records it in the session header), whatever a page says afterwards.
 */

const log = ensoLogger('server', 'projects')

const storedProjectsValidator = Compile(EnsoProjectsState)
/** One registration as `.enso/projects.json` stores it. */
type Registration = EnsoProjectsState['projects'][number]

export interface ProjectRegistryOptions {
  /** The directory the server was launched in: the first project, never removable. */
  readonly launchDirectory: string
  /** `projects.roots` from `enso.config.json`, as written: absolute or `~/`. */
  readonly roots: readonly string[]
  /** `.enso/projects.json` (`ensoProjectsPath`); absent, registrations live in memory only (tests). */
  readonly statePath?: string
  /** Where `~/` points; the running user's home unless a test says otherwise. */
  readonly homeDirectory?: string
}

export type ProjectRegistrationOutcome =
  | { readonly kind: 'registered' | 'existing'; readonly project: EnsoProject }
  | { readonly kind: 'refused'; readonly reason: string }

export type ProjectRemovalOutcome = 'removed' | 'unknown' | 'launch'

/** A new thread cannot be built where its project says: the directory is gone. */
export class ProjectUnavailable extends Error {
  override readonly name = 'ProjectUnavailable'
}

export interface ProjectRegistry {
  /** The launch project first, then the registered ones in the order they were registered. */
  list(): EnsoProject[]
  get(projectId: string): EnsoProject | undefined
  /** The project whose directory this is, by canonical path; `undefined` for a directory that is no project. */
  byDirectory(directory: string): EnsoProject | undefined
  register(request: EnsoProjectRegistration): ProjectRegistrationOutcome
  remove(projectId: string): ProjectRemovalOutcome
  /**
   * A page names the project of a thread (`X-Enso-Project`). The first name a thread gets is
   * kept; it matters only until the thread has a session. `undefined` when accepted (or when
   * there is no header), else why not — an id that is no registered project.
   */
  claim(threadId: string, projectId: string | undefined): string | undefined
  /** The project a thread with no session yet belongs to: its claim's, else the launch one; `undefined` when the claimed one is gone. */
  projectOfNewThread(threadId: string): EnsoProject | undefined
  /** Where a thread with no session yet is built — `projectOfNewThread`'s directory; throws `ProjectUnavailable` when there is none. */
  directoryForNewThread(threadId: string): string
}

/** The id of a canonical directory: its path, hashed. Sixteen hex digits (`isEnsoProjectId`). */
function projectIdOf(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

function readRegistrations(statePath: string): Registration[] {
  if (!existsSync(statePath)) return []
  const text = readFileSync(statePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`enso-server: ${statePath} is not valid JSON (${String(error)}) — fix it or delete it`)
  }
  if (!storedProjectsValidator.Check(parsed)) {
    throw new Error(
      `enso-server: ${statePath} does not match { "projects": [{ "path", "title"? }] } — fix it or delete it`,
    )
  }
  return parsed.projects
}

/** Written whole to a sibling and renamed over, so a crash mid-write never leaves half a file. */
function writeRegistrations(statePath: string, registrations: readonly Registration[]): void {
  mkdirSync(dirname(statePath), { recursive: true })
  const staging = `${statePath}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify({ projects: registrations }, null, 2)}\n`)
  renameSync(staging, statePath)
}

/**
 * Why a canonical directory may not be registered under these roots, or `undefined` when it may.
 * Strictly under one root, and no segment below that root hidden.
 */
function refusalUnderRoots(
  canonical: string,
  roots: readonly string[],
  declared: readonly string[],
): string | undefined {
  if (roots.length === 0) {
    return 'no project roots are declared — add `"projects": { "roots": ["~/code"] }` to enso.config.json'
  }
  for (const root of roots) {
    const below = relative(root, canonical)
    if (below === '') return `${canonical} is a project root itself; register a directory under it`
    if (below.startsWith('..') || isAbsolute(below)) continue
    const hidden = below.split(/[\\/]/).find((segment) => segment.startsWith('.'))
    if (hidden !== undefined) return `${canonical} is inside a hidden directory (${hidden}), which cannot be a project`
    return undefined
  }
  return `${canonical} is not under a declared project root (${declared.join(', ')})`
}

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  const home = options.homeDirectory ?? homedir()
  const roots = options.roots.map((root) => realpathOrSelf(expandHome(root, home)))
  const launchPath = realpathOrSelf(options.launchDirectory)
  const launch = { projectId: projectIdOf(launchPath), path: launchPath, title: basename(launchPath) || launchPath }
  // ⚠ The roots are applied to what the state file holds on every read, not once: a root taken out
  // of the config takes its projects with it. The file keeps them, so putting the root back
  // restores them — which is why `stored` is written back whole and only `served()` is filtered.
  let stored: Registration[] = options.statePath === undefined ? [] : readRegistrations(options.statePath)
  for (const registration of stored) {
    const refusal = refusalUnderRoots(registration.path, roots, options.roots)
    if (refusal !== undefined) log.warn('registered project not served: {reason}', { reason: refusal })
  }

  function served(): Registration[] {
    return stored.filter(
      (registration) =>
        registration.path !== launch.path && refusalUnderRoots(registration.path, roots, options.roots) === undefined,
    )
  }

  function persist(next: Registration[]): void {
    if (options.statePath !== undefined) writeRegistrations(options.statePath, next)
    stored = next
  }
  const claims = new Map<string, string>()

  function viewOf(path: string, title: string | undefined, isLaunch: boolean): EnsoProject {
    return {
      projectId: projectIdOf(path),
      title: title ?? (basename(path) || path),
      path,
      status: isDirectory(path) ? 'ok' : 'missing-dir',
      launch: isLaunch,
    }
  }

  function list(): EnsoProject[] {
    return [
      viewOf(launch.path, launch.title, true),
      ...served().map((registration) => viewOf(registration.path, registration.title, false)),
    ]
  }

  function get(projectId: string): EnsoProject | undefined {
    if (!isEnsoProjectId(projectId)) return undefined
    return list().find((project) => project.projectId === projectId)
  }

  function byDirectory(directory: string): EnsoProject | undefined {
    const canonical = realpathOrSelf(directory)
    if (canonical === launch.path) return viewOf(launch.path, launch.title, true)
    const registration = served().find((candidate) => candidate.path === canonical)
    return registration === undefined ? undefined : viewOf(registration.path, registration.title, false)
  }

  function register(request: EnsoProjectRegistration): ProjectRegistrationOutcome {
    if (!isAbsolute(request.path)) return { kind: 'refused', reason: `${request.path} is not an absolute path` }
    let canonical: string
    try {
      canonical = realpathSync(request.path)
    } catch {
      return { kind: 'refused', reason: `${request.path} does not exist` }
    }
    if (!isDirectory(canonical)) return { kind: 'refused', reason: `${canonical} is not a directory` }
    if (canonical === launch.path) return { kind: 'existing', project: viewOf(launch.path, launch.title, true) }
    const refusal = refusalUnderRoots(canonical, roots, options.roots)
    if (refusal !== undefined) return { kind: 'refused', reason: refusal }
    const existing = served().find((registration) => registration.path === canonical)
    if (existing !== undefined) return { kind: 'existing', project: viewOf(existing.path, existing.title, false) }
    const added: Registration =
      request.title === undefined ? { path: canonical } : { path: canonical, title: request.title }
    persist([...stored.filter((registration) => registration.path !== canonical), added])
    log.info('project registered: {path}', { path: canonical, projectId: projectIdOf(canonical) })
    return { kind: 'registered', project: viewOf(canonical, request.title, false) }
  }

  function remove(projectId: string): ProjectRemovalOutcome {
    if (projectId === launch.projectId) return 'launch'
    if (!served().some((registration) => projectIdOf(registration.path) === projectId)) return 'unknown'
    persist(stored.filter((registration) => projectIdOf(registration.path) !== projectId))
    log.info('project removed: {projectId}', { projectId })
    return 'removed'
  }

  function claim(threadId: string, projectId: string | undefined): string | undefined {
    if (projectId === undefined) return undefined
    if (get(projectId) === undefined) return `no registered project has the id ${projectId}`
    if (!claims.has(threadId)) claims.set(threadId, projectId)
    return undefined
  }

  function projectOfNewThread(threadId: string): EnsoProject | undefined {
    const claimed = claims.get(threadId)
    return claimed === undefined ? viewOf(launch.path, launch.title, true) : get(claimed)
  }

  function directoryForNewThread(threadId: string): string {
    const project = projectOfNewThread(threadId)
    if (project === undefined) throw new ProjectUnavailable(`thread ${threadId}: its project is no longer registered`)
    if (project.status === 'missing-dir') {
      throw new ProjectUnavailable(`thread ${threadId}: the project directory ${project.path} no longer exists`)
    }
    return project.path
  }

  return { list, get, byDirectory, register, remove, claim, projectOfNewThread, directoryForNewThread }
}
