import { ensoLogger } from '@enso/core'

const log = ensoLogger('server', 'web')

/**
 * The web surface's `/api/*` hop to the Enso server (`dev-web.ts`), streaming both directions.
 *
 * ⚠ `signal: request.signal` is LOAD-BEARING, not hygiene. The enso server tears pi down
 * from its response 'close' (#34), which fires only if a browser abort propagates through
 * this hop as an upstream disconnect — vite's http-proxy did this implicitly; a bare
 * `fetch` would hold the upstream open and starve the teardown of its trigger. Receipt:
 * a timeout-curl through 5178 reaps pi within 3s (#38).
 *
 * ⚠ The request's headers cross UNCHANGED, `Origin` and `Host` included: the Enso server's
 * admission check (loopback origin, loopback host) is the one gate, and this hop must not
 * launder a hostile page's request into a loopback one (#160; `dev-proxy.test.ts`).
 */
export function createApiProxy(upstreamOrigin: string): (request: Request) => Promise<Response> {
  return (request: Request): Promise<Response> => {
    const requestUrl = new URL(request.url)
    const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, upstreamOrigin)
    return fetch(upstreamUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      // The enso server never redirects; surfacing one un-followed would be a bug report.
      redirect: 'manual',
    }).catch((error: unknown) => {
      // A browser's own abort is not a failure; the enso server being down is.
      if (!request.signal.aborted) log.error('proxy to {upstream} failed: {error}', { upstream: upstreamOrigin, error })
      throw error
    })
  }
}
