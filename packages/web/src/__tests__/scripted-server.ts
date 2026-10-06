import type {
  EnsoFollowFrame,
  EnsoFollowSnapshot,
  EnsoGitFileChange,
  EnsoGitState,
  EnsoProject,
  EnsoSessionEval,
  EnsoStoredThread,
  EnsoThreadDeletePreview,
  EnsoThreadEvents,
  EnsoThreadHistory,
  EnsoThreadInspection,
  EnsoThreadStats,
  EnsoTreesListing,
  RuntimeCommand,
} from '@enso/core'
import { NO_SESSION_INCIDENTS } from '@enso/core'

/**
 * A scripted server behind `fetch` (#112, #118): one follow body the test writes SSE frames
 * into, and unary routes the test scripts the answers of. Everything the browser's transport
 * touches — `/follow`, `/prompt`, `/dialog`, `/abort` — plus the page's own reads: `/api/mode`
 * (the composer's mode control seeds from it), `/api/stored-threads` (the rail's Previous
 * Sessions) and `/api/threads/:id/history` (a resume click). Shared by the adapter tests (`follow-connection.test.ts`,
 * which subscribe the adapter directly) and the mounted-pane tests (`thread-pane.test.tsx`,
 * which hand this `fetch` to `mintThread` and read the DOM).
 */
export interface ScriptedFetch {
  readonly fetch: typeof fetch
  /** Write one frame onto the open follow. */
  readonly frame: (frame: EnsoFollowFrame) => void
  /** End the follow body — the server went away. */
  readonly closeFollow: () => void
  readonly prompts: Array<{ message: string; admission?: string; images?: unknown[] }>
  /** Every body `POST …/dialog` received — a second answer for the same id included (#275). */
  readonly dialogs: unknown[]
  /** Every body `POST …/mode` received (L3 step C). */
  readonly modeChanges: unknown[]
  /** Every body `POST …/command` received (#338 slice 2) — a host command's `{ name, value? }`. */
  readonly hostCommands: unknown[]
  /** How many `POST …/abort` the server saw (#116). */
  readonly abortCount: () => number
  /** Every `DELETE /api/threads/:id` the server saw (#571), as path and query: `?force=1` included. */
  readonly deletes: string[]
  /** Each delete's `If-Match` header (#571), in step with `deletes`; `null` when it carried none. */
  readonly deleteTags: (string | null)[]
  /** Every `GET /api/threads/:id/delete-preview` path the server saw (#571). */
  readonly previewReads: string[]
  /** Every `GET /api/trees` the server saw (#578). */
  readonly treeReads: string[]
  /** Every `GET /api/threads/:id/git` the server saw (#620): a thread with no session must ask none. */
  readonly gitReads: string[]
  /** Hold the next prompt's answer; returns the release. */
  readonly holdPrompt: () => () => void
  /** Hold every later delete's answer (#571) — the server has it, and has not answered; returns the release. */
  readonly holdDelete: () => () => void
}

export interface ScriptedFetchOptions {
  readonly promptStatus?: { status: number; body: unknown }
  /**
   * What the FIRST answer to a question gets; 204 by default. A 204 SPENDS the question, as
   * the real route does — a later answer for that id is then 404 with the server's own reason
   * (`follow.ts` `answerThreadDialog`). A non-204 script leaves the question open, so a
   * refused or unreachable answer can be repeated the way the page allows it to be.
   */
  readonly dialogStatus?: number
  /**
   * The dialog request never reaches a server: the `fetch` REJECTS, as a dropped connection
   * does, which is the page's `unreachable` (`follow-connection.ts#answerDialog`). Distinct
   * from `dialogStatus`, which is an answer — this is the absence of one, and the question is
   * as open afterwards as it was before.
   */
  readonly dialogUnreachable?: boolean
  readonly abortStatus?: number
  /** What `POST …/mode` answers; 204 by default. */
  readonly modeStatus?: number
  /** What `POST …/command` answers; 204 by default. A non-204 carries `commandBody` (the host's reason) as its text. */
  readonly commandStatus?: number
  readonly commandBody?: string
  /** What the stop hands back (#75): the prompts pi had queued. Answered with the 200 receipt. */
  readonly queued?: string[]
  readonly mode?: { mode: string; available: string[] }
  /** What `GET /api/stored-threads` lists — the rail's earlier threads (#95). */
  readonly storedThreads?: EnsoStoredThread[]
  /** What `GET /api/projects` lists (#395); the launch project alone, `p-launch`, when absent. */
  readonly projects?: EnsoProject[]
  /** What `GET /api/threads/:id/history` answers for a resume click; keyed by thread id. */
  readonly histories?: Record<string, EnsoThreadHistory>
  /**
   * What the debug pane's two reads answer — `GET /api/threads/:id` and `…/events` (#86). One
   * inspection for every thread id (the pane compares it with the page's belief, so a test
   * scripts the disagreement it wants); 404 when absent, the pane's "no live session yet".
   */
  readonly inspection?: Omit<EnsoThreadInspection, 'threadId' | 'sessionId'>
  readonly events?: Omit<EnsoThreadEvents, 'threadId'>
  /** The `/` palette's list (#338); `source: 'live'`. Absent: a live thread registering nothing. */
  readonly commands?: readonly RuntimeCommand[]
  /** What the stats drawer's read answers (#45 phase 2); 404 when absent, the drawer's "no stats". */
  readonly stats?: Omit<EnsoThreadStats, 'threadId'>
  /** What the eval panel's read answers (#441); 404 when absent, the panel's "no eval". */
  readonly eval?: Omit<EnsoSessionEval, 'threadId'>
  /**
   * What the status bar's git read answers (#453), asked per read so a test can move the tree
   * between two; 404 when absent, a thread nothing has run in.
   */
  readonly git?: () => EnsoGitState
  /** What the Diff view's read answers (#452), asked per read; 404 when absent. */
  readonly changes?: () => { git: EnsoGitState; files: EnsoGitFileChange[]; truncated: boolean }
  /**
   * What each `DELETE /api/threads/:id` answers (#571), in turn; the last one repeats, and 204
   * when absent. A 204 takes the thread out of `storedThreads`, as deleting its session file does.
   */
  readonly deleteAnswers?: readonly { readonly status: number; readonly reason?: string }[]
  /**
   * What `GET /api/threads/:id/delete-preview` answers (#571): a preview, or a refusal's status and
   * words. Absent: a thread in the checkout, nothing held, no forks.
   */
  readonly deletePreview?: EnsoThreadDeletePreview | { readonly status: number; readonly reason: string }
  /**
   * What `GET /api/trees` answers (#578), asked per read so a delete can move the listing on; no
   * projects when absent.
   */
  readonly trees?: () => EnsoTreesListing | { readonly status: number; readonly reason: string }
}

/** The launch project a scripted server lists by default — the id the fixtures' stored threads carry. */
const SCRIPTED_LAUNCH_PROJECT: EnsoProject = {
  projectId: 'p-launch',
  title: 'launch',
  path: '/scripted/launch',
  status: 'ok',
  launch: true,
}

/** The URL a `fetch` was asked for, whichever of its three forms the caller handed it. */
export function requestedUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** A scripted route's posted body, parsed: the page posts JSON text, so anything else is a test bug. */
function postedJson(init: RequestInit | undefined): unknown {
  const body = init?.body
  if (typeof body !== 'string') throw new Error(`expected a JSON text body, got ${typeof body}`)
  return JSON.parse(body)
}

export function createScriptedFetch(options: ScriptedFetchOptions = {}): ScriptedFetch {
  const promptStatus = options.promptStatus ?? {
    status: 202,
    body: { threadId: 't1', messageId: 'pm1', generation: 1, queued: false },
  }
  const dialogStatus = options.dialogStatus ?? 204
  const abortStatus = options.abortStatus ?? 200
  const modeStatus = options.modeStatus ?? 204
  const commandStatus = options.commandStatus ?? 204
  const mode = options.mode ?? { mode: 'default', available: ['default', 'plan'] }
  let aborts = 0
  let write: (text: string) => void = () => undefined
  let close: () => void = () => undefined
  /** The prompt route answers only once this resolves — open by default; a test may hold it. */
  let promptGate = { promise: Promise.resolve() } as { promise: Promise<void>; resolve?: () => void }
  const prompts: Array<{ message: string; admission?: string; images?: unknown[] }> = []
  const dialogs: unknown[] = []
  const modeChanges: unknown[] = []
  const hostCommands: unknown[] = []
  const deletes: string[] = []
  const deleteTags: (string | null)[] = []
  const previewReads: string[] = []
  const treeReads: string[] = []
  const gitReads: string[] = []
  let storedThreads = options.storedThreads ?? []
  /** Question ids the server has TAKEN an answer for — the shape of the real route's 404. */
  const spentQuestions = new Set<string>()
  /** The follow: one SSE body per subscription; the latest one is where `frame` writes. */
  const openFollow = (): Response => {
    const body = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void {
        const encoder = new TextEncoder()
        write = (text: string): void => controller.enqueue(encoder.encode(text))
        close = (): void => controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }
  /** The page-level lists and the mode seed, by exact path — read per request, as a delete changes the listing. */
  const literalReads: Readonly<Record<string, () => unknown>> = {
    '/api/mode': () => mode,
    '/api/stored-threads': () => storedThreads,
    '/api/projects': () => options.projects ?? [SCRIPTED_LAUNCH_PROJECT],
  }
  /** A thread analysis each view reads (#45, #441, #453), without its `threadId`; undefined is the 404. */
  const analysisReads: Readonly<Record<string, () => object | undefined>> = {
    stats: () => options.stats,
    eval: () => options.eval,
    git: () => (options.git === undefined ? undefined : { cwd: '/scripted/launch', git: options.git() }),
    changes: () => (options.changes === undefined ? undefined : { cwd: '/scripted/launch', ...options.changes() }),
  }
  /** The page's own reads — mode seed, the rail's stored list, a resume click's history. Exact paths. */
  const pageRead = (path: string): Response | undefined => {
    const literal = literalReads[path]
    if (literal !== undefined) return Response.json(literal())
    const history = /^\/api\/threads\/([^/]+)\/history$/.exec(path)
    if (history?.[1] !== undefined) {
      const found = options.histories?.[decodeURIComponent(history[1])]
      return found === undefined ? new Response('no such thread', { status: 404 }) : Response.json(found)
    }
    const events = /^\/api\/threads\/([^/]+)\/events$/.exec(path)
    if (events?.[1] !== undefined) {
      const threadId = decodeURIComponent(events[1])
      return Response.json({ threadId, emitted: [], sent: [], ...options.events })
    }
    const commands = /^\/api\/threads\/([^/]+)\/commands$/.exec(path)
    if (commands?.[1] !== undefined) {
      const threadId = decodeURIComponent(commands[1])
      return Response.json({ threadId, commands: options.commands ?? [], source: 'live' })
    }
    const analysis = /^\/api\/threads\/([^/]+)\/(stats|eval|git|changes)$/.exec(path)
    if (analysis?.[1] !== undefined && analysis[2] !== undefined) {
      const payload = analysisReads[analysis[2]]?.()
      if (payload === undefined) return new Response('nothing has run in this thread', { status: 404 })
      return Response.json({ threadId: decodeURIComponent(analysis[1]), ...payload })
    }
    const inspection = /^\/api\/threads\/([^/]+)$/.exec(path)
    if (inspection?.[1] !== undefined) {
      if (options.inspection === undefined) return new Response('no live session for thread', { status: 404 })
      const threadId = decodeURIComponent(inspection[1])
      return Response.json({ threadId, sessionId: threadId, ...options.inspection })
    }
    return undefined
  }
  /** A thread route's last segment — `/api/threads/<id>/<action>` — or undefined for anything else. */
  const threadAction = (path: string): string | undefined => /^\/api\/threads\/[^/]+\/([^/]+)$/.exec(path)?.[1]
  /** One scripted answer per thread action, keyed the way the server's own route table is. */
  const threadActions: Record<string, (init: RequestInit | undefined) => Promise<Response>> = {
    follow: (): Promise<Response> => Promise.resolve(openFollow()),
    prompt: (init: RequestInit | undefined): Promise<Response> => {
      prompts.push(postedJson(init) as { message: string; admission?: string; images?: unknown[] })
      const body = typeof promptStatus.body === 'string' ? promptStatus.body : JSON.stringify(promptStatus.body)
      return promptGate.promise.then(() => new Response(body, { status: promptStatus.status }))
    },
    dialog: (init: RequestInit | undefined): Promise<Response> => {
      const answer = postedJson(init) as { id?: string }
      const questionId = answer.id ?? ''
      dialogs.push(answer)
      // Recorded first, then refused a response: an unreachable answer IS one the page sent.
      if (options.dialogUnreachable === true) return Promise.reject(new TypeError('Failed to fetch'))
      if (spentQuestions.has(questionId)) {
        const reason = `no open question ${questionId} on thread t1 — answered, expired, or never asked`
        return Promise.resolve(new Response(reason, { status: 404 }))
      }
      if (dialogStatus !== 204) return Promise.resolve(new Response('no', { status: dialogStatus }))
      spentQuestions.add(questionId)
      return Promise.resolve(new Response(null, { status: 204 }))
    },
    mode: (init: RequestInit | undefined): Promise<Response> => {
      modeChanges.push(postedJson(init))
      return Promise.resolve(new Response(modeStatus === 204 ? null : 'no', { status: modeStatus }))
    },
    command: (init: RequestInit | undefined): Promise<Response> => {
      hostCommands.push(postedJson(init))
      if (commandStatus === 204) return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(new Response(options.commandBody ?? 'no', { status: commandStatus }))
    },
    abort: (): Promise<Response> => {
      aborts += 1
      if (abortStatus !== 200) return Promise.resolve(new Response('no', { status: abortStatus }))
      return Promise.resolve(Response.json({ threadId: 't1', restored: options.queued ?? [] }))
    },
  }
  /** The delete route answers only once this resolves — open by default; a test may hold it. */
  let deleteGate = Promise.resolve()
  /**
   * `DELETE /api/threads/:id` (#571): the next scripted answer; a 204 drops the thread from the
   * listing. Recorded as it arrives, answered once the gate opens.
   */
  const deleteThread = async (threadId: string, url: URL, init: RequestInit): Promise<Response> => {
    const answers = options.deleteAnswers ?? []
    const answer = answers[Math.min(deletes.length, answers.length - 1)] ?? { status: 204 }
    deletes.push(`${url.pathname}${url.search}`)
    deleteTags.push(new Headers(init.headers).get('If-Match'))
    await deleteGate
    if (answer.status !== 204) return new Response(answer.reason ?? 'no', { status: answer.status })
    storedThreads = storedThreads.filter((stored) => stored.threadId !== threadId)
    return new Response(null, { status: 204 })
  }
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Relative URLs, as the browser issues them; the base only makes `pathname` parse.
    const url = new URL(requestedUrl(input), 'http://localhost')
    const path = url.pathname
    const deleted = init?.method === 'DELETE' ? /^\/api\/threads\/([^/]+)$/.exec(path)?.[1] : undefined
    if (deleted !== undefined && init !== undefined) return deleteThread(decodeURIComponent(deleted), url, init)
    if (/^\/api\/threads\/[^/]+\/delete-preview$/.test(path)) {
      const preview = options.deletePreview ?? { tree: null, size: null, holdsWork: null, keptFor: [] }
      previewReads.push(path)
      return Promise.resolve(
        'status' in preview ? new Response(preview.reason, { status: preview.status }) : Response.json(preview),
      )
    }
    if (path === '/api/trees') {
      treeReads.push(path)
      const trees = options.trees?.() ?? { projects: [] }
      return Promise.resolve(
        'status' in trees ? new Response(trees.reason, { status: trees.status }) : Response.json(trees),
      )
    }
    const action = threadAction(path)
    const respond = action === undefined ? undefined : threadActions[action]
    if (respond !== undefined) return respond(init)
    if (/^\/api\/threads\/[^/]+\/git$/.test(path)) gitReads.push(path)
    return Promise.resolve(pageRead(path) ?? new Response('not found', { status: 404 }))
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    frame: (frame: EnsoFollowFrame) => write(`data: ${JSON.stringify(frame)}\n\n`),
    closeFollow: () => close(),
    prompts,
    dialogs,
    modeChanges,
    hostCommands,
    abortCount: () => aborts,
    deletes,
    previewReads,
    treeReads,
    gitReads,
    deleteTags,
    holdPrompt: () => {
      const gate = Promise.withResolvers<void>()
      promptGate = gate
      return gate.resolve
    },
    holdDelete: () => {
      const gate = Promise.withResolvers<void>()
      deleteGate = gate.promise
      return gate.resolve
    },
  }
}

export const SNAPSHOT_IDLE: EnsoFollowSnapshot = {
  type: 'snapshot',
  threadId: 't1',
  asOfSeq: 0,
  live: false,
  busy: false,
  generation: 0,
  permissionMode: { mode: 'default', available: ['default', 'plan'] },
  sessionRisk: { level: 'low', signals: 0 },
  incidents: NO_SESSION_INCIDENTS,
  model: null,
  cwd: '/work/project',
  tree: false,
  usage: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: null },
  messages: [],
  openDialogs: [],
}

/** The same thread with a session built: live, and saying its model. */
export const SNAPSHOT_LIVE: EnsoFollowSnapshot = {
  ...SNAPSHOT_IDLE,
  live: true,
  model: {
    model: { provider: 'fake', id: 'fake-1', name: 'Fake One' },
    thinkingLevel: 'off',
    availableThinkingLevels: ['off'],
  },
}
