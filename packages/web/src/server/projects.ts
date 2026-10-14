import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, sep as pathSeparator, relative, resolve } from 'node:path'
import {
  type EnsoDirectoryEntry,
  type EnsoDirectoryListing,
  type EnsoProject,
  type EnsoProjectRegistration,
  EnsoProjectsState,
  ensoLogger,
  isEnsoProjectId,
} from '@enso/core'
import { projectIdOf, realpathOrSelf, treeProjectId } from '@enso/core/paths'
import { Compile } from 'typebox/compile'

/**
 * The projects one server runs threads in (#395, #866).
 *
 * ⚠ THE PERSON CHOOSES THE BLAST RADIUS, IN THE PAGE, WITH THE STAKES SAID (#866). With no sandbox
 * (#24, #397) a session's directory is what it can reach. A page registers a project by path — the
 * only request that carries a path — and every request after names it by id. Only Enso's own page
 * can make that request: the server refuses every browser that is not (#717, `index.ts`
 * `fromTrustedOrigin`), and the page asks the person to confirm what an agent there can reach.
 * #395 kept the choice outside the browser because any page reaching the origin could have made it;
 * #717 closed that, and #866 moved the choice back to the person. An allowed command on the machine
 * can reach this route too, as it can every route, and gains nothing it did not already have (#866).
 *
 * What can never be a project, whatever is declared (`standingRefusal`): the home folder, or any
 * folder holding it (`/` among them); and Enso's own home (`ENSO_HOME`) and anything under it. The
 * path is resolved (`realpath`) BEFORE it is checked, so a symlink cannot lead anywhere the check did
 * not see.
 *
 * A directory with a hidden segment (`.ssh`, `.config`) is refused while CHOOSING unless the page
 * asks to see hidden folders (#866: the person's toggle). It guards against a misclick, not an
 * agent: with no sandbox, an agent in any project can already read `~/.ssh`. So it is not applied
 * when SERVING — a stored hidden project got there by that opt-in.
 *
 * Roots are OPTIONAL. Declared (`projects.roots` in `ENSO_HOME/config.json`), they fence: a project
 * must be STRICTLY UNDER one, as #395 had it. None declared, the page browses from the home folder and
 * may name any other folder by path.
 *
 * A project's id is derived from its canonical path: the same directory is always the same
 * project, across restarts, with nothing stored to keep it so. Registrations are server state in
 * `.enso/projects.json`; removing one forgets only the registration — its sessions stay on disk
 * and are served again when the directory is registered again.
 *
 * A NEW thread's project is the one a page named for it (`X-Enso-Project`, `claim`), else the
 * launch project — today's behaviour. A thread is named once: a later request naming ANOTHER
 * project before the thread is built is refused (409), never quietly dropped.
 * Once the thread has a session, the session's own directory decides (pi records it in the
 * session header), whatever a page says afterwards.
 */

const log = ensoLogger('server', 'projects')

const storedProjectsValidator = Compile(EnsoProjectsState)
/** One registration as `.enso/projects.json` stores it. */
type Registration = EnsoProjectsState['projects'][number]

export interface ProjectRegistryOptions {
  /** The directory the server was launched in: the first project, never removable. */
  readonly launchDirectory: string
  /**
   * `projects.roots` from the user's config (`ENSO_HOME/config.json`), as written: absolute or `~/`.
   * Optional (#866): declared, a project must be under one; none, any folder the standing refusals allow.
   */
  readonly roots: readonly string[]
  /**
   * The config file those roots were read from — named in every message that says to edit it, so
   * the fix lands in the file actually read (a scratch `ENSO_HOME` is not `~/.enso`). Absent (tests):
   * `ENSO_HOME/config.json`.
   */
  readonly configPath?: string
  /** `ENSO_HOME/projects.json` (`ensoProjectsPath`); absent, registrations live in memory only (tests). */
  readonly statePath?: string
  /** Where `~/` points, and the folder no project may be or hold; the running user's home unless a test says otherwise. */
  readonly homeDirectory?: string
  /** Enso's own home (`ENSO_HOME`, #421): never a project, nor anything under it (#866). Absent (tests): no such refusal. */
  readonly ensoHome?: string
  /**
   * The project folders (`ENSO_HOME/projects`, #552): a directory under `<id>/trees/` is a thread's
   * own tree (#551) and resolves to project `<id>`. Absent, no directory is a tree (tests).
   */
  readonly projectsDir?: string
}

export type ProjectRegistrationOutcome =
  | { readonly kind: 'registered' | 'existing'; readonly project: EnsoProject }
  | { readonly kind: 'refused'; readonly reason: string }

export type ProjectRemovalOutcome = 'removed' | 'unknown' | 'launch'

export type ProjectRetitleOutcome =
  | { readonly kind: 'retitled'; readonly project: EnsoProject }
  | { readonly kind: 'unknown' }

export type ProjectBrowseOutcome =
  | { readonly kind: 'listing'; readonly listing: EnsoDirectoryListing }
  | { readonly kind: 'refused'; readonly reason: string }

/** The most directories one listing holds — the first by name; `truncated` says there were more. */
const MAX_BROWSED_DIRECTORIES = 500

/** Why a request's project name is refused: 400 for an id that is no project, 409 for a thread already named otherwise. */
export interface ProjectClaimRefusal {
  readonly status: 400 | 409
  readonly reason: string
}

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
  /** `hidden` (#866): the person asked to see hidden folders, so one inside a hidden directory may be registered. */
  register(request: EnsoProjectRegistration): ProjectRegistrationOutcome
  /**
   * What a page may browse while adding a project: where browsing starts (no `path`) — the declared
   * roots, else the home folder — or one directory and the directories under it, each resolved and
   * checked as a registration is. Hidden directories are left out unless `hidden` (#866).
   */
  browse(path: string | undefined, hidden: boolean): ProjectBrowseOutcome
  remove(projectId: string): ProjectRemovalOutcome
  /**
   * Name a served project `title` (#939), stored in `projects.json`: the folder keeps its name and
   * its path, and the id stays the path's. `unknown` for an id no served project has.
   */
  retitle(projectId: string, title: string): ProjectRetitleOutcome
  /**
   * A page names the project of a thread (`X-Enso-Project`). The first name a thread gets is
   * kept; it matters only until the thread has a session. `undefined` when accepted (or when
   * there is no header, or the same name again — registered still or not, #897), else why not: an
   * id that is no registered project, or a thread already named for a different one.
   */
  claim(threadId: string, projectId: string | undefined): ProjectClaimRefusal | undefined
  /** The thread has a session: its directory is fixed, and its claim is dead weight — forget it. */
  dropClaim(threadId: string): void
  /**
   * The project a page named a thread with no session yet for (#897) — registered still or not:
   * a page that reloads it reads the name here, and says the project is gone rather than taking
   * the launch one. `undefined` when no page has named one.
   */
  claimOf(threadId: string): string | undefined
  /** The project a thread with no session yet belongs to: its claim's, else the launch one; `undefined` when the claimed one is gone. */
  projectOfNewThread(threadId: string): EnsoProject | undefined
  /** Where a thread with no session yet is built — `projectOfNewThread`'s directory; throws `ProjectUnavailable` when there is none. */
  directoryForNewThread(threadId: string): string
}

/**
 * An absolute path resolved to the directory it is, or the refusal a registration or a browse gives,
 * naming the folder as the person wrote it (`asked`, `~/` kept) — the canonical form may not exist.
 */
function canonicalDirectory(
  path: string,
  asked: string,
): string | { readonly kind: 'refused'; readonly reason: string } {
  if (!isAbsolute(path)) return { kind: 'refused', reason: 'Use a full path, such as ~/repo/my-project.' }
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    return { kind: 'refused', reason: `There’s no folder at ${asked}.` }
  }
  return isDirectory(canonical)
    ? canonical
    : { kind: 'refused', reason: `There’s no folder at ${asked}: it is a file, not a folder.` }
}

/** A listing of `path` (`null`: where browsing starts — no folder, so nothing to add) that `refusal` says why it may not be added, if it may not. */
function listingOf(
  path: string | null,
  parent: string | null,
  refusal: string | undefined,
  directories: readonly EnsoDirectoryEntry[],
): EnsoDirectoryListing {
  return {
    path,
    parent,
    registrable: path !== null && refusal === undefined,
    ...(refusal === undefined ? {} : { refusal }),
    directories: directories.slice(0, MAX_BROWSED_DIRECTORIES),
    truncated: directories.length > MAX_BROWSED_DIRECTORIES,
  }
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

/**
 * A project path as the user's config writes it — absolute or `~/`, maybe with a trailing slash or
 * through a symlink — as the canonical path a project is known by (#551 `threads.projects`, PR #561
 * review): the form `projects.roots` accepts, resolved the way a registered project is.
 */
export function canonicalConfigPath(path: string, home: string = homedir()): string {
  return realpathOrSelf(resolve(expandHome(path, home)))
}

function readRegistrations(statePath: string): Registration[] {
  if (!existsSync(statePath)) return []
  const text = readFileSync(statePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`enso-server: ${statePath} is not valid JSON (${String(error)}) — fix it or delete it`, {
      cause: error,
    })
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

/** Whether `candidate` is `parent` itself or lies under it. A directory merely NAMED `..foo` lies under it. */
function isWithin(parent: string, candidate: string): boolean {
  const below = relative(parent, candidate)
  return !(below === '..' || below.startsWith(`..${pathSeparator}`) || isAbsolute(below))
}

/** The first hidden segment of `path`'s segments, or `undefined` when none is hidden. */
function hiddenSegmentOf(path: string): string | undefined {
  return path.split(pathSeparator).find((segment) => segment.startsWith('.'))
}

/**
 * Why a canonical directory can never be a project, whatever roots are declared (#866), or
 * `undefined`: the home folder or one holding it (an agent there reaches every file the person
 * has), and Enso's own home or anything under it (its logs, sessions and credentials). Said with
 * the reason, as the Add project page shows it (#872).
 */
function standingRefusal(canonical: string, home: string, ensoHome: string | undefined): string | undefined {
  if (canonical === home) {
    return 'That’s your home folder. An agent there could reach everything you own, so Enso won’t add it. Pick a project folder inside it.'
  }
  if (isWithin(canonical, home)) {
    return 'That folder holds your home folder, so Enso won’t add it. Pick a project folder inside your home folder.'
  }
  if (ensoHome !== undefined && isWithin(ensoHome, canonical)) {
    const where = canonical === ensoHome ? 'That’s Enso’s own folder' : 'That folder is inside Enso’s own folder'
    return `${where} (ENSO_HOME), where it keeps settings, threads and credentials. It can’t be a project.`
  }
  return undefined
}

/**
 * Why a canonical directory may not be registered under these declared roots, or `undefined` when
 * it may. Strictly under one root, and — unless `hidden` is allowed — no segment below that root hidden.
 *
 * ⚠ ANY root that accepts it is enough, whatever the order: roots may nest
 * (`~/code` and `~/code/sub`), and `~/code/sub` itself is under the first even though it is the
 * second. So a root's refusal is kept only as the reason to give if no other root accepts.
 */
function refusalUnderRoots(
  canonical: string,
  roots: readonly string[],
  declared: readonly string[],
  hidden: boolean,
): string | undefined {
  let refusal: string | undefined
  for (const root of roots) {
    if (!isWithin(root, canonical)) continue
    const below = relative(root, canonical)
    const hiddenSegment = hidden ? undefined : hiddenSegmentOf(below)
    if (below === '')
      refusal ??= 'That folder is a project root itself (projects.roots). Pick a project folder inside it.'
    else if (hiddenSegment !== undefined) refusal ??= hiddenRefusal(hiddenSegment)
    else return undefined
  }
  return (
    refusal ??
    `That folder is outside your declared project roots (${declared.join(', ')}), so Enso won’t add it. Pick a folder inside one of them.`
  )
}

function hiddenRefusal(segment: string): string {
  return `That folder is inside a hidden folder (${segment}), where tools keep their settings and keys. Tick “show hidden folders” to add it anyway.`
}

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  const home = realpathOrSelf(options.homeDirectory ?? homedir())
  const ensoHome = options.ensoHome === undefined ? undefined : realpathOrSelf(options.ensoHome)
  const configPath = options.configPath ?? 'ENSO_HOME/config.json'
  // ⚠ A relative root would resolve against this PROCESS's cwd, not the launch directory (PR #399
  // review) — a boundary nobody wrote down. Refused here, failing the launch, as an unreadable
  // config does: the documented form is absolute or `~/`.
  const roots = options.roots.map((root) => {
    const expanded = expandHome(root, home)
    if (!isAbsolute(expanded)) {
      throw new Error(`enso-server: projects.roots entry ${root} is not an absolute or ~/ path — fix ${configPath}`)
    }
    return realpathOrSelf(expanded)
  })
  // With no roots declared, browsing starts at the home folder (#866): the one place a page lists from.
  const browseRoots = roots.length > 0 ? roots : [home]
  const launchPath = realpathOrSelf(options.launchDirectory)
  const launch = { projectId: projectIdOf(launchPath), path: launchPath }
  // ⚠ The rule is applied to what the state file holds on every read, not once: a root taken out
  // of the config takes its projects with it. The file keeps them, so putting the root back
  // restores them — which is why `stored` is written back whole and only `served()` is filtered.
  let stored: Registration[] = options.statePath === undefined ? [] : readRegistrations(options.statePath)
  for (const registration of stored) {
    const refusal = refusalOf(registration.path, true)
    if (refusal !== undefined) {
      log.warn('registered project not served: {path}: {reason}', { path: registration.path, reason: refusal })
    }
  }

  /**
   * Why `canonical` may not be a project here (#866): a standing refusal first, then the roots' fence
   * when any are declared, else — unless `hidden` is allowed — a hidden segment anywhere in it.
   */
  function refusalOf(canonical: string, hidden: boolean): string | undefined {
    const standing = standingRefusal(canonical, home, ensoHome)
    if (standing !== undefined) return standing
    if (roots.length > 0) return refusalUnderRoots(canonical, roots, options.roots, hidden)
    const hiddenSegment = hidden ? undefined : hiddenSegmentOf(canonical)
    return hiddenSegment === undefined ? undefined : hiddenRefusal(hiddenSegment)
  }

  function served(): Registration[] {
    return stored.filter(
      (registration) => registration.path !== launch.path && refusalOf(registration.path, true) === undefined,
    )
  }

  /**
   * The launch project, named by its folder unless renamed (#939). A rename is stored as an entry
   * for the launch path, which `served()` leaves out while the server runs here; launched elsewhere,
   * that entry is a project registered under the name it was given, checked as every one is.
   */
  function launchView(): EnsoProject {
    const renamed = stored.find((registration) => registration.path === launch.path)?.title
    return viewOf(launch.path, renamed, true)
  }

  function persist(next: Registration[]): void {
    if (options.statePath !== undefined) writeRegistrations(options.statePath, next)
    stored = next
  }
  /**
   * The project each thread was named for. Dropped when its session is built (`dropClaim`) — and
   * put back by the next request that names it, since `claim` records whatever a request says for a
   * thread with no entry. So with a page that names the project on every request,
   * this holds one entry per thread such a page has asked about, for the process's life: the same
   * named non-coverage as the registry's `generations` map — loopback, dev-only, ids minted by the
   * page. Inert once the session exists: only a NEW thread's build reads it.
   */
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
    return [launchView(), ...served().map((registration) => viewOf(registration.path, registration.title, false))]
  }

  function get(projectId: string): EnsoProject | undefined {
    if (!isEnsoProjectId(projectId)) return undefined
    return list().find((project) => project.projectId === projectId)
  }

  function byDirectory(directory: string): EnsoProject | undefined {
    // A thread's own tree (#551) is no registered directory: it belongs to the project its path
    // names, served exactly when that project is.
    const treeProject = options.projectsDir === undefined ? undefined : treeProjectId(options.projectsDir, directory)
    if (treeProject !== undefined) return get(treeProject)
    const canonical = realpathOrSelf(directory)
    if (canonical === launch.path) return launchView()
    const registration = served().find((candidate) => candidate.path === canonical)
    return registration === undefined ? undefined : viewOf(registration.path, registration.title, false)
  }

  function register(request: EnsoProjectRegistration): ProjectRegistrationOutcome {
    const resolved = canonicalDirectory(expandHome(request.path, home), request.path)
    if (typeof resolved !== 'string') return resolved
    const canonical = resolved
    if (canonical === launch.path) return { kind: 'existing', project: launchView() }
    const refusal = refusalOf(canonical, request.hidden === true)
    if (refusal !== undefined) return { kind: 'refused', reason: refusal }
    const existing = served().find((registration) => registration.path === canonical)
    if (existing !== undefined) return { kind: 'existing', project: viewOf(existing.path, existing.title, false) }
    const added: Registration =
      request.title === undefined ? { path: canonical } : { path: canonical, title: request.title }
    persist([...stored.filter((registration) => registration.path !== canonical), added])
    log.info('project registered: {path}', { path: canonical, projectId: projectIdOf(canonical) })
    return { kind: 'registered', project: viewOf(canonical, request.title, false) }
  }

  function browse(path: string | undefined, hidden: boolean): ProjectBrowseOutcome {
    if (path === undefined) {
      const existing = browseRoots.filter(isDirectory)
      return {
        kind: 'listing',
        listing: listingOf(
          null,
          null,
          undefined,
          existing.map((root) => entryOf(root, root)),
        ),
      }
    }
    const resolved = canonicalDirectory(expandHome(path, home), path)
    if (typeof resolved !== 'string') return resolved
    const isRoot = browseRoots.includes(resolved)
    const refusal = refusalOf(resolved, hidden)
    if (!isRoot && refusal !== undefined) return { kind: 'refused', reason: refusal }
    const children = childDirectories(resolved, hidden)
    if (!Array.isArray(children)) return children
    // "Up" goes where a page may browse: a root, or a directory the rule would take — never into `/`.
    const above = dirname(resolved)
    const upAllowed =
      !isRoot && above !== resolved && (browseRoots.includes(above) || refusalOf(above, hidden) === undefined)
    return {
      kind: 'listing',
      listing: listingOf(resolved, upAllowed ? above : null, refusal, children),
    }
  }

  /**
   * The directories under `directory` a page may browse into: resolved, and taken by the rule a registration is.
   * ⚠ A directory can be searchable and not readable (`--x`): `realpath` and `stat` pass, the listing
   * throws, and an unhandled throw takes the server down. That is a refusal saying so, not an empty
   * list, which would read as "no folders here". Each child is only resolved and stat'ed, never read.
   */
  function childDirectories(
    directory: string,
    hidden: boolean,
  ): EnsoDirectoryEntry[] | { readonly kind: 'refused'; readonly reason: string } {
    let listed: Dirent[]
    try {
      listed = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        kind: 'refused',
        reason: `Enso can’t read ${directory}${code === 'EACCES' ? ': permission denied' : ` (${code})`}.`,
      }
    }
    const entries: EnsoDirectoryEntry[] = []
    for (const child of listed) {
      if ((!hidden && child.name.startsWith('.')) || !(child.isDirectory() || child.isSymbolicLink())) continue
      const canonical = realpathOrSelf(join(directory, child.name))
      if (!isDirectory(canonical) || refusalOf(canonical, hidden) !== undefined) continue
      entries.push(entryOf(canonical, child.name))
    }
    return entries.toSorted((left, right) => left.name.localeCompare(right.name))
  }

  function entryOf(canonical: string, name: string): EnsoDirectoryEntry {
    const projectId = byDirectory(canonical)?.projectId
    return projectId === undefined ? { name, path: canonical } : { name, path: canonical, projectId }
  }

  function remove(projectId: string): ProjectRemovalOutcome {
    if (projectId === launch.projectId) return 'launch'
    if (!served().some((registration) => projectIdOf(registration.path) === projectId)) return 'unknown'
    persist(stored.filter((registration) => projectIdOf(registration.path) !== projectId))
    log.info('project removed: {projectId}', { projectId })
    return 'removed'
  }

  function retitle(projectId: string, title: string): ProjectRetitleOutcome {
    const path =
      projectId === launch.projectId
        ? launch.path
        : served().find((registration) => projectIdOf(registration.path) === projectId)?.path
    if (path === undefined) return { kind: 'unknown' }
    const named: Registration = { path, title }
    const at = stored.findIndex((registration) => registration.path === path)
    persist(at === -1 ? [...stored, named] : stored.with(at, named))
    log.info('project {projectId} renamed', { projectId, path })
    return { kind: 'retitled', project: path === launch.path ? launchView() : viewOf(path, title, false) }
  }

  function claim(threadId: string, projectId: string | undefined): ProjectClaimRefusal | undefined {
    if (projectId === undefined) return undefined
    const named = claims.get(threadId)
    // The same name again is no news, even for a project removed since (#897): the thread can be
    // built nowhere else, and its build says why (`directoryForNewThread`). A reloaded page names it
    // to show the draft is in a project that is gone; refusing each of its reads would say it again
    // as a failed follow and a failed catalogue over the launch panel's own words.
    if (named === projectId) return undefined
    if (get(projectId) === undefined) {
      // Said for the reader of a thread whose project was removed (the live check of #395 slice 3):
      // the id alone says nothing to them.
      return { status: 400, reason: `project ${projectId} is not registered here — it was removed, or never added` }
    }
    if (named !== undefined) {
      return {
        status: 409,
        reason: `thread ${threadId} was already named for project ${named}; a thread's project is chosen once`,
      }
    }
    claims.set(threadId, projectId)
    return undefined
  }

  function dropClaim(threadId: string): void {
    claims.delete(threadId)
  }

  function claimOf(threadId: string): string | undefined {
    return claims.get(threadId)
  }

  function projectOfNewThread(threadId: string): EnsoProject | undefined {
    const claimed = claims.get(threadId)
    return claimed === undefined ? launchView() : get(claimed)
  }

  function directoryForNewThread(threadId: string): string {
    const project = projectOfNewThread(threadId)
    if (project === undefined) throw new ProjectUnavailable(`thread ${threadId}: its project is no longer registered`)
    if (project.status === 'missing-dir') {
      throw new ProjectUnavailable(`thread ${threadId}: the project directory ${project.path} no longer exists`)
    }
    return project.path
  }

  return {
    list,
    get,
    byDirectory,
    register,
    browse,
    remove,
    retitle,
    claim,
    dropClaim,
    claimOf,
    projectOfNewThread,
    directoryForNewThread,
  }
}
