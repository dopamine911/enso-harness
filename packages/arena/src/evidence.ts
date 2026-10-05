import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactJudgeText } from '@enso/core/judge'
import { ensoProjectsDir, projectIdOf, projectSnapshotsDir, realpathOrSelf } from '@enso/core/paths'
import type { ArenaEvidence } from './manifest.ts'

/**
 * Enso's side of an arena run's evidence (#556), collected when the run stops: what the server
 * says about each thread the UI was in or the project holds — its record, events, session eval
 * and log bundle — the day's Stats, and the project's snapshot store. Every read goes to the routes the debug drawer and `bun scripts/enso-thread.ts`
 * read — the agent never does; the RECORDER does, after the agent is done.
 *
 * ⚠ MISSING IS RECORDED, NEVER SKIPPED. A server that is down, a route that answers 404, a store
 * that does not exist yet (#551 slice 1 writes snapshots; the Diff Viewer data is a later slice)
 * each become a `missing` row naming why, so a findings report can say "no record" rather than
 * read silence as "nothing happened".
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
  /** `fetch`, or a test's stand-in. */
  readonly fetchText?: (url: string) => Promise<{ readonly status: number; readonly text: string }>
}

async function defaultFetchText(url: string): Promise<{ readonly status: number; readonly text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  return { status: response.status, text: await response.text() }
}

/** Every piece of Enso-side evidence for the run: one row each, collected or missing. */
export async function collectEnsoEvidence(sources: ArenaEvidenceSources): Promise<ArenaEvidence[]> {
  mkdirSync(sources.directory, { recursive: true })
  const fetchText = sources.fetchText ?? defaultFetchText
  const rows: ArenaEvidence[] = []

  /** Save one route's body, redacted, and say so in a row. Returns the body saved, or undefined. */
  const save = async (kind: string, route: string, fileName: string): Promise<string | undefined> => {
    let answer: { readonly status: number; readonly text: string }
    try {
      answer = await fetchText(`${sources.serverOrigin}${route}`)
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

  await save('live threads', '/api/threads', 'threads.json')
  const storedThreads = await save('stored threads', '/api/stored-threads', 'stored-threads.json')
  await save('stats', '/api/logs/stats', 'stats.json')
  await save('about', '/api/about', 'about.json')
  // ⚠ The run's project's threads too, not only the ones the URL named (#584): a thread the UI
  // never showed is exactly the one the score must look at — prompted some other way, or a fork.
  const threadIds = [
    ...new Set([
      ...sources.threadIds,
      ...(projectThreads(storedThreads, projectIdOf(realpathOrSelf(sources.project))) ?? []).map(
        (thread) => thread.threadId,
      ),
    ]),
  ]
  for (const threadId of threadIds) {
    const id = encodeURIComponent(threadId)
    await save(`thread ${threadId}`, `/api/threads/${id}`, `thread-${threadId}.json`)
    await save(`thread ${threadId} events`, `/api/threads/${id}/events`, `thread-${threadId}-events.json`)
    await save(`thread ${threadId} eval`, `/api/threads/${id}/eval`, `thread-${threadId}-eval.json`)
    await save(`thread ${threadId} log bundle`, `/api/logs/bundle?thread=${id}`, `thread-${threadId}-bundle.md`)
  }
  if (threadIds.length === 0) {
    rows.push({ kind: 'threads', status: 'missing', reason: 'no thread was named by the UI or stored for the project' })
  }

  rows.push(snapshotStoreRow(sources.home, sources.project))
  rows.push({
    kind: 'diff viewer',
    status: 'missing',
    reason: 'not collected by this bench yet: the Diff Viewer has no read route for a run (#551, #553)',
  })
  return rows
}

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

/** The project's snapshot store (#551): where it is and which threads it holds, or why there is none. */
function snapshotStoreRow(home: string, project: string): ArenaEvidence {
  const directory = projectSnapshotsDir(ensoProjectsDir(home), projectIdOf(realpathOrSelf(project)))
  if (!existsSync(directory)) {
    return { kind: 'snapshot store', status: 'missing', reason: `no snapshot store at ${directory}` }
  }
  const threads = readdirSync(directory)
  return threads.length === 0
    ? { kind: 'snapshot store', status: 'missing', reason: `the snapshot store at ${directory} holds no thread` }
    : { kind: 'snapshot store', status: 'collected', path: directory }
}
