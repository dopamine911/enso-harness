import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, isAbsolute, join, relative, sep as separator } from 'node:path'
import type { EnsoThreadPages } from '@enso/core'
import { isLoopbackAuthority, LOOPBACK_ONLY } from './loopback.ts'
import { servedCwd, type ThreadCwdDeps } from './thread-git-route.ts'

/**
 * What a thread built, reachable from the page (#619). The thread works in a tree of its own (#551),
 * not the user's checkout, so its work is not where they would look.
 *
 * `GET /api/threads/:threadId/tree` says where that is, which HTML pages it holds, and — once it
 * holds one — the origin its preview is served from (`previewOrigin`).
 *
 * ⚠ EACH THREAD'S PREVIEW IS AN ORIGIN OF ITS OWN (#713): a listener on a loopback port of its own,
 * serving the tree at `/`, read-only. Served under Enso's origin in a CSP sandbox (#619), the page
 * had an opaque origin, so it had no `localStorage` and a root-relative `/src/main.js` missed its
 * sub-path: measured, both apps two arena runs built showed broken in Preview and ran anywhere
 * else. Its own origin is a browser's own isolation. ⚠ Safe only because Enso trusts no other
 * loopback origin (#717: a browser's request must be `Sec-Fetch-Site: same-origin`), so the page
 * can no more drive Enso than any other site; and its storage is its thread's, not shared.
 *
 * ⚠ THE TREE AND NOTHING ELSE. A path's REALPATH must stay inside the tree's, so `..` and a symlink
 * out of the tree are the same 404. Looking builds nothing, and a directory this server does not
 * serve (#395) is no answer, as the git route's rule. `Host` must name loopback (a rebound name is
 * not), and only GET and HEAD are served.
 */

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

/** Each thread's preview origin (#713): started on first ask, closed with the server. */
export interface PreviewOrigins {
  /** `http://127.0.0.1:<port>`, serving `threadId`'s tree at `/`; the same origin each time. */
  readonly originOf: (threadId: string) => Promise<string>
  readonly close: () => Promise<void>
}

/** What every preview answer carries: no sniffing, no referrer out, never a stale copy of a file the agent rewrote. */
const PREVIEW_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const

/** One thread's files at `/` (#713): its tree, as `previewFile` reads it, to a loopback Host and GET/HEAD only. */
async function answerPreview(
  previewFile: ReturnType<typeof createPreviewRoute>,
  threadId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.headers.host === undefined || !isLoopbackAuthority(request.headers.host)) {
    response.writeHead(403, { ...PREVIEW_HEADERS, 'Content-Type': 'text/plain' })
    response.end('a preview answers the machine it runs on')
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...PREVIEW_HEADERS, Allow: 'GET, HEAD', 'Content-Type': 'text/plain' })
    response.end('a preview is read-only')
    return
  }
  const path = (request.url ?? '/').split(/[?#]/)[0] ?? '/'
  const file = await previewFile(threadId, path)
  if (file === undefined) {
    response.writeHead(404, { ...PREVIEW_HEADERS, 'Content-Type': 'text/plain' })
    response.end(`no such file in thread ${threadId}'s tree`)
    return
  }
  response.writeHead(200, { ...PREVIEW_HEADERS, 'Content-Type': file.contentType, 'Content-Length': file.body.length })
  response.end(request.method === 'HEAD' ? undefined : file.body)
}

/**
 * One loopback listener per thread previewed (#713), on a port the system picks: each thread's page
 * is an origin of its own, at `/`, with storage of its own. Started the first time the thread's
 * origin is asked for, and kept until `close`.
 */
export function createPreviewOrigins(previewFile: ReturnType<typeof createPreviewRoute>): PreviewOrigins {
  const listeners = new Map<string, { readonly server: Server; readonly origin: Promise<string> }>()
  const start = (threadId: string): Promise<string> => {
    const server = createServer((request, response) => {
      answerPreview(previewFile, threadId, request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { ...PREVIEW_HEADERS, 'Content-Type': 'text/plain' })
        response.end('the preview failed to read the file')
      })
    })
    const origin = new Promise<string>((resolve, reject) => {
      // A listener that could not start (no port, no file descriptor) is forgotten, so the thread's
      // next tree read tries again rather than answering this failure for the server's life (PR #719 review).
      server.once('error', (error) => {
        if (listeners.get(threadId)?.server === server) listeners.delete(threadId)
        reject(error)
      })
      server.listen(0, LOOPBACK_ONLY, () =>
        resolve(`http://${LOOPBACK_ONLY}:${(server.address() as AddressInfo).port}`),
      )
    })
    listeners.set(threadId, { server, origin })
    return origin
  }
  return {
    originOf: (threadId) => listeners.get(threadId)?.origin ?? start(threadId),
    close: async () => {
      await Promise.all(
        [...listeners.values()].map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))),
      )
      listeners.clear()
    },
  }
}
