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

import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENSO_CONFIG_FILENAME } from './config.ts'

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

/**
 * True when `directory` is the workspace root: its `package.json` parses and carries a
 * `workspaces` field of a shape npm actually accepts — an array of globs, or the object
 * form (`{ "packages": [...] }`). A `"workspaces": null` (PR #60 review) is not a root.
 * ⚠ A malformed `package.json` on the walk (a test fixture, a scratch dir) means "not
 * the root, keep walking" — never a throw.
 */
function isWorkspaceRoot(directory: string): boolean {
  const manifestPath = join(directory, 'package.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('workspaces' in manifest)) return false
    const workspaces = (manifest as Record<string, unknown>).workspaces
    return Array.isArray(workspaces) || (typeof workspaces === 'object' && workspaces !== null)
  } catch {
    return false
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
 * `ENSO_HOME` set explicitly nothing moves — the checkout's old `.enso/` is `held` and reported.
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
  return { from, to: home, moved: [], kept: [], held: existsSync(from) }
}

function moveTree(
  from: string,
  to: string,
  relativeDirectory: string,
  migration: { moved: string[]; kept: string[] },
): void {
  for (const entry of readdirSync(join(from, relativeDirectory), { withFileTypes: true })) {
    const relativePath = join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
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
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(join(directory, entry.name))
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
 * The harness package — the directory `enso.ts` hands to pi's `-e`.
 *
 * @group Workspace paths
 */
export function harnessPackageDir(repoRoot: string): string {
  return join(repoRoot, 'packages', 'harness')
}

/**
 * The web package — the cwd both dev surfaces run in.
 *
 * @group Workspace paths
 */
export function webPackageDir(repoRoot: string): string {
  return join(repoRoot, 'packages', 'web')
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
