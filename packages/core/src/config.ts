import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { EnsoProjectsConfig } from './project.ts'
import { EnsoSecurityConfig } from './session-incident.ts'
import { WebFetchConfig } from './web-fetch.ts'
import { WebSearchConfig } from './web-search.ts'

/**
 * Enso's config (#59): the USER's `config.json` in `ENSO_HOME` (`~/.enso/config.json`, #421).
 *
 * Daniel's scope, 2026-09-04: "just a config file for Enso only, separate from pi" —
 * nothing here rides pi's settings or agent-dir surfaces.
 *
 * ⚠ pi's pattern (#421): the install ships no config file. Its DEFAULTS are in code — the reader
 * of each section says what an absent key means — and the user's file overrides them. A missing
 * file is therefore the defaults, not a failure: an empty `web_fetch` allowlist, the default
 * search routing, no project roots. Those are the most restrictive settings, so an absent file
 * can never widen anything. (Until #421 the file was `enso.config.json` in the checkout, with one
 * machine's project roots in it.)
 *
 * ⚠ NEVER located from the session cwd — enso runs against foreign checkouts
 * (`bun run dev /some/path`), and a foreign repo's config must not become this session's
 * allowlist. A project's own config is #421's next slice, behind pi's trust decision.
 *
 * ⚠ STRICT ON UNKNOWN KEYS, deliberately. This is a policy file: a typo
 * (`"allowedHost"`) must refuse loudly, not silently configure nothing. The cost is
 * forward-incompatibility — an older harness reading a newer config refuses everything —
 * and for a security file that direction of failure is the wanted one.
 *
 * The loading contract every consumer follows: parse fails CLOSED (`unreadable` is never
 * "no policy"), and policy-bearing sections are read ONCE per session at extension load,
 * so an in-session edit is inert until a restart has put the diff in front of a human.
 */

/**
 * The config file's basename, in `ENSO_HOME` (`ensoConfigPath`).
 *
 * @group Configuration
 */
export const ENSO_CONFIG_FILENAME = 'config.json'

/**
 * The example a refusal message shows a human who needs to change the config.
 *
 * @group Configuration
 */
export const ENSO_CONFIG_EXAMPLE = `{ "webFetch": { "allowedHosts": ["docs.example.com"] } }`

/**
 * The whole config file.
 *
 * One section per consumer; every section's schema lives with its owner. ⚠ New sections are
 * added `Type.Optional`, load-bearing (#63): a required section would make every
 * existing config unreadable, and unreadable fails CLOSED for every consumer at once.
 *
 * @group Configuration
 */
export const EnsoConfig = Type.Object(
  {
    webFetch: Type.Optional(WebFetchConfig),
    webSearch: Type.Optional(WebSearchConfig),
    projects: Type.Optional(EnsoProjectsConfig),
    security: Type.Optional(EnsoSecurityConfig),
  },
  { additionalProperties: false },
)
/** @group Configuration */
export type EnsoConfig = Static<typeof EnsoConfig>

const ensoConfigValidator = Compile(EnsoConfig)

/** @group Configuration */
export type EnsoConfigParseResult = { kind: 'ok'; config: EnsoConfig } | { kind: 'unreadable'; reason: string }

/**
 * Parse the config file's text; `undefined` — no file — is the defaults, `{}`.
 *
 * Any failure of a file that IS there comes back as `unreadable`, and the caller must fail CLOSED
 * on it — "could not read the policy" must never render as "no policy".
 *
 * @group Configuration
 */
export function parseEnsoConfig(fileText: string | undefined): EnsoConfigParseResult {
  if (fileText === undefined) return { kind: 'ok', config: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(fileText)
  } catch (error) {
    return { kind: 'unreadable', reason: `${ENSO_CONFIG_FILENAME} is not valid JSON (${String(error)})` }
  }
  if (!ensoConfigValidator.Check(parsed)) {
    return {
      kind: 'unreadable',
      reason:
        `${ENSO_CONFIG_FILENAME} does not match the expected shape ${ENSO_CONFIG_EXAMPLE} ` +
        `(unknown keys are refused — a typo must fail loudly, not configure nothing)`,
    }
  }
  return { kind: 'ok', config: parsed }
}

/**
 * A trusted project's config over the user's (#421): objects merge key by key, the project's
 * value wins for a scalar, and a list COMBINES — a project's `allowedHosts` adds to the user's
 * rather than replacing them, as #421 decided (pi's own settings merge replaces arrays; its
 * resource lists combine, and a host grant is Enso's resource list). `projects` is user-only and
 * is dropped by the caller before this is reached.
 *
 * @group Configuration
 */
export function mergeEnsoConfig(user: EnsoConfig, project: EnsoConfig): EnsoConfig {
  return mergeValues(user, project) as EnsoConfig
}

function mergeValues(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (Array.isArray(base) && Array.isArray(override)) return [...new Set([...base, ...override])]
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) merged[key] = mergeValues(base[key], value)
    return merged
  }
  return override
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
