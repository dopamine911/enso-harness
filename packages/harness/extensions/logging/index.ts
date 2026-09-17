import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { zenLogger } from '@zen/core'
import { configureProcessLogging, isLoggingConfigured, logsDirFrom, parseZenLogLevels } from '@zen/core/log-process'
import { findRepoRoot } from '@zen/core/paths'
import { knownSecretValues } from '@zen/core/secrets'

/**
 * The extension process's logging (#132), and the one record only an extension can write:
 * the provider's own request id (#144).
 *
 * Two ways this code runs, one behaviour each:
 *   - in-process (the web host): the server's launcher configured logging before pi
 *     existed, and `isLoggingConfigured()` says so — this configures nothing, and the
 *     extensions' records land in the server's file through the server's configure;
 *   - as a child (`zen.mjs` → pi): nothing has configured, so this configures — the same
 *     day's file as everyone else, `process: "pi"`, NO console sink (stderr is the TUI's).
 *
 * ⚠ Never configure when something already has: LogTape's `configure` throws on a second
 * call by design (one configurator per process, or it is a bug — `log-process.test.ts`),
 * and a `reset: true` here would silently replace the server's sinks with ours. The
 * `after_provider_response` handler registers either way: it is not about configuration.
 *
 * The knobs are the same: `ZEN_LOG_LEVEL` for the file's tier, per-category overrides in
 * it; `ZEN_LOG_CONSOLE` is ignored here on purpose.
 *
 * WHY FIRST IN THE MANIFEST (`packages/harness/package.json` → `pi.extensions`): the sink is
 * configured here, at load, awaited. Today no extension writes a record before
 * `session_start` — guards, web-fetch and web-search log only inside handlers, which fire
 * after every extension has loaded — so the position decides nothing yet (checked
 * 2026-09-16, #167). It is first so that stays true: an extension that one day logs while
 * loading finds the file already open, instead of a record that lands nowhere.
 */
export function createLoggingExtension(
  environment: Readonly<Record<string, string | undefined>>,
): (pi: ExtensionAPI) => Promise<void> {
  return async (pi: ExtensionAPI): Promise<void> => {
    recordProviderResponses(pi)
    if (isLoggingConfigured()) return
    const repoRoot = findRepoRoot(import.meta.url)
    const disposeLogging = await configureProcessLogging({
      logsDir: logsDirFrom(environment, repoRoot),
      process: 'pi',
      levels: parseZenLogLevels(environment, { console: undefined }),
      // The value pass (#139): pi as a child writes tool output and model text, which is
      // exactly where a known secret is quoted rather than named.
      secretValues: knownSecretValues(repoRoot, environment),
    })
    zenLogger('extension', 'logging').debug('configured by the extension: pi is a child process')
    pi.on('session_shutdown', async (): Promise<void> => {
      await disposeLogging()
    })
  }
}

/**
 * The headers a provider record may carry, by name (#144). An explicit list, not the whole
 * bag: a provider is free to answer with anything, and a header named `authorization` or
 * `set-cookie` echoed into the log would be a secret in the file the redaction manifest
 * says is safe to hand over. These four are correlation and capacity, never credentials.
 */
const RECORDED_RESPONSE_HEADERS = [
  'request-id',
  'x-request-id',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-remaining',
] as const

/**
 * One record per provider call: the id the PROVIDER knows the call by, and the status.
 * Correlation runs browser → route → pi on our own ids (`messageId`, `runId`, `toolCallId`)
 * and stops at pi-ai; with this, a triage can hand Anthropic an id and be answered. Header
 * names arrive lowercased from pi (`onResponse` passes fetch's own record); matched
 * case-insensitively anyway, since that is a provider's choice to change.
 */
function recordProviderResponses(pi: ExtensionAPI): void {
  const log = zenLogger('extension', 'provider')
  pi.on('after_provider_response', (event): void => {
    const headers = new Map(
      Object.entries(event.headers).map(([headerName, headerValue]) => [headerName.toLowerCase(), headerValue]),
    )
    const recorded: Record<string, string> = {}
    for (const headerName of RECORDED_RESPONSE_HEADERS) {
      const headerValue = headers.get(headerName)
      if (headerValue !== undefined) recorded[headerName] = headerValue
    }
    log.info('provider responded {status}, request id {requestId}', {
      status: event.status,
      requestId: recorded['request-id'] ?? recorded['x-request-id'] ?? '(none)',
      headers: recorded,
    })
  })
}

/** The pi entry point: this process's environment. Tests build one with an environment of their own. */
export default createLoggingExtension(process.env)
