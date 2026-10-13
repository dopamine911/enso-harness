import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { realpathOrSelf } from '@enso/core/paths'

/**
 * The agent dir's multi-account config (`provider-failover.json`), seeded before the first session so
 * one process can host many threads (#341). Read-merge-write: multi-account writes its defaults only
 * when the file is absent, its user-facing commands read-merge-write the same file, and every key the
 * operator set is kept verbatim.
 *
 * ⚠⚠ `childProxy: false`. With the default `childProxy: true` the SECOND session in one process
 * hangs in `session_start`: multi-account binds a fixed loopback port (41977), the second instance
 * hits EADDRINUSE, and its fallback `server.listen(0)` relies on a `listening` listener that Bun
 * (unlike Node 24) does not re-fire after an error (#69). The proxy exists so processes spawned
 * WITHOUT the extension can ride the rotation's account; this server spawns none.
 *
 * ⚠⚠ ONE `authErrorPatterns` ENTRY (#341). With no Cursor login, multi-account's own Cursor proxy
 * throws "No Cursor account is logged in for this request" and answers it as `500 server_error`
 * (`cursor/proxy.ts`); its classifier reads the `500` as TRANSIENT and tells someone who can only
 * fix it by logging in to retry. The entry makes it an AUTH failure — "authorization is invalid. Run
 * /login …", no automatic resume. The vendor's list only grows (`patternsWithDefaults`), so this adds
 * to its defaults and to anything the operator listed. Tied to the proxy's wording: if that changes,
 * behaviour falls back, and `agent-host.test.ts` goes red against the real proxy. Leaves when the
 * proxy answers 401.
 *
 * ⚠⚠ `includeCursor: false`, UNLESS THE OPERATOR SET IT (#341). multi-account ships its Cursor
 * provider inside the package, so its default (`true`) registers `cursor` and a spare
 * `cursor-account-2` whether or not anyone has a Cursor login, and publishes both into pi's
 * `models.json` with a placeholder key (`cursor-proxy`) against its loopback proxy. pi reads a key as
 * a credential, so every Cursor model would be offered as usable — in the launch panel (#877), the model
 * picker, and as the default model. Cursor is opt-in: `"includeCursor": true` in the file turns it
 * back on and is kept. The vendor never removes a Cursor publication (`dropOwnLoopbackPublications`
 * skips them), so with Cursor off the seed also drops the ones it left in `models.json`, by the test
 * the vendor applies to its other loopback publications (`slot-proxy.ts#isOwnLoopbackPublication`):
 * the placeholder key against a loopback `baseUrl`. An operator's `modelOverrides`, which the vendor
 * carries into every republication, are theirs and stay, as `{ modelOverrides }` alone (the vendor's
 * own collapse; pi accepts an overrides-only entry); the route and its placeholder credential go.
 */

/** The agent dir's multi-account config file, and the keys this host seeds in it. */
const MULTI_ACCOUNT_CONFIG_FILENAME = 'provider-failover.json'

const MULTI_ACCOUNT_CHILD_PROXY_KEY = 'childProxy'

const MULTI_ACCOUNT_AUTH_PATTERNS_KEY = 'authErrorPatterns'

const MULTI_ACCOUNT_INCLUDE_CURSOR_KEY = 'includeCursor'

/** Matched case-insensitively as a substring of the error text — see the module header (#341). */
const MULTI_ACCOUNT_AUTH_PATTERNS: readonly string[] = ['account is logged in for this request']

/**
 * pi's provider registry in the agent dir, and how multi-account publishes a Cursor slot into it:
 * a Cursor slot id (`cursor-bridge.ts#isCursorProviderId`), the placeholder key
 * (`cursor-bridge.ts#CURSOR_PROXY_PLACEHOLDER_KEY`) and a loopback `baseUrl`.
 */
const PI_MODELS_FILENAME = 'models.json'

const CURSOR_SLOT_ID = /^cursor(-account-\d+)?$/

const CURSOR_PROXY_PLACEHOLDER_KEY = 'cursor-proxy'

const CURSOR_LOOPBACK_PREFIX = 'http://127.0.0.1:'

/**
 * Seed the agent dir's multi-account config — see the module header: pin `childProxy: false`, add
 * Enso's `authErrorPatterns` to the operator's (#341), and turn Cursor off unless the operator
 * set `includeCursor` — then, with Cursor off, drop the Cursor slots multi-account left in pi's
 * `models.json`.
 *
 * Creates the file if absent; otherwise reads, sets what is missing, writes — and only when
 * something changed. Every other key, and every entry the operator listed, is kept verbatim;
 * a pattern already there in any case is not added twice (the vendor compares them that way).
 */
export function seedMultiAccountConfig(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })
  const configPath = join(agentDir, MULTI_ACCOUNT_CONFIG_FILENAME)
  let existing: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  }
  const listed = existing[MULTI_ACCOUNT_AUTH_PATTERNS_KEY]
  // Kept as the operator wrote it, non-strings included (the vendor skips those; the file is theirs).
  const operatorEntries: readonly unknown[] = Array.isArray(listed) ? listed : []
  const missingPatterns = MULTI_ACCOUNT_AUTH_PATTERNS.filter(
    (pattern) =>
      !operatorEntries.some((known) => typeof known === 'string' && known.toLowerCase() === pattern.toLowerCase()),
  )
  // The vendor reads `includeCursor ?? true`, so `null` is as unset as absent.
  const operatorCursor = existing[MULTI_ACCOUNT_INCLUDE_CURSOR_KEY]
  const cursorUnset = operatorCursor === undefined || operatorCursor === null
  if (existing[MULTI_ACCOUNT_CHILD_PROXY_KEY] !== false || missingPatterns.length > 0 || cursorUnset) {
    const seeded = {
      ...existing,
      [MULTI_ACCOUNT_CHILD_PROXY_KEY]: false,
      [MULTI_ACCOUNT_AUTH_PATTERNS_KEY]: [...operatorEntries, ...missingPatterns],
      ...(cursorUnset ? { [MULTI_ACCOUNT_INCLUDE_CURSOR_KEY]: false } : {}),
    }
    writeFileSync(configPath, `${JSON.stringify(seeded, null, '\t')}\n`)
  }
  // …and by truthiness (`if (!config.includeCursor)`), so this does too — unset included.
  if (!operatorCursor) dropCursorPublications(agentDir)
}

/** A `models.json` entry multi-account published for a Cursor slot: the placeholder key against a loopback `baseUrl`. */
function isCursorPublication(providerId: string, entry: unknown): entry is Record<string, unknown> {
  if (!CURSOR_SLOT_ID.test(providerId) || typeof entry !== 'object' || entry === null) return false
  const record = entry as Record<string, unknown>
  return (
    record.apiKey === CURSOR_PROXY_PLACEHOLDER_KEY &&
    typeof record.baseUrl === 'string' &&
    record.baseUrl.startsWith(CURSOR_LOOPBACK_PREFIX)
  )
}

/** What of a Cursor publication is the operator's: its `modelOverrides`, when there are any. */
function operatorOverlay(publication: Record<string, unknown>): { modelOverrides: object } | undefined {
  const overrides = publication.modelOverrides
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return undefined
  return Object.keys(overrides).length > 0 ? { modelOverrides: overrides } : undefined
}

/**
 * Remove multi-account's Cursor publications from pi's `models.json` — see the module header: each
 * route goes, an operator's `modelOverrides` stay. Every other provider and key is kept verbatim;
 * the file is written only when a publication was found.
 */
function dropCursorPublications(agentDir: string): void {
  const modelsPath = join(agentDir, PI_MODELS_FILENAME)
  if (!existsSync(modelsPath)) return
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(modelsPath, 'utf8'))
  } catch {
    // pi's file, and pi reports a malformed one when it loads it; there is nothing of ours to drop.
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const models = parsed as Record<string, unknown>
  const providers = models.providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
  const entries = Object.entries(providers)
  if (!entries.some(([providerId, entry]) => isCursorPublication(providerId, entry))) return
  const kept = entries.flatMap(([providerId, entry]): [string, unknown][] => {
    if (!isCursorPublication(providerId, entry)) return [[providerId, entry]]
    const overlay = operatorOverlay(entry)
    return overlay === undefined ? [] : [[providerId, overlay]]
  })
  // Staged and renamed over, as the vendor writes it: pi never reads a half-written registry. At the
  // file the path names: a rename onto a run home's link would replace the link (#758).
  const target = realpathOrSelf(modelsPath)
  const staging = `${target}.enso.tmp`
  writeFileSync(staging, `${JSON.stringify({ ...models, providers: Object.fromEntries(kept) }, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(staging, target)
}
