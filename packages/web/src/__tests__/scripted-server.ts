import type {
  EnsoFollowFrame,
  EnsoFollowSnapshot,
  EnsoStoredThread,
  EnsoThreadEvents,
  EnsoThreadHistory,
  EnsoThreadInspection,
} from '@enso/core'

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
  /** How many `POST …/abort` the server saw (#116). */
  readonly abortCount: () => number
  /** Hold the next prompt's answer; returns the release. */
  readonly holdPrompt: () => () => void
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
  /** What the stop hands back (#75): the prompts pi had queued. Answered with the 200 receipt. */
  readonly queued?: string[]
  readonly mode?: { mode: string; available: string[] }
  /** What `GET /api/stored-threads` lists — the rail's Previous Threads (#95). */
  readonly storedThreads?: EnsoStoredThread[]
  /** What `GET /api/threads/:id/history` answers for a resume click; keyed by thread id. */
  readonly histories?: Record<string, EnsoThreadHistory>
  /**
   * What the debug pane's two reads answer — `GET /api/threads/:id` and `…/events` (#86). One
   * inspection for every thread id (the pane compares it with the page's belief, so a test
   * scripts the disagreement it wants); 404 when absent, the pane's "no live session yet".
   */
  readonly inspection?: Omit<EnsoThreadInspection, 'threadId' | 'sessionId'>
  readonly events?: Omit<EnsoThreadEvents, 'threadId'>
}

export function createScriptedFetch(options: ScriptedFetchOptions = {}): ScriptedFetch {
  const promptStatus = options.promptStatus ?? {
    status: 202,
    body: { threadId: 't1', messageId: 'pm1', generation: 1, queued: false },
  }
  const dialogStatus = options.dialogStatus ?? 204
  const abortStatus = options.abortStatus ?? 200
  const modeStatus = options.modeStatus ?? 204
  const mode = options.mode ?? { mode: 'default', available: ['default', 'plan'] }
  let aborts = 0
  let write: (text: string) => void = () => undefined
  let close: () => void = () => undefined
  /** The prompt route answers only once this resolves — open by default; a test may hold it. */
  let promptGate = { promise: Promise.resolve() } as { promise: Promise<void>; resolve?: () => void }
  const prompts: Array<{ message: string; admission?: string; images?: unknown[] }> = []
  const dialogs: unknown[] = []
  const modeChanges: unknown[] = []
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
  /** The page's own reads — mode seed, the rail's stored list, a resume click's history. Exact paths. */
  const pageRead = (path: string): Response | undefined => {
    if (path === '/api/mode') return Response.json(mode)
    if (path === '/api/stored-threads') return Response.json(options.storedThreads ?? [])
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
      prompts.push(JSON.parse(String(init?.body)) as { message: string; admission?: string; images?: unknown[] })
      const body = typeof promptStatus.body === 'string' ? promptStatus.body : JSON.stringify(promptStatus.body)
      return promptGate.promise.then(() => new Response(body, { status: promptStatus.status }))
    },
    dialog: (init: RequestInit | undefined): Promise<Response> => {
      const answer = JSON.parse(String(init?.body)) as { id?: string }
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
      modeChanges.push(JSON.parse(String(init?.body)))
      return Promise.resolve(new Response(modeStatus === 204 ? null : 'no', { status: modeStatus }))
    },
    abort: (): Promise<Response> => {
      aborts += 1
      if (abortStatus !== 200) return Promise.resolve(new Response('no', { status: abortStatus }))
      return Promise.resolve(Response.json({ threadId: 't1', restored: options.queued ?? [] }))
    },
  }
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Relative URLs, as the browser issues them; the base only makes `pathname` parse.
    const path = new URL(String(input), 'http://localhost').pathname
    const action = threadAction(path)
    const respond = action === undefined ? undefined : threadActions[action]
    if (respond !== undefined) return respond(init)
    return Promise.resolve(pageRead(path) ?? new Response('not found', { status: 404 }))
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    frame: (frame: EnsoFollowFrame) => write(`data: ${JSON.stringify(frame)}\n\n`),
    closeFollow: () => close(),
    prompts,
    dialogs,
    modeChanges,
    abortCount: () => aborts,
    holdPrompt: () => {
      const gate = Promise.withResolvers<void>()
      promptGate = gate
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
  messages: [],
  openDialogs: [],
}
