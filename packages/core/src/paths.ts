/**
 * The workspace path helpers (#59) — THE one place that walks the filesystem for roots.
 *
 * Before this module, seven call sites each computed the repo root by counting `..`
 * segments off their own `import.meta.url` — a shape that breaks silently when a file
 * moves (dev.ts carried `4×".."`). An anchor test (`no-duplicate-paths.test.ts`) now
 * refuses an eighth copy: `fileURLToPath` and inline `.enso` path assembly outside this
 * module fail the suite by name.
 *
 * ⚠ REALPATH FIRST, then walk — load-bearing, observed live (PR #58 receipts): bun does
 * NOT realpath `import.meta.url` through the print-harness symlink mirror (`printHarnessDir`), so a
 * walk from the un-resolved module path starts inside the mirror. The mirror's entries
 * are symlinks back into the real tree, so resolving first lands the walk in the real
 * checkout; walking first would search the wrong ancestry.
 *
 * ⚠ These helpers run under node/bun only (node:fs). They are barrel-exported and the
 * browser bundle tolerates that because nothing browser-side imports them — probed
 * 2026-09-04: `bun build index.html --target=browser` tree-shakes the module out.
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep as pathSeparator, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENSO_CONFIG_FILENAME } from './config.ts'
import { SECRET_BASENAME_PATTERNS } from './guard.ts'

/**
 * Thrown when no ancestor of the start path is a workspace root.
 *
 * @group Workspace paths
 */
export class RepoRootNotFoundError extends Error {
  constructor(startPath: string) {
    super(
      `no ancestor of "${startPath}" is a workspace root (a directory whose package.json ` +
        `carries a "workspaces" field) — is this file inside the Enso checkout?`,
    )
    this.name = 'RepoRootNotFoundError'
  }
}

/**
 * `realpathSync`, or the input unchanged when the path (or a segment of it) does not exist.
 *
 * @group Workspace paths
 */
export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** As many links as one path may pass through before it is a loop (Linux's own `MAXSYMLINKS`). */
const MAX_LINK_HOPS = 40

/**
 * The file `path` names, through every link — also a link whose file is not there yet (a dotfiles
 * repo not checked out), which `realpathSync` refuses. A path with nothing at it names itself.
 * A link's target is read against its directory's REAL path, as the kernel reads a `..` in it.
 * ⚠ A link loop (more than `MAX_LINK_HOPS` links) throws ELOOP: the link is never replaced.
 */
function fileBehindLinks(path: string): string {
  let current = path
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    try {
      return realpathSync(current)
    } catch {
      // realpath refused (nothing there, a dangling link, a loop, no access): walk the link by hand.
    }
    let isLink: boolean
    try {
      isLink = lstatSync(current).isSymbolicLink()
    } catch {
      return current
    }
    if (!isLink) return current
    current = resolve(realpathOrSelf(dirname(current)), readlinkSync(current))
  }
  throw Object.assign(new Error(`ELOOP: too many symbolic links behind "${path}"`), { code: 'ELOOP' })
}

/**
 * Replace the file at `path` with `text` (or bytes — a file put back as it was, #945) in one step:
 * written beside the file it names, then renamed over it — a reader sees the old file or the new
 * one, never half of one. Settings' writes go through here: the permission policy and Enso's rule
 * record beside it (#474, #945), `config.json` (#924, #933), `secrets.env` (#933) and the project
 * config approvals (#753).
 *
 * ⚠ AT THE FILE THE PATH NAMES, NOT THE LINK: a config file kept as a symlink (into a dotfiles repo,
 * say) stays a link, and the file behind it changes — or is made, when the link points at a file
 * not there yet; a link into a directory not there is an error, never replaced. The file keeps its
 * own mode unless `mode` is given (`secrets.env` is written `0600`); a new file without one gets the
 * umask's. The staged file is always newly made, so it is never readable wider for a moment. Nothing
 * staged is left behind when the write or the rename throws: the error is rethrown.
 *
 * ⚠ THE MODIFICATION TIME MUST MOVE. The permission engine reloads a policy only when the file's
 * `mtimeMs` differs from the one it last read (`config/policy-loader.ts`), and Linux stamps it from
 * a coarse clock — one tick is milliseconds. A write landing in the same tick as the last one (a
 * reset just after a hand edit) kept the OLD policy in force, silently. Found by
 * `agent-host.test.ts`'s reset test.
 *
 * @group Workspace paths
 */
export function replaceFileText(path: string, text: string | Uint8Array, mode?: number): void {
  const target = fileBehindLinks(path)
  const previous = existsSync(target) ? statSync(target) : undefined
  const fileMode = mode ?? (previous === undefined ? undefined : previous.mode & 0o7777)
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(staged, text, fileMode === undefined ? { flag: 'wx' } : { flag: 'wx', mode: fileMode })
    // writeFileSync's mode is masked by the umask; the file's mode is set exactly.
    if (fileMode !== undefined) chmodSync(staged, fileMode)
    renameSync(staged, target)
  } catch (error: unknown) {
    rmSync(staged, { force: true })
    throw error
  }
  if (previous === undefined) return
  const written = statSync(target)
  if (written.mtimeMs > previous.mtimeMs) return
  utimesSync(target, written.atime, (previous.mtimeMs + 1) / 1000)
}

/**
 * True when `directory` is the workspace root: its `package.json` parses and carries a
 * `workspaces` field of a shape npm actually accepts — an array of globs, or the object
 * form (`{ "packages": [...] }`). A `"workspaces": null` is not a root.
 * ⚠ A malformed `package.json` on the walk (a test fixture, a scratch dir) means "not
 * the root, keep walking" — never a throw.
 */
function isWorkspaceRoot(directory: string): boolean {
  const manifest = readPackageManifest(directory)
  if (manifest === undefined || !('workspaces' in manifest)) return false
  const workspaces = manifest.workspaces
  return Array.isArray(workspaces) || (typeof workspaces === 'object' && workspaces !== null)
}

const PACKAGE_MANIFEST_FILENAME = 'package.json'

/**
 * `directory/package.json` as an object, or `undefined` — absent, unreadable, malformed or not an
 * object alike. Both walks (`findRepoRoot`, `installedPackageDir`) read manifests they did not write,
 * and a broken one on the way up means "not this one, keep walking", never a throw.
 */
function readPackageManifest(directory: string): Record<string, unknown> | undefined {
  const manifestPath = join(directory, PACKAGE_MANIFEST_FILENAME)
  if (!existsSync(manifestPath)) return undefined
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const FILE_URL_PREFIX = 'file://'

/**
 * True when the string is a `file://` URL rather than a filesystem path.
 *
 * @group Workspace paths
 */
export function isFileUrl(candidate: string): boolean {
  return candidate.startsWith(FILE_URL_PREFIX)
}

/**
 * Decode a `file://` URL to the filesystem path it names.
 *
 * The ONLY `fileURLToPath` call site in the repository (the anchor test enforces it). Two
 * callers with different reasons share it: {@link findRepoRoot} accepts `import.meta.url`,
 * and the harness guard decodes a `file://` path a tool was handed — pi's own tools decode
 * one before touching the filesystem, so the guard must judge the decoded path (#53).
 *
 * @group Workspace paths
 */
export function fileUrlToPath(fileUrl: string): string {
  return fileURLToPath(fileUrl)
}

/**
 * The repository root: the nearest ancestor whose `package.json` declares `workspaces`.
 *
 * Accepts a filesystem path OR a `file://` URL, so callers pass `import.meta.url`
 * directly and never touch `fileURLToPath` themselves (the anchor test enforces that).
 * The start path is realpath-resolved BEFORE walking — see the module header for why.
 *
 * ⚠ This finds the root of the checkout the given FILE lives in — for a module inside
 * this repo that is always the Enso checkout, never the session cwd. That
 * distinction is what `config.ts` relies on; do not "fix" this to consult `process.cwd()`.
 *
 * @group Workspace paths
 */
export function findRepoRoot(startPathOrFileUrl: string): string {
  const startPath = isFileUrl(startPathOrFileUrl) ? fileUrlToPath(startPathOrFileUrl) : startPathOrFileUrl
  let current = realpathOrSelf(startPath)
  for (;;) {
    if (isWorkspaceRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) throw new RepoRootNotFoundError(startPath)
    current = parent
  }
}

/**
 * The harness package's manifest `name` (`packages/harness/package.json`): what an installed harness
 * is found by (#950). ⚠ The name is not settled for publishing (#948). A rename changes this
 * constant and the manifest together, and `paths.test.ts` fails when they differ.
 *
 * @group Workspace paths
 */
export const HARNESS_PACKAGE_NAME = 'enso'

/**
 * The web package's manifest `name` (`packages/web/package.json`), pinned the same way.
 *
 * @group Workspace paths
 */
export const WEB_PACKAGE_NAME = '@enso/web'

/** Where a checkout keeps its workspace packages: `<root>/packages/<package>`. */
const WORKSPACE_PACKAGES_DIRECTORY = 'packages'

/**
 * Thrown when no ancestor of the start path is the named package.
 *
 * @group Workspace paths
 */
export class PackageDirNotFoundError extends Error {
  constructor(startPath: string, packageName: string) {
    super(
      `no ancestor of "${startPath}" holds a package.json named "${packageName}" — is this file inside that package?`,
    )
    this.name = 'PackageDirNotFoundError'
  }
}

/**
 * The directory the named package is installed in: the nearest ancestor of the start path whose
 * `package.json` is named `packageName` (#950). It works the same in this checkout
 * (`packages/harness`) and in an install (`…/node_modules/enso`). `findRepoRoot` cannot do that: an
 * installed package has no workspace root above it, so that walk throws.
 *
 * Takes a path or a `file://` URL and realpaths first, as `findRepoRoot` does and for the same
 * reason: the print-harness mirror (`printHarnessDir`) is symlinks back into the real tree.
 *
 * ⚠ Matched by NAME, not "the first package.json": a package may hold another manifest below its
 * root (a fixture, a nested tool), and the first one found would be the wrong directory, with no
 * error to say so.
 *
 * @group Workspace paths
 */
export function installedPackageDir(startPathOrFileUrl: string, packageName: string): string {
  const startPath = isFileUrl(startPathOrFileUrl) ? fileUrlToPath(startPathOrFileUrl) : startPathOrFileUrl
  let current = realpathOrSelf(startPath)
  for (;;) {
    if (readPackageManifest(current)?.name === packageName) return current
    const parent = dirname(current)
    if (parent === current) throw new PackageDirNotFoundError(startPath, packageName)
    current = parent
  }
}

/**
 * The Enso checkout a package directory is a workspace member of, or `undefined` when the package
 * is installed rather than checked out (#950). A member sits at `<root>/packages/<name>` under a root
 * whose `package.json` declares `workspaces`. Nothing else counts.
 *
 * ⚠ Not "the nearest workspace root above". A package installed into the user's own monorepo has
 * one of those, and it is the user's: its `.env`, its `.git` and its `.enso/` are not Enso's to read
 * or to migrate. The layout check is what keeps an install from adopting someone else's checkout.
 *
 * @group Workspace paths
 */
export function checkoutRootOfPackage(packageDir: string): string | undefined {
  const packagesDirectory = dirname(packageDir)
  if (basename(packagesDirectory) !== WORKSPACE_PACKAGES_DIRECTORY) return undefined
  const candidateRoot = dirname(packagesDirectory)
  return isWorkspaceRoot(candidateRoot) ? candidateRoot : undefined
}

/**
 * Where a package's own files live, for a reader that wants the checkout when there is one: the
 * Enso checkout root when the package is a workspace member of one, else the directory it is
 * installed in (#950). The guards' `harnessRoot` is this. In a checkout it stays the root, where
 * #421's migration leaves what it could not move. Installed, it is the package, the one directory
 * that is Enso's.
 *
 * @group Workspace paths
 */
export function checkoutOrInstalledRoot(startPathOrFileUrl: string, packageName: string): string {
  const packageDir = installedPackageDir(startPathOrFileUrl, packageName)
  return checkoutRootOfPackage(packageDir) ?? packageDir
}

/**
 * The directory of `packageName` as Node resolves it from `fromDirectory`'s package (#950). That is
 * the workspace link in `node_modules` in a checkout, and a declared dependency in an install.
 * Realpath'd, so a workspace link lands on the package itself.
 *
 * ⚠ Resolves `<name>/package.json`, so a package whose `exports` hides its manifest cannot be
 * resolved here. Neither Enso package declares `exports` that would.
 *
 * @group Workspace paths
 */
export function resolvePackageDir(packageName: string, fromDirectory: string): string {
  const requireFromDirectory = createRequire(join(fromDirectory, PACKAGE_MANIFEST_FILENAME))
  return realpathOrSelf(dirname(requireFromDirectory.resolve(`${packageName}/${PACKAGE_MANIFEST_FILENAME}`)))
}

/** The `.enso` runtime dir names, assembled here and nowhere else (the anchor enforces it). */
const ENSO_RUNTIME_DIRECTORY = '.enso'

/**
 * The user-level Enso directory (#421): `ENSO_HOME` when set, else `~/.enso` — pi's own pattern,
 * `PI_CODING_AGENT_DIR` else `~/.pi/agent`. Every runtime path resolves under it: pi's agent dir,
 * the secrets file, the logs, the project list. One per user, so a second checkout or worktree
 * shares its logins, sessions and projects, and nothing runtime lives in a source tree.
 *
 * Read from the environment it is given, never from `process.env` directly, so a test passes its
 * own and the launchers pass theirs — and a child the terminal launcher spawns inherits the same.
 *
 * @group Workspace paths
 */
export function ensoHome(environment: Readonly<Record<string, string | undefined>>): string {
  const configured = environment.ENSO_HOME
  return configured === undefined || configured.length === 0
    ? join(homedir(), ENSO_RUNTIME_DIRECTORY)
    : resolve(configured)
}

/**
 * The checkout-local `.enso/` every runtime path lived in before #421. Read by the migration
 * (`migrateCheckoutEnso`) and nothing else.
 *
 * @group Workspace paths
 */
export function checkoutEnsoDir(repoRoot: string): string {
  return join(repoRoot, ENSO_RUNTIME_DIRECTORY)
}

/**
 * What moving the checkout's `.enso/` into `ENSO_HOME` did (#421).
 *
 * @group Workspace paths
 */
export interface EnsoHomeMigration {
  /** The checkout's `.enso/` the files came from. */
  readonly from: string
  /** `ENSO_HOME`. */
  readonly to: string
  /** Files moved, relative to both. */
  readonly moved: readonly string[]
  /** Files LEFT in `from`: `to` already holds one at that path. Never overwritten — the user decides. */
  readonly kept: readonly string[]
  /**
   * The checkout HAS an old `.enso/` that this launch did not move, because `ENSO_HOME` was set
   * explicitly (`migrateCheckoutEnsoOnLaunch`). Said, so it is not silently ignored.
   */
  readonly held: boolean
}

/**
 * Move the checkout's `.enso/` into `ENSO_HOME` (#421) — pi's `runMigrations` pattern: automatic
 * on startup, idempotent, never overwriting. Each file whose path is free in `ENSO_HOME` is moved;
 * one that is taken is left where it is and reported in `kept`, so two checkouts' logins or
 * sessions conflict loudly instead of one silently replacing the other. Emptied directories are
 * removed, the checkout's `.enso/` with them once nothing is left in it.
 *
 * `print-harness/` is not moved but deleted: a build cache of the checkout, regenerated at its new
 * place (`printHarnessDir`) on the next terminal launch, whose relative links would break moved.
 *
 * ⚠ THE PROJECT'S OWN FILES STAY (#754): the top-level `config.json`, `config.local.json` and
 * `prompts/` are the checkout's project tiers now (`projectConfigPath`, `projectLocalConfigPath`,
 * `projectPromptsDir`), committed or kept with it and read trust-gated as the project's. Moved,
 * the repository's shared config would become the user's config for every project.
 *
 * Tolerant of a second launcher migrating at the same moment (`bun run dev` starts two): a file
 * the other process moved first is skipped, not reported. `ENSO_HOME` is created `0700` — it
 * holds credentials.
 *
 * @group Workspace paths
 */
export function migrateCheckoutEnso(repoRoot: string, home: string): EnsoHomeMigration {
  const from = checkoutEnsoDir(repoRoot)
  const migration = { from, to: home, moved: [] as string[], kept: [] as string[], held: false }
  if (!existsSync(from) || resolve(from) === resolve(home)) return migration
  mkdirSync(home, { recursive: true, mode: 0o700 })
  rmSync(join(from, 'print-harness'), { recursive: true, force: true })
  moveTree(from, home, '', migration)
  removeEmptyDirectories(from)
  return migration
}

/**
 * The migration a LAUNCH runs (#421): into the default `ENSO_HOME` (`~/.enso`) only. With
 * `ENSO_HOME` set explicitly nothing moves — the checkout's old `.enso/` is `held` and reported,
 * when it holds anything besides the project's own files (#754), which stay either way.
 *
 * ⚠ Why: a launcher run from a checkout with a scratch or test `ENSO_HOME` (`ENSO_HOME=/tmp/x`)
 * would otherwise move that checkout's logins and sessions into the scratch directory, to be lost
 * with it — which happened, once, while this was being built. `~/.enso` is the one place a user's
 * state is meant to live, so it is the one place a launch moves it to without being asked. Someone
 * who chose another home moves the old directory by hand, and the launch says so.
 *
 * @group Workspace paths
 */
export function migrateCheckoutEnsoOnLaunch(
  repoRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): EnsoHomeMigration {
  const home = ensoHome(environment)
  const configured = environment.ENSO_HOME
  if (configured === undefined || configured.length === 0) return migrateCheckoutEnso(repoRoot, home)
  const from = checkoutEnsoDir(repoRoot)
  const held = existsSync(from) && readdirSync(from).some((entryName) => !PROJECT_OWN_ENTRIES.has(entryName))
  return { from, to: home, moved: [], kept: [], held }
}

/** A project-local config's basename (#754), beside the shared `config.json`. */
const ENSO_LOCAL_CONFIG_FILENAME = 'config.local.json'

/** What `migrateCheckoutEnso` leaves at the top of the checkout's `.enso/`: the project's own tiers (#754). */
const PROJECT_OWN_ENTRIES: ReadonlySet<string> = new Set([ENSO_CONFIG_FILENAME, ENSO_LOCAL_CONFIG_FILENAME, 'prompts'])

function moveTree(
  from: string,
  to: string,
  relativeDirectory: string,
  migration: { moved: string[]; kept: string[] },
): void {
  for (const child of readdirSync(join(from, relativeDirectory), { withFileTypes: true })) {
    if (relativeDirectory === '' && PROJECT_OWN_ENTRIES.has(child.name)) continue
    const relativePath = join(relativeDirectory, child.name)
    if (child.isDirectory()) {
      moveTree(from, to, relativePath, migration)
      continue
    }
    const outcome = moveEntry(join(from, relativePath), join(to, relativePath))
    if (outcome !== 'gone') migration[outcome].push(relativePath)
  }
}

/** One file or link: `moved`, `kept` (the target is taken), or `gone` (another launcher moved it first). */
function moveEntry(source: string, target: string): 'moved' | 'kept' | 'gone' {
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    return lstatSync(source, { throwIfNoEntry: false }) === undefined ? 'gone' : 'kept'
  }
  mkdirSync(dirname(target), { recursive: true })
  try {
    renameSync(source, target)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'gone'
    if (code !== 'EXDEV') throw error
    // `ENSO_HOME` on another filesystem: copy, then remove — never the other way round.
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target)
    else copyFileSync(source, target, constants.COPYFILE_EXCL)
    unlinkSync(source)
  }
  return 'moved'
}

function removeEmptyDirectories(directory: string): void {
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (child.isDirectory()) removeEmptyDirectories(join(directory, child.name))
  }
  if (readdirSync(directory).length === 0) rmdirSync(directory)
}

/**
 * pi's scratch agent dir — settings, extensions, auth, sessions, trust. Shared by the TUI launcher
 * and the web server. ⚠ Deliberately NOT `~/.pi/agent`: the operator's own pi packages and
 * credentials stay invisible to Enso's sessions (`agent-host.ts`).
 *
 * @group Workspace paths
 */
export function ensoAgentDir(home: string): string {
  return join(home, 'pi-agent')
}

/**
 * The harness's secrets file (#89): `ENSO_HOME/secrets.env`, NOT `.env` at the root.
 *
 * bun auto-loads `.env*` from the cwd into EVERY bun process — including a `bun -e` the model
 * runs from the repo root — so a root `.env` reaches a tool child no matter what the parent
 * scrubbed (verified with `env -i`).
 *
 * `ENSO_HOME` is write-protected (`ENSO_PERSISTENCE_WRITE_DIRECTORIES`) and read-denied on BOTH
 * tool routes by the `/.enso/` fragment in
 * {@link core/src!DEFAULT_GUARD_POLICY | DEFAULT_GUARD_POLICY}: the reader gate for every tool
 * carrying a path, and the shell deny (#204) for a literal path word in `bash`/`powershell`.
 * ⚠ The shell leg is a bar, not a boundary — `shell-secret-paths.ts` states what a
 * runtime-assembled name still gets past. ⚠ An `ENSO_HOME` whose path has no `.enso` segment is
 * NOT matched by that fragment: keep the directory named `.enso`.
 *
 * ⚠ THE `core/src!` QUALIFIER IS LOAD-BEARING, and the obvious simplification does not work
 * (#188). `guard.ts` is not imported here, so TypeScript's own link resolution — which TypeDoc
 * prefers by default — has nothing in scope, and a bare `{@link DEFAULT_GUARD_POLICY}` is an
 * unresolved link. The documented root-scoped form `{@link !DEFAULT_GUARD_POLICY}` does not
 * help either: with several entry points, the PROJECT's children are the modules, not their
 * symbols, so resolution from the root finds nothing. Tested, all three spellings. The module
 * source is therefore named, which couples this link to the entry-point layout in
 * `typedoc.json` — and that coupling breaks LOUDLY, because an unresolved link is a fatal
 * warning in the `api-docs` gate.
 *
 * @group Workspace paths
 */
export function ensoSecretsPath(home: string): string {
  return join(home, 'secrets.env')
}

/**
 * The root `.env` — where secrets must NOT live (#89); reported as misplaced when they do.
 *
 * @group Workspace paths
 */
export function rootDotenvPath(repoRoot: string): string {
  return join(repoRoot, '.env')
}

/**
 * Where the print variant of the harness package is materialized (#20): a build cache of THIS
 * checkout, so it stays in the checkout — its links point into this checkout's harness, and two
 * checkouts sharing one `ENSO_HOME` would otherwise relink it to whichever launched last (#421).
 * Under `node_modules/.cache`, the conventional home of a regenerated artifact, gitignored and
 * outside every `.enso` the guards protect.
 *
 * @group Workspace paths
 */
export function printHarnessDir(repoRoot: string): string {
  return join(repoRoot, 'node_modules', '.cache', 'enso', 'print-harness')
}

/**
 * Where the harness's log lives (#132): `ENSO_HOME/logs/enso-YYYY-MM-DD.jsonl`, ONE file per day
 * that every process appends to (dated, never renamed, so a second writer is safe — see
 * `web/server/logging.ts`).
 *
 * Under `ENSO_HOME` so bun never autoloads from it and the write gate already knows it (guard.ts).
 *
 * @group Workspace paths
 */
export function ensoLogsDir(home: string): string {
  return join(home, 'logs')
}

/**
 * The projects registered from a page (#395): `ENSO_HOME/projects.json`. Server STATE, not config —
 * the roots they may sit under are config (`ENSO_HOME/config.json`).
 *
 * @group Workspace paths
 */
export function ensoProjectsPath(home: string): string {
  return join(home, 'projects.json')
}

/**
 * The id of a canonical project directory: its path, hashed — sixteen hex digits
 * (`isEnsoProjectId`). The key everything Enso holds ABOUT a project is filed under
 * (`ensoProjectsDir`, #552), and `projects.json` the only id↔path map. ⚠ The path must be the
 * CANONICAL one (`realpath`), as the registry makes it: the same directory, one id. A moved
 * checkout is a new id; its folder stays behind until moved by hand (#552's decision).
 *
 * @group Workspace paths
 */
export function projectIdOf(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 16)
}

/**
 * Everything Enso holds ABOUT its projects (#552): `ENSO_HOME/projects/<id>/`, one folder per
 * project id, holding the project's sessions (`projectSessionsDir`) and, with #551, its threads'
 * trees and snapshots. What a project says about ITSELF (`<project>/.enso/config.json`) stays in
 * the checkout, trust-gated; pi's trust store stays pi's. The registry (`ensoProjectsPath`) is the
 * one map from id to path.
 *
 * @group Workspace paths
 */
export function ensoProjectsDir(home: string): string {
  return join(home, 'projects')
}

/**
 * A project's sessions: `<projectsDir>/<id>/sessions`, the directory pi is handed as its session
 * directory for every thread of the project — whatever cwd the thread runs in (a #551 tree is not
 * the project), so the thread is always filed under its project and found there.
 *
 * @group Workspace paths
 */
export function projectSessionsDir(projectsDir: string, projectId: string): string {
  return join(projectsDir, projectId, 'sessions')
}

/**
 * A project's snapshot stores: `<projectsDir>/<id>/snapshots/<thread-id>` is one thread's bare
 * repository of its tree as each run began (#551, `@enso/core/snapshot-store`). Beside the
 * thread's session, under its project; to be removed with the thread by #551 slice 2's `dispose`
 * — nothing removes one yet.
 *
 * @group Workspace paths
 */
export function projectSnapshotsDir(projectsDir: string, projectId: string): string {
  return join(projectsDir, projectId, 'snapshots')
}

/**
 * A project's thread trees: `<projectsDir>/<id>/trees/<thread-id>` is the directory one thread
 * runs in (#551 slice 2, `@enso/core/thread-tree`) — a worktree of the checkout, or a copy — never
 * the checkout itself. pi's cwd for the thread, so the session header records it.
 *
 * @group Workspace paths
 */
export function projectTreesDir(projectsDir: string, projectId: string): string {
  return join(projectsDir, projectId, 'trees')
}

/**
 * The project id a minted tree's path names — `<projectsDir>/<id>/trees/<thread-id>`, the tree's
 * root or anything under it — or `undefined` for any other path. ⚠ The one way a thread's cwd
 * becomes its project: a thread on a tree runs in a directory that is no project, and every
 * reader that files or serves by project (the session directory, the snapshot store, the
 * server's projects) asks this first. Read off the path alone, so it holds for a tree whose
 * project is no longer registered (it is then simply not served).
 *
 * @group Workspace paths
 */
export function treeProjectId(projectsDir: string, path: string): string | undefined {
  const root = threadTreeRoot(projectsDir, path)
  return root === undefined ? undefined : basename(dirname(dirname(root)))
}

/**
 * The root of the minted tree a path is in — `<projectsDir>/<id>/trees/<thread-id>` for the tree's
 * root or anything under it — or `undefined` for any other path. The shape `treeProjectId` reads,
 * cut at the tree: what the guard judges a session's own files relative to (#615), so a tree under
 * `ENSO_HOME` is a workspace like any checkout and not the harness's own directory.
 *
 * @group Workspace paths
 */
export function threadTreeRoot(projectsDir: string, path: string): string | undefined {
  const fromProjects = relative(resolve(projectsDir), resolve(path))
  if (fromProjects === '' || fromProjects.startsWith('..') || isAbsolute(fromProjects)) return undefined
  const [projectId, trees, threadId] = fromProjects.split(pathSeparator)
  return projectId !== undefined && /^[0-9a-f]{16}$/.test(projectId) && trees === 'trees' && threadId !== undefined
    ? join(resolve(projectsDir), projectId, trees, threadId)
    : undefined
}

/**
 * The project a cwd belongs to, by id: the one a minted tree's path names, else the cwd's own (its
 * canonical path, hashed — `projectIdOf`). ⚠ A THREAD ON A TREE RUNS IN A DIRECTORY THAT IS NO
 * PROJECT: everything filed or served by project — the session directory, the snapshot store, the
 * server's projects, the approved project config (#753) — asks this first.
 *
 * @group Workspace paths
 */
export function projectIdOfCwd(projectsDir: string, cwd: string): string {
  return treeProjectId(projectsDir, cwd) ?? projectIdOf(realpathOrSelf(cwd))
}

/**
 * The project config tiers the operator approved (#753): `<projectsDir>/<id>/config-approvals.json`,
 * the contents of the project's `.enso/config.json` and `.enso/config.local.json` as approved on
 * its page. ⚠ Under `ENSO_HOME`, beside the project's sessions, never in the project: the agent
 * works in the project, and the approval is what stands between its writes there and what applies.
 *
 * @group Workspace paths
 */
export function projectConfigApprovalsPath(projectsDir: string, projectId: string): string {
  return join(projectsDir, projectId, 'config-approvals.json')
}

/**
 * What `migrateSessionsIntoProjects` did: files moved, files left because the target held one,
 * directories whose cwd is gone.
 *
 * @group Workspace paths
 */
export interface SessionMigration {
  /** Files now in their project folder. */
  readonly moved: string[]
  /** Legacy files left in place: the project folder already held one of that name. */
  readonly kept: string[]
  /** Legacy directories left in place: a session's cwd no longer exists, so it has no project. */
  readonly orphaned: string[]
  /** Legacy files left in place: no header with a cwd on the first line — not pi's shape, or the tail a pre-#552 process kept appending after a move. */
  readonly unreadable: string[]
}

/** The most a session file's first line is read: two `PATH_MAX` paths (8 KiB) and headroom. */
const HEADER_LINE_BOUND = 64 * 1024
const NEWLINE = 0x0a

/**
 * The first line of a pi session file: the header, with the cwd the session ran in. `gone` when the
 * file is no longer there — another launcher moved it between the directory read and this open;
 * `unreadable` when the first line is not a header with a cwd.
 */
function sessionCwdOf(file: string): { kind: 'cwd'; cwd: string } | { kind: 'gone' } | { kind: 'unreadable' } {
  let descriptor: number
  try {
    descriptor = openSync(file, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'gone' }
    throw error
  }
  try {
    // The first line whole: read until its newline, or EOF, or the bound — a header is two paths
    // and a few fields, far under it; a line past the bound is not pi's header and is `unreadable`.
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total < HEADER_LINE_BOUND) {
      const chunk = Buffer.alloc(4096)
      const read = readSync(descriptor, chunk, 0, chunk.length, position)
      if (read === 0) break
      chunks.push(chunk.subarray(0, read))
      total += read
      position += read
      if (chunk.subarray(0, read).includes(NEWLINE)) break
    }
    const firstLine = Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? ''
    const header: unknown = JSON.parse(firstLine)
    const cwd = (header as { cwd?: unknown }).cwd
    return typeof cwd === 'string' && cwd.length > 0 ? { kind: 'cwd', cwd } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  } finally {
    closeSync(descriptor)
  }
}

/** A directory's `.jsonl` names; none when another launcher removed the directory first. */
function sessionFileNames(directory: string): string[] {
  try {
    return readdirSync(directory).filter((fileName) => fileName.endsWith('.jsonl'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Remove an emptied legacy directory; one already gone, or refilled meanwhile, stays as it is. */
function removeIfEmpty(directory: string): void {
  try {
    if (readdirSync(directory).length === 0) rmdirSync(directory)
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
  }
}

/**
 * The migration a LAUNCH runs after `migrateCheckoutEnsoOnLaunch` (#552): every session pi filed
 * under its default `<agentDir>/sessions/<encoded-cwd>/` moves to its project's folder,
 * `projects/<projectIdOf(realpath(cwd))>/sessions/`, so both surfaces read and write one place.
 * Each file is moved by `moveEntry`: never over one the target already holds (`kept`). Two
 * launchers may run this at once (the web and a terminal start together): a file or directory the
 * other moved or removed first is gone, not an error, at every step. A session whose cwd no longer
 * exists has no canonical path and no project; its directory is reported `orphaned` and left where
 * it is. A file with no readable header is `unreadable` and left too. Emptied legacy directories
 * are removed.
 *
 * ⚠ A file a RUNNING pre-#552 process still appends to is split by the move: pi appends by path
 * (`appendFileSync(this.sessionFile)`), so its next entry recreates a headerless file at the old
 * path — which the next launch reports `unreadable`, by name, for the user to join by hand. The
 * launchers say so; a server of this version opens legacy files only for orphans, whose directory
 * is never moved while it is an orphan.
 *
 * ⚠ A fork's header names its parent by FILE PATH (#433); after a move that path is stale. The
 * host resolves a parent by its file's basename when the path misses (`agent-host.ts#parentThreadIdOf`),
 * since pi names a file `<timestamp>_<id>.jsonl`. pi's own headers are not rewritten.
 *
 * @group Workspace paths
 */
export function migrateSessionsIntoProjects(agentDir: string, projectsDir: string): SessionMigration {
  const legacyRoot = join(agentDir, 'sessions')
  const migration: SessionMigration = { moved: [], kept: [], orphaned: [], unreadable: [] }
  if (!existsSync(legacyRoot)) return migration
  for (const legacyDirectory of readdirSync(legacyRoot, { withFileTypes: true })) {
    // A real directory only. pi's `listAll` follows a symlinked one too; a launch does not move
    // files out of a directory the user linked here by hand, nor `rmdir` a link (ENOTDIR). Its
    // sessions stay listed from where they are.
    if (!legacyDirectory.isDirectory()) continue
    const directory = join(legacyRoot, legacyDirectory.name)
    if (migrateLegacyDirectory(directory, projectsDir, migration)) migration.orphaned.push(directory)
    else removeIfEmpty(directory)
  }
  return migration
}

/**
 * One legacy `<agentDir>/sessions/<encoded-cwd>/` directory's sessions moved into their projects'
 * folders, recorded on `migration`; whether any of them names a cwd that no longer exists.
 */
function migrateLegacyDirectory(directory: string, projectsDir: string, migration: SessionMigration): boolean {
  let orphaned = false
  for (const fileName of sessionFileNames(directory)) {
    const source = join(directory, fileName)
    const header = sessionCwdOf(source)
    if (header.kind === 'gone') continue
    if (header.kind === 'unreadable') {
      migration.unreadable.push(source)
      continue
    }
    let canonical: string | undefined
    try {
      canonical = realpathSync(header.cwd)
    } catch {
      canonical = undefined
    }
    if (canonical === undefined) {
      orphaned = true
      continue
    }
    const target = join(projectSessionsDir(projectsDir, projectIdOf(canonical)), fileName)
    const outcome = moveEntry(source, target)
    if (outcome === 'moved') migration.moved.push(target)
    else if (outcome === 'kept') migration.kept.push(source)
  }
  return orphaned
}

/**
 * The prompt library (#443): `ENSO_HOME/prompts/<id>.md`, one markdown file per prompt. The user's,
 * never committed with a project.
 *
 * @group Workspace paths
 */
export function ensoPromptsDir(home: string): string {
  return join(home, 'prompts')
}

/**
 * The permission policy pi runs under (#446, #496): `ENSO_HOME/permissions.json`. The host and
 * the terminal launcher run `preparePermissionPolicy` (`@enso/core/permission-rules`) on it,
 * which seeds it and links the permission engine's config path to it before the engine reads it.
 *
 * @group Workspace paths
 */
export function ensoPermissionRulesPath(home: string): string {
  return join(home, 'permissions.json')
}

/**
 * The harness package — the directory `enso.ts` hands to pi's `-e`.
 *
 * @group Workspace paths
 */
export function harnessPackageDir(repoRoot: string): string {
  return join(repoRoot, WORKSPACE_PACKAGES_DIRECTORY, 'harness')
}

/**
 * The web package — the cwd both dev surfaces run in.
 *
 * @group Workspace paths
 */
export function webPackageDir(repoRoot: string): string {
  return join(repoRoot, WORKSPACE_PACKAGES_DIRECTORY, 'web')
}

/**
 * The user's config file (#59, #421): `ENSO_HOME/config.json`. Absent is the defaults (`parseEnsoConfig`).
 *
 * @group Workspace paths
 */
export function ensoConfigPath(home: string): string {
  return join(home, ENSO_CONFIG_FILENAME)
}

/**
 * A project's own config (#421): `<project>/.enso/config.json`. Read only once the project is
 * trusted, over the user's (`ensoConfigPath`); the project directory only, never its parents, as
 * pi reads `<cwd>/.pi/`.
 *
 * @group Workspace paths
 */
export function projectConfigPath(projectDirectory: string): string {
  return join(projectDirectory, ENSO_RUNTIME_DIRECTORY, ENSO_CONFIG_FILENAME)
}

/**
 * A project's local config (#754): `<project>/.enso/config.local.json`, gitignored — one person's
 * overrides for one project, over the shared `projectConfigPath`. Read only once the project is
 * trusted, like the shared file.
 *
 * @group Workspace paths
 */
export function projectLocalConfigPath(projectDirectory: string): string {
  return join(projectDirectory, ENSO_RUNTIME_DIRECTORY, ENSO_LOCAL_CONFIG_FILENAME)
}

/**
 * A project's own prompt library (#470): `<project>/.enso/prompts/<id>.md`, committed with the
 * project and shared by everyone who works in it. Read only once the project is trusted, like its
 * config, and never written by Enso: a shared file is changed in the repository, not from the manager.
 *
 * @group Workspace paths
 */
export function projectPromptsDir(projectDirectory: string): string {
  return join(projectDirectory, ENSO_RUNTIME_DIRECTORY, 'prompts')
}

/**
 * A file's text, or `undefined` when there is no file — for a file whose absence means its
 * defaults (the config). Any other failure to read it throws: a file that is there and unreadable
 * is not a missing one.
 *
 * @group Workspace paths
 */
export function readTextIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * True when the path contains any of the fragments, case-insensitively.
 *
 * ⚠ The path is compared WITH a trailing separator appended (#53 S1.2). Directory-shaped
 * fragments carry a trailing `/` (`/.aws/`, `/.ssh/`, `/.git/`) so that they match as a
 * segment and not as a name prefix — but `resolve()` strips the trailing slash a model
 * supplies, so the directory ITSELF (`/home/u/.aws`) never contained `/.aws/` and passed.
 * `grep pattern=aws_secret_access_key path=~/.aws` went through the reader gate that way.
 * Appending the separator makes the directory match its own fragment; file-shaped fragments
 * (`/.npmrc`, `/.kube/config`) are unaffected because they still occur as a substring.
 *
 * @group Guard predicates
 */
export function containsPathFragment(absolutePath: string, fragments: readonly string[]): boolean {
  const loweredWithTrailingSeparator = absolutePath.toLowerCase() + pathSeparator
  return fragments.some((fragment) => loweredWithTrailingSeparator.includes(fragment.toLowerCase()))
}

/**
 * True when the TEXT of a path-shaped string carries credential material, by directory
 * fragment or by basename.
 *
 * No filesystem access and no resolution: this is the question to ask about a shell word whose
 * value is not knowable from the text (`"$HOME/.enso/auth.json"` — the harness's
 * `shell-secret-paths.ts`), where the harness's `looksLikeSecret` realpath leg has nothing to
 * resolve. Here, not in the harness, so the command judge's script resolution (#469) asks the
 * same question the guards do.
 *
 * @group Guard predicates
 */
export function textLooksLikeSecretPath(text: string, fragments: readonly string[]): boolean {
  if (containsPathFragment(text, fragments)) return true
  return SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(basename(text)))
}
