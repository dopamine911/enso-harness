import { existsSync, readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { buildLogBundle, isZenThreadId, type ZenBundleAbout, type ZenLogLine } from '@zen/core'
import { parseZenLogLine, zenLogFilename } from '@zen/core/log-process'
import { findRepoRoot } from '@zen/core/paths'
import { inspectThread, type ThreadView } from './thread-registry.ts'

/**
 * `GET /api/logs/bundle[?thread=<id or prefix>]` (#132 item 5): the day's records, the live
 * threads' inspections, and the versions, as ONE markdown file with the records fenced as
 * JSONL — `bun run logs --file` reads it back. The browser appends its own ring before the
 * download (`thread-debug.tsx`); the server never sees the page's records except the ones
 * it already shipped (#137).
 *
 * The selection is today's file: the one the rotation names by the local day, the one
 * `bun run logs` reads. A thread that spans midnight has yesterday's half in yesterday's
 * file — said in `about.selection`, not silently missing.
 */

/**
 * The most records a bundle carries — the newest. A day at `trace` is tens of thousands of
 * lines; a bundle a user attaches to an issue should open in a browser tab. The heading says
 * "the last N of M" so the cut is visible.
 */
export const BUNDLE_MAX_RECORDS = 5000

export interface BundleRouteDeps {
  readonly threads: { list(): ThreadView[] }
  /** Where this process's file is — the launcher's `logsDir`, passed down so the route reads what was written. */
  readonly logsDir: string
  /** The agent runtime's version, from the host — the vendor gate (#145) keeps pi's import there. */
  readonly runtimeVersion: string
  /** Test seam: the day, and the clock. */
  readonly now?: () => Date
}

export type BundleRouteOutcome =
  | { readonly status: 200; readonly filename: string; readonly body: string }
  /** A `thread` that is not thread-id shaped: refused before it reaches a filter, a filename, or a header. */
  | { readonly status: 400; readonly reason: string }

/** The checkout's commit, from `.git` by hand — no shell from a server. `unknown` when there is no checkout. */
export function describeCheckout(repoRoot: string): string {
  const headPath = join(repoRoot, '.git', 'HEAD')
  if (!existsSync(headPath)) return 'unknown (no .git)'
  const head = readFileSync(headPath, 'utf8').trim()
  if (!head.startsWith('ref: ')) return head.slice(0, 12)
  const ref = head.slice('ref: '.length)
  const refPath = join(repoRoot, '.git', ref)
  if (existsSync(refPath))
    return `${readFileSync(refPath, 'utf8').trim().slice(0, 12)} (${ref.replace('refs/heads/', '')})`
  const packed = join(repoRoot, '.git', 'packed-refs')
  if (existsSync(packed)) {
    const row = readFileSync(packed, 'utf8')
      .split('\n')
      .find((line) => line.endsWith(` ${ref}`))
    if (row !== undefined) return `${row.slice(0, 12)} (${ref.replace('refs/heads/', '')})`
  }
  return `unknown (${ref})`
}

/** The day's records that match, oldest first — and how many lines were not records at all. */
function selectRecords(
  text: string,
  threadPrefix: string | undefined,
): { readonly lines: ZenLogLine[]; readonly malformed: number } {
  const lines: ZenLogLine[] = []
  let malformed = 0
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue
    const parsed = parseZenLogLine(raw)
    if (typeof parsed === 'string') {
      malformed += 1
      continue
    }
    if (threadPrefix !== undefined && !String(parsed.properties?.threadId ?? '').startsWith(threadPrefix)) continue
    lines.push(parsed)
  }
  return { lines, malformed }
}

/**
 * The checkout, read once per process (PR #151 review): both routes are built at startup and
 * `.git/HEAD` — plus `packed-refs` on a packed branch — does not change under a running server.
 */
let checkoutOnce: string | undefined
function thisCheckout(): string {
  checkoutOnce ??= describeCheckout(findRepoRoot(import.meta.url))
  return checkoutOnce
}

export function createBundleRoute(deps: BundleRouteDeps): (query: URLSearchParams) => BundleRouteOutcome {
  const zen = thisCheckout()
  const now = deps.now ?? ((): Date => new Date())
  return (query: URLSearchParams): BundleRouteOutcome => {
    const at = now()
    const threadParameter = query.get('thread')
    const threadPrefix = threadParameter === null || threadParameter.length === 0 ? undefined : threadParameter
    // The third entry point a thread id crosses (#95 named the other two). A PREFIX of a valid
    // id is itself a valid id, so the one check covers both — and it is what keeps the value
    // out of the `Content-Disposition` header: a `"` would end the filename, a CR/LF would
    // throw inside the request callback (PR #138 review).
    if (threadPrefix !== undefined && !isZenThreadId(threadPrefix)) {
      return { status: 400, reason: 'thread must be a thread id or a prefix of one' }
    }
    const file = join(deps.logsDir, zenLogFilename(at))
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const { lines, malformed } = selectRecords(text, threadPrefix)
    const threads = deps.threads
      .list()
      .filter((view) => threadPrefix === undefined || view.threadId.startsWith(threadPrefix))
      .map(inspectThread)
    const selection = [
      threadPrefix === undefined ? 'every thread' : `thread ${threadPrefix}`,
      `from today's file (${zenLogFilename(at)}, the local day — an earlier day is an earlier file)`,
      existsSync(file) ? '' : '— which does not exist yet: no process has logged today',
      malformed === 0 ? '' : `— ${malformed} line(s) of it were not records and are left out`,
    ]
      .filter((part) => part.length > 0)
      .join(' ')
    const about = describeAbout({ zen, runtimeVersion: deps.runtimeVersion, at, selection })
    const body = buildLogBundle({
      about,
      threads,
      lines: lines.slice(-BUNDLE_MAX_RECORDS),
      matched: lines.length,
    })
    const day = zenLogFilename(at).slice('zen-'.length, -'.jsonl'.length)
    const filename =
      threadPrefix === undefined ? `zen-bundle-${day}.md` : `zen-bundle-${day}-${threadPrefix.slice(0, 8)}.md`
    return { status: 200, filename, body }
  }
}

/**
 * The one `about` builder (#144): the bundle carries it in its header and `GET /api/about`
 * answers with it, so a dashboard and a handed-over bundle cannot disagree about which
 * checkout, which runtime, which machine.
 */
function describeAbout(input: {
  readonly zen: string
  readonly runtimeVersion: string
  readonly at: Date
  readonly selection: string
}): ZenBundleAbout {
  return {
    at: input.at.toISOString(),
    zen: input.zen,
    pi: input.runtimeVersion,
    bun: typeof Bun === 'undefined' ? 'not bun' : Bun.version,
    os: `${platform()} ${release()} ${arch()}`,
    selection: input.selection,
  }
}

/**
 * `GET /api/about` — versions and checkout, as JSON, for a debugging surface that wants the
 * header without downloading the day (#144). Reads nothing but this process's own facts,
 * builds nothing, and — like `POST /api/logs` — writes no record: an observation surface
 * must not appear in the trace it is reading (#97).
 */
export function createAboutRoute(deps: {
  readonly runtimeVersion: string
  readonly now?: () => Date
}): () => ZenBundleAbout {
  const zen = thisCheckout()
  const now = deps.now ?? ((): Date => new Date())
  return (): ZenBundleAbout =>
    describeAbout({
      zen,
      runtimeVersion: deps.runtimeVersion,
      at: now(),
      selection: "no records: this is the bundle's header alone, for this process, now",
    })
}
