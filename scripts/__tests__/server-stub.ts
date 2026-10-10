import type { ServerCliIo } from '../server-cli.ts'

/** What one `run` wrote and returned. */
export interface Captured {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * A stand-in for the server routes `incidents` and `judge` read (#838): `/api/stored-threads` lists
 * the threads in `payloads`, `/api/threads/<id>/<route>` answers that thread's payload, anything
 * else is a 404. `requests` holds every URL asked for, query included, in arrival order.
 */
export async function withStubServer(
  route: string,
  payloads: Readonly<Record<string, unknown>>,
  body: (serverUrl: string, requests: URL[]) => Promise<void>,
): Promise<void> {
  const requests: URL[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(url)
      if (url.pathname === '/api/stored-threads') {
        return Response.json(Object.keys(payloads).map((threadId) => ({ threadId })))
      }
      const [, api, threads, threadId, asked] = url.pathname.split('/')
      const payload = threadId === undefined ? undefined : payloads[decodeURIComponent(threadId)]
      if (api !== 'api' || threads !== 'threads' || asked !== route || payload === undefined) {
        return new Response('no such thread', { status: 404 })
      }
      return Response.json(payload)
    },
  })
  try {
    await body(server.url.origin, requests)
  } finally {
    await server.stop(true)
  }
}

/** One `run` against `serverUrl`, its output captured. */
export async function runCaptured(
  run: (argv: readonly string[], io: ServerCliIo) => Promise<number>,
  argv: readonly string[],
  serverUrl: string,
): Promise<Captured> {
  let stdout = ''
  let stderr = ''
  const code = await run(argv, {
    serverUrl,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}
