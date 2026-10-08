import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { redactJudgeText } from '@enso/core/judge'
import { ensoProjectsDir, projectIdOf, projectSnapshotsDir, realpathOrSelf } from '@enso/core/paths'
import type { ArenaEvidence } from './manifest.ts'
import type { ArenaEvent } from './timeline.ts'

/**
 * Enso's side of an arena run's evidence (#556), collected when the run stops: what the server
 * says about each thread the UI was in or the project holds — its record, events, session eval
 * and log bundle — the day's Stats, and the project's snapshot store. Every read goes to the routes the debug drawer and `bun scripts/enso-thread.ts`
 * read — the agent never does; the RECORDER does, after the agent is done.
 *
 * ⚠ MISSING IS RECORDED, NEVER SKIPPED. A server that is down, a route that answers 404, a store
 * that does not exist yet (#551 slice 1 writes snapshots; the Diff Viewer data is a later slice)
 * each become a `missing` row naming why, so a findings report can say "no record" rather than
 * read silence as "nothing happened". ⚠ Two threads have NOTHING to collect, and say so in one
 * `skipped` row each instead of eleven `missing` ones (#671): a thread the run DELETED (its history
 * answers 410 Gone), and one that NEVER RAN (no session: its history answers 404, and the project
 * stores no such thread — the fresh thread Enso opens after a delete, #571). A thread that ran and
 * still exists is read in full, and every route that fails for it is still `missing`.
 *
 * ⚠ THE DISK SIDE DOES NOT WAIT FOR THE SERVER (#584 A1, #607). A run that ends with Enso down is
 * the run whose evidence matters most, so `serverDown` turns every route into its own `missing`
 * row and the rows read from disk are still made. The snapshot store is COPIED into the run (A3):
 * a path into the home breaks when the store is pruned or the home deleted. The copy is the
 * store's bytes, unredacted, like the run's own `project/`: what the agent wrote is the evidence.
 *
 * ⚠ REDACTED ON THE WAY TO DISK. A transcript can quote a key the agent pasted; every body is put
 * through the judge's redactor with the run's known secret values before it is written.
 */

/** Where to read from and write to, and what to redact. */
export interface ArenaEvidenceSources {
  /** The Enso server's origin: `http://127.0.0.1:5179`. */
  readonly serverOrigin: string
  /** The directory the evidence files are written into. */
  readonly directory: string
  /** Threads the UI named during the run, from the timeline. */
  readonly threadIds: readonly string[]
  /** The Enso home the stack ran over, and the project folder it served. */
  readonly home: string
  readonly project: string
  readonly secretValues: readonly string[]
  /**
   * Why the server cannot be asked, when it cannot: Enso was not running at the stop, or the
   * recorder died and its stack with it. Every route is then a `missing` row with this reason,
   * nothing is fetched, and only the URL's threads are known (the project's list is a route).
   */
  readonly serverDown?: string
  /** `fetch`, or a test's stand-in. */
  readonly fetchText?: (url: string) => Promise<{ readonly status: number; readonly text: string }>
  /** `linkSync`, or a test's stand-in: how the snapshot store's files are linked into the run (#740). */
  readonly linkFile?: (source: string, destination: string) => void
}

async function defaultFetchText(url: string): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  return { status: response.status, text: await response.text() }
}

/** Every piece of Enso-side evidence for the run: one row each, collected, missing, or skipped (#671). */
export async function collectEnsoEvidence(sources: ArenaEvidenceSources): Promise<ArenaEvidence[]> {
  mkdirSync(sources.directory, { recursive: true })
  const fetchText = sources.fetchText ?? defaultFetchText
  const rows: ArenaEvidence[] = []
  /**
   * Each route asked once (PR #673 review): the history probe below and the thread's history read
   * are the same GET, and its answer — or its failure — serves both.
   */
  const answers = new Map<string, Promise<{ readonly status: number; readonly text: string }>>()
  const ask = (route: string): Promise<{ readonly status: number; readonly text: string }> => {
    const known = answers.get(route)
    if (known !== undefined) return known
    const asked = fetchText(`${sources.serverOrigin}${route}`)
    answers.set(route, asked)
    return asked
  }

  /** Save one route's body, redacted, and say so in a row. Returns the body saved, or undefined. */
  const save = async (kind: string, route: string, fileName: string): Promise<string | undefined> => {
    if (sources.serverDown !== undefined) {
      rows.push({ kind, status: 'missing', reason: sources.serverDown })
      return undefined
    }
    let answer: { readonly status: number; readonly text: string }
    try {
      answer = await ask(route)
    } catch (error) {
      rows.push({ kind, status: 'missing', reason: `GET ${route} failed: ${String(error)}` })
      return undefined
    }
    if (answer.status !== 200) {
      rows.push({ kind, status: 'missing', reason: `GET ${route} answered ${answer.status}` })
      return undefined
    }
    const path = join(sources.directory, fileName)
    const body = redactJudgeText(answer.text, sources.secretValues)
    writeFileSync(path, body)
    rows.push({ kind, status: 'collected', path })
    return body
  }

  /**
   * Why a thread has nothing to collect (#671), or undefined when it is read in full: deleted during
   * the run (its history answers 410), or never run (404, and the project stores no such thread). A
   * down server, a failed probe or any other answer reads the thread in full, so a failure is a row.
   */
  const threadWithNothing = async (
    threadId: string,
    id: string,
    storedIds: ReadonlySet<string>,
  ): Promise<string | undefined> => {
    if (sources.serverDown !== undefined) return undefined
    const route = `/api/threads/${id}/history`
    const answer = await ask(route).catch(() => undefined)
    if (answer?.status === 410) return `deleted during the run: GET ${route} answered 410`
    if (answer?.status === 404 && !storedIds.has(threadId)) {
      return `never ran: GET ${route} answered 404, and the project stores no such thread`
    }
    return undefined
  }

  await save('live threads', '/api/threads', 'threads.json')
  const storedThreads = await save('stored threads', '/api/stored-threads', 'stored-threads.json')
  await save('stats', '/api/logs/stats', 'stats.json')
  await save('about', '/api/about', 'about.json')
  await save('thread trees', '/api/trees', 'trees.json')
  // ⚠ The run's project's threads too, not only the ones the URL named (#584): a thread the UI
  // never showed is exactly the one the score must look at — prompted some other way, or a fork.
  const storedIds = new Set(
    (projectThreads(storedThreads, projectIdOf(realpathOrSelf(sources.project))) ?? []).map(
      (thread) => thread.threadId,
    ),
  )
  const threadIds = [...new Set([...sources.threadIds, ...storedIds])]
  for (const threadId of threadIds) {
    const id = encodeURIComponent(threadId)
    const nothingToCollect = await threadWithNothing(threadId, id, storedIds)
    if (nothingToCollect !== undefined) {
      rows.push({ kind: `thread ${threadId}`, status: 'skipped', reason: nothingToCollect })
      continue
    }
    for (const read of THREAD_READS) {
      const fileName = `thread-${threadId}${read.suffix === '' ? '' : `-${read.suffix}`}.${read.extension}`
      const label = read.suffix === '' ? `thread ${threadId}` : `thread ${threadId} ${read.label}`
      await save(label, read.route(id), fileName)
    }
  }
  if (threadIds.length === 0) {
    rows.push({ kind: 'threads', status: 'missing', reason: 'no thread was named by the UI or stored for the project' })
  }

  rows.push(
    snapshotStoreRow(
      sources.home,
      sources.project,
      join(sources.directory, 'snapshot-store'),
      sources.linkFile ?? linkSync,
    ),
  )
  rows.push({
    kind: 'diff viewer',
    status: 'missing',
    reason: 'not collected by this bench yet: the Diff Viewer has no read route for a run (#551, #553)',
  })
  return rows
}

interface ArenaThreadRead {
  readonly label: string
  readonly suffix: string
  readonly extension: 'json' | 'md'
  readonly route: (id: string) => string
}

/** A thread's JSON read at `/api/threads/<id>/<suffix>`: most of what the server has for one thread. */
const threadJson = (label: string, suffix: string): ArenaThreadRead => ({
  label,
  suffix,
  extension: 'json',
  route: (id) => `/api/threads/${id}/${suffix}`,
})

/**
 * What the stop reads for each thread (#584 A2, #608): every read route the server has for one
 * thread, each saved beside the others as `thread-<id>-<suffix>.<extension>`. The record, events,
 * eval and log bundle were the first four (#562, #585); the rest are what Enso already served and
 * the bench did not keep — the transcript, the analysis, the context, the incidents, the judge's
 * cases, the run conditions, git and the changes. Each is a row: collected, or missing with why.
 * The empty suffix is the thread's own record (`thread-<id>.json`), which the score reads by that
 * exact name.
 */
const THREAD_READS: readonly ArenaThreadRead[] = [
  { label: 'record', suffix: '', extension: 'json', route: (id) => `/api/threads/${id}` },
  threadJson('events', 'events'),
  threadJson('eval', 'eval'),
  { label: 'log bundle', suffix: 'bundle', extension: 'md', route: (id) => `/api/logs/bundle?thread=${id}` },
  threadJson('history', 'history'),
  threadJson('stats', 'stats'),
  threadJson('context', 'context'),
  threadJson('incidents', 'incidents'),
  threadJson('judge cases', 'judge-cases'),
  threadJson('manifest', 'manifest'),
  threadJson('git', 'git'),
  threadJson('changes', 'changes'),
]

/** One stored thread of the run's project, as `GET /api/stored-threads` lists it: what the score reads. */
export interface ArenaProjectThread {
  readonly threadId: string
  readonly messageCount: number
  readonly parentThreadId?: string
}

function projectThreadOf(listed: unknown, projectId: string): ArenaProjectThread | undefined {
  if (typeof listed !== 'object' || listed === null) return undefined
  if (!('projectId' in listed) || listed.projectId !== projectId) return undefined
  if (!('threadId' in listed) || typeof listed.threadId !== 'string') return undefined
  const messageCount = 'messageCount' in listed && typeof listed.messageCount === 'number' ? listed.messageCount : 0
  const parent =
    'parentThreadId' in listed && typeof listed.parentThreadId === 'string' ? listed.parentThreadId : undefined
  return { threadId: listed.threadId, messageCount, ...(parent === undefined ? {} : { parentThreadId: parent }) }
}

/**
 * The stored threads (`GET /api/stored-threads`) that belong to one project, as listed; undefined
 * when the body is not a list — unknown, never "no threads".
 */
export function projectThreads(
  storedThreadsBody: string | undefined,
  projectId: string,
): ArenaProjectThread[] | undefined {
  if (storedThreadsBody === undefined) return undefined
  let listed: unknown
  try {
    listed = JSON.parse(storedThreadsBody)
  } catch {
    return undefined
  }
  if (!Array.isArray(listed)) return undefined
  return listed.flatMap((listedThread: unknown) => {
    const thread = projectThreadOf(listedThread, projectId)
    return thread === undefined ? [] : [thread]
  })
}

/**
 * The project's snapshot store (#551), kept under `copy` so the run keeps it: its row, or why there is
 * none. Collecting it hard-links each file and copies only where linking can't (#740); either failing,
 * or reading the store failing, is a `missing` row naming the store and the error.
 */
function snapshotStoreRow(
  home: string,
  project: string,
  copy: string,
  linkFile: (source: string, destination: string) => void,
): ArenaEvidence {
  const directory = projectSnapshotsDir(ensoProjectsDir(home), projectIdOf(realpathOrSelf(project)))
  if (!existsSync(directory)) {
    return { kind: 'snapshot store', status: 'missing', reason: `no snapshot store at ${directory}` }
  }
  if (readdirSync(directory).length === 0) {
    return { kind: 'snapshot store', status: 'missing', reason: `the snapshot store at ${directory} holds no thread` }
  }
  try {
    linkTreeWithoutChmod(directory, copy, linkFile)
  } catch (error) {
    return {
      kind: 'snapshot store',
      status: 'missing',
      reason: `${directory} could not be collected: ${String(error)}`,
    }
  }
  return { kind: 'snapshot store', status: 'collected', path: copy }
}

/**
 * `directory` kept under `copy`, files, directories and symlinks, without `cpSync`'s chmod after
 * each file (#676): git keeps its objects read-only, and on Docker Desktop's file sharing a chmod of
 * a read-only file fails with EACCES even for its owner — every containerized run lost its snapshot
 * store.
 *
 * A FILE IS HARD-LINKED, NOT COPIED (#740): the store's files are written once and never changed, so
 * a link is the same bytes and mode at no cost (33 MB of copies across 80 runs), and it outlives the
 * home's store as a copy does. Where a link cannot be made — another filesystem (EXDEV), or one that
 * refuses links (EPERM) — the file is copied; `copyFileSync` keeps the mode by itself.
 */
function linkTreeWithoutChmod(
  directory: string,
  copy: string,
  linkFile: (source: string, destination: string) => void,
): void {
  mkdirSync(copy, { recursive: true })
  for (const storeEntry of readdirSync(directory, { withFileTypes: true })) {
    const source = join(directory, storeEntry.name)
    const destination = join(copy, storeEntry.name)
    if (storeEntry.isDirectory()) linkTreeWithoutChmod(source, destination, linkFile)
    // Verbatim, not resolved (cpSync made a relative target absolute — into the HOME's store, so the
    // copy broke once the home was pruned, which is what #607 copies the store to survive).
    else if (storeEntry.isSymbolicLink()) symlinkSync(readlinkSync(source), destination)
    else if (storeEntry.isFile()) linkOrCopy(source, destination, linkFile)
    // A socket, FIFO or device is not a snapshot: a failed copy, recorded as missing, never a gap.
    else throw new Error(`${source} is not a file, directory or symlink`)
  }
}

/** A hard link, or a copy where the filesystem will not link (EXDEV, EPERM). Any other failure is the copy's. */
function linkOrCopy(
  source: string,
  destination: string,
  linkFile: (source: string, destination: string) => void,
): void {
  try {
    linkFile(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EPERM') throw error
    copyFileSync(source, destination)
  }
}

/** The thread ids the UI named during a run (`?thread=`), in the order first shown. */
export function threadIdsShown(events: readonly ArenaEvent[]): string[] {
  return [...new Set(events.flatMap((event) => (event.page?.threadId === undefined ? [] : [event.page.threadId])))]
}
