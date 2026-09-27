import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApiProxy } from '../dev-proxy.ts'
import { startEnsoServer } from '../index.ts'
import { createFakeAgentHost } from './fake-hosted-thread.ts'

/**
 * #160: the web surface (5178) forwards `/api/*` to the Enso server (5179), whose admission check
 * refuses a request from a non-loopback page. A proxy that rewrote `Origin` or `Host` on the way —
 * a plausible "fix" for a CORS or vhost error — would launder a hostile page's request into a
 * loopback one, and nothing pinned that it does not. Measured by hand once (#160, "Disproved");
 * this is the pin.
 */

function emptyHarness(): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-proxy-harness-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'Enso', pi: { extensions: [] } }))
  return directory
}

const server = startEnsoServer({
  cwd: tmpdir(),
  harnessPackageDir: emptyHarness(),
  agentDir: mkdtempSync(join(tmpdir(), 'enso-proxy-agent-')),
  logsDir: mkdtempSync(join(tmpdir(), 'enso-proxy-logs-')),
  port: 0,
  host: () => createFakeAgentHost(() => Promise.reject(new Error('the proxy tests build no session'))),
})
const upstream = await server.listening
afterAll(() => server.close())

/** A browser's request to `/api/about` through the web surface, with the headers it carried. */
const throughProxy = (headers: Record<string, string>): Promise<Response> =>
  createApiProxy(upstream)(new Request('http://127.0.0.1:5178/api/about', { headers }))

test('a loopback page is answered through the proxy', async () => {
  expect((await throughProxy({ origin: 'http://127.0.0.1:5178' })).status).toBe(200)
})

test('⚠ a cross-site page is refused through the proxy: its Origin reaches the admission check unchanged (#160)', async () => {
  expect((await throughProxy({ origin: 'https://evil.example' })).status).toBe(403)
})

test('⚠ a rebound Host is refused through the proxy: DNS rebinding cannot pass as loopback (#160)', async () => {
  expect((await throughProxy({ host: 'attacker.example:5178' })).status).toBe(403)
})
