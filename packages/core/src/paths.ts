import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZEN_CONFIG_FILENAME } from './config.ts'

/**
 * The workspace path helpers (#59) — THE one place that walks the filesystem for roots.
 *
 * Before this module, seven call sites each computed the repo root by counting `..`
 * segments off their own `import.meta.url` — a shape that breaks silently when a file
 * moves (dev.ts carried `4×".."`). An anchor test (`no-duplicate-paths.test.ts`) now
 * refuses an eighth copy: `fileURLToPath` and inline `.zen` path assembly outside this
 * module fail the suite by name.
 *
 * ⚠ REALPATH FIRST, then walk — load-bearing, observed live (PR #58 receipts): bun does
 * NOT realpath `import.meta.url` through the `.zen/print-harness/` symlink mirror, so a
 * walk from the un-resolved module path starts inside the mirror. The mirror's entries
 * are symlinks back into the real tree, so resolving first lands the walk in the real
 * checkout; walking first would search the wrong ancestry.
 *
 * ⚠ These helpers run under node/bun only (node:fs). They are barrel-exported and the
 * browser bundle tolerates that because nothing browser-side imports them — probed
 * 2026-09-04: `bun build index.html --target=browser` tree-shakes the module out.
 */

/** Thrown when no ancestor of the start path is a workspace root. */
export class RepoRootNotFoundError extends Error {
  constructor(startPath: string) {
    super(
      `no ancestor of "${startPath}" is a workspace root (a directory whose package.json ` +
        `carries a "workspaces" field) — is this file inside the zen-harness checkout?`,
    )
    this.name = 'RepoRootNotFoundError'
  }
}

/** `realpathSync`, or the input unchanged when the path (or a segment of it) does not exist. */
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

/** True when the string is a `file://` URL rather than a filesystem path. */
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
 * this repo that is always the zen-harness checkout, never the session cwd. That
 * distinction is what `config.ts` relies on; do not "fix" this to consult `process.cwd()`.
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

/** The `.zen` runtime dir names, assembled here and nowhere else (the anchor enforces it). */
const ZEN_RUNTIME_DIRECTORY = '.zen'

/** pi's scratch agent dir — settings, extensions, auth. Shared by the TUI launcher and the web server. */
export function zenAgentDir(repoRoot: string): string {
  return join(repoRoot, ZEN_RUNTIME_DIRECTORY, 'pi-agent')
}

/**
 * The harness's secrets file (#89): `.zen/secrets.env`, NOT `.env` at the root.
 *
 * bun auto-loads `.env*` from the cwd into EVERY bun process — including a `bun -e` the model
 * runs from the repo root — so a root `.env` reaches a tool child no matter what the parent
 * scrubbed (verified with `env -i`).
 *
 * `.zen/` is git-ignored, write-protected (`ZEN_PERSISTENCE_WRITE_DIRECTORIES`) and
 * read-denied on BOTH tool routes by the `/.zen/` fragment in
 * {@link core/src!DEFAULT_GUARD_POLICY}: the reader gate for every tool carrying a path, and the
 * shell deny (#204) for a literal path word in `bash`/`powershell`. ⚠ The shell leg is a
 * bar, not a boundary — `shell-secret-paths.ts` states what a runtime-assembled name
 * still gets past.
 */
export function zenSecretsPath(repoRoot: string): string {
  return join(repoRoot, ZEN_RUNTIME_DIRECTORY, 'secrets.env')
}

/** The root `.env` — where secrets must NOT live (#89); reported as misplaced when they do. */
export function rootDotenvPath(repoRoot: string): string {
  return join(repoRoot, '.env')
}

/** Where the print variant of the harness package is materialized (#20). */
export function printHarnessDir(repoRoot: string): string {
  return join(repoRoot, ZEN_RUNTIME_DIRECTORY, 'print-harness')
}

/**
 * Where the harness's log lives (#132): `.zen/logs/zen-YYYY-MM-DD.jsonl`, ONE file per day
 * that every process appends to (dated, never renamed, so a second writer is safe — see
 * `web/server/logging.ts`).
 *
 * Under `.zen/` so bun never autoloads from it and the write gate already knows it (guard.ts).
 */
export function zenLogsDir(repoRoot: string): string {
  return join(repoRoot, ZEN_RUNTIME_DIRECTORY, 'logs')
}

/** The harness package — the directory `zen.ts` hands to pi's `-e`. */
export function harnessPackageDir(repoRoot: string): string {
  return join(repoRoot, 'packages', 'harness')
}

/** The web package — the cwd both dev surfaces run in. */
export function webPackageDir(repoRoot: string): string {
  return join(repoRoot, 'packages', 'web')
}

/** The committed config file's path under a repository root (#59): `zen.config.json`, beside `package.json`. */
export function zenConfigPath(repoRoot: string): string {
  return join(repoRoot, ZEN_CONFIG_FILENAME)
}
