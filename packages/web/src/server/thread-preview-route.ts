import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, sep as separator } from 'node:path'
import type { EnsoThreadPages } from '@enso/core'
import { servedCwd, type ThreadCwdDeps } from './thread-git-route.ts'

/**
 * What a thread built, reachable from the page (#619). The thread works in a tree of its own (#551),
 * not the user's checkout, so its work is not where they would look.
 *
 * `GET /api/threads/:threadId/tree` says where that is and which HTML pages it holds;
 * `GET /preview/threads/:threadId/<path>` serves one of its files, read-only.
 *
 * ⚠ A PREVIEW NEVER RUNS WITH ENSO'S AUTHORITY. The page is agent-written. The control plane trusts
 * a request whose `Origin` names loopback (`server/index.ts#fromTrustedOrigin`), so a page served
 * as Enso's own origin — or from any loopback port — could switch the thread to
 * `bypassPermissions` and drive runs. Every preview response carries `Content-Security-Policy:
 * sandbox` without `allow-same-origin`: the document gets an OPAQUE origin even as a top-level tab,
 * its requests say `Origin: null`, and the server refuses that string (#205, #160 §3). It can still
 * load its own scripts, styles and images by tag; its own `fetch()` of a file is cross-origin and
 * fails, with no CORS opened on purpose.
 *
 * ⚠ THE TREE AND NOTHING ELSE. A path's REALPATH must stay inside the tree's, so `..` and a symlink
 * out of the tree are the same 404. Looking builds nothing, and a directory this server does not
 * serve (#395) is no answer, as the git route's rule.
 */

/** The page's sandbox: scripts, forms, pointer lock and `alert` (a game's "game over") — never its own origin. */
export const PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-pointer-lock allow-modals'

/** How many pages the listing names, and how deep it looks: the work's top, not the whole tree. */
const MAX_PAGES = 50
const MAX_DEPTH = 2
/** Directories the listing never walks: a repository's own, and installed dependencies. */
const SKIPPED = new Set(['.git', 'node_modules'])
/** The largest file a preview serves: a page and its assets, not a build output. */
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

const isPage = (name: string): boolean => ['.html', '.htm'].includes(extname(name).toLowerCase())

export function createThreadPagesRoute(
  deps: ThreadCwdDeps,
): (threadId: string) => Promise<EnsoThreadPages | undefined> {
  return async (threadId: string): Promise<EnsoThreadPages | undefined> => {
    const path = await servedCwd(deps, threadId)
    if (path === undefined) return undefined
    const found = pagesIn(path)
    return { threadId, path, pages: found.slice(0, MAX_PAGES), truncated: found.length > MAX_PAGES }
  }
}

/** The pages of the tree's top `MAX_DEPTH` levels, shallowest first — and so by level, never a deep one before a shallow one. */
function pagesIn(root: string): string[] {
  const pages: string[] = []
  let level: string[] = ['']
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const { found, below } = levelOf(root, level)
    pages.push(...found)
    level = below
  }
  return pages
}

/** One level's pages, and the directories under it to walk next (never `.git` or `node_modules`). */
function levelOf(root: string, directories: readonly string[]): { found: string[]; below: string[] } {
  const found: string[] = []
  const below: string[] = []
  for (const directory of directories) {
    for (const directoryEntry of entriesOf(join(root, directory))) {
      const name = directory === '' ? directoryEntry.name : `${directory}/${directoryEntry.name}`
      if (directoryEntry.isDirectory() && !SKIPPED.has(directoryEntry.name)) below.push(name)
      else if (directoryEntry.isFile() && isPage(directoryEntry.name)) found.push(name)
    }
  }
  return { found, below }
}

function entriesOf(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).toSorted((left, right) => (left.name < right.name ? -1 : 1))
  } catch {
    return []
  }
}

/** A file the preview serves: its bytes and their type. */
export interface PreviewFile {
  readonly body: Buffer
  readonly contentType: string
}

/**
 * The file `requested` names in the thread's tree — `/`-separated, percent-encoded as the URL had it —
 * or undefined: no such thread, a directory the server does not serve, a path that leaves the tree,
 * no such file, or one too large. A directory is its `index.html`.
 */
export function createPreviewRoute(
  deps: ThreadCwdDeps,
): (threadId: string, requested: string) => Promise<PreviewFile | undefined> {
  return async (threadId: string, requested: string): Promise<PreviewFile | undefined> => {
    const tree = await servedCwd(deps, threadId)
    if (tree === undefined) return undefined
    const segments = decodedSegments(requested)
    if (segments === undefined) return undefined
    const file = fileInside(tree, join(tree, ...segments))
    if (file === undefined) return undefined
    return {
      body: readFileSync(file),
      contentType: CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    }
  }
}

/** The path's segments, decoded; undefined for one that does not decode or holds a NUL. */
function decodedSegments(requested: string): string[] | undefined {
  try {
    const segments = requested
      .split('/')
      .filter((segment) => segment.length > 0)
      .map(decodeURIComponent)
    return segments.some((segment) => segment.includes('\0')) ? undefined : segments
  } catch {
    return undefined
  }
}

/**
 * The real path of `candidate` when it is a file inside `tree`'s real path and small enough to serve
 * — a directory standing for its `index.html` — else undefined. Resolved before it is compared, so a
 * symlink is judged by where it leads.
 */
function fileInside(tree: string, candidate: string): string | undefined {
  let root: string
  let real: string
  try {
    root = realpathSync(tree)
    real = realpathSync(candidate)
  } catch {
    return undefined
  }
  const within = relative(root, real)
  if (within === '..' || within.startsWith(`..${separator}`) || isAbsolute(within)) return undefined
  const stats = statSync(real, { throwIfNoEntry: false })
  if (stats?.isDirectory() === true)
    return candidate.endsWith('index.html') ? undefined : fileInside(tree, join(real, 'index.html'))
  return stats?.isFile() === true && stats.size <= MAX_PREVIEW_BYTES ? real : undefined
}
