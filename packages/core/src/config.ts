import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { EnsoProjectsConfig } from './project.ts'
import { WebFetchConfig } from './web-fetch.ts'
import { WebSearchConfig } from './web-search.ts'

/**
 * Enso's ONE committed config file (#59): `enso.config.json` at the repository
 * root.
 *
 * Daniel's scope, 2026-09-04: "just a config file for Enso only, separate from pi" —
 * nothing here rides pi's settings or agent-dir surfaces.
 *
 * ⚠ THE CONFIG BELONGS TO THE ZEN-HARNESS INSTALL, NOT THE SESSION. It is located from
 * the harness's own file tree (`findRepoRoot` on a module inside this repo), NEVER from
 * the session cwd — enso can run against a foreign checkout (`bun run dev /some/path`),
 * and a foreign repo's `enso.config.json` must not become this session's allowlist.
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
 * The committed config file's basename. Lives at the repository root.
 *
 * @group Configuration
 */
export const ENSO_CONFIG_FILENAME = 'enso.config.json'

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
 * already-committed config unreadable, and unreadable fails CLOSED for every consumer at once.
 *
 * @group Configuration
 */
export const EnsoConfig = Type.Object(
  {
    webFetch: WebFetchConfig,
    webSearch: Type.Optional(WebSearchConfig),
    projects: Type.Optional(EnsoProjectsConfig),
  },
  { additionalProperties: false },
)
/** @group Configuration */
export type EnsoConfig = Static<typeof EnsoConfig>

const ensoConfigValidator = Compile(EnsoConfig)

/** @group Configuration */
export type EnsoConfigParseResult = { kind: 'ok'; config: EnsoConfig } | { kind: 'unreadable'; reason: string }

/**
 * Parse the config file's text.
 *
 * Any failure comes back as `unreadable`, and the caller must fail CLOSED on it — "could not
 * read the policy" must never render as "no policy".
 *
 * @group Configuration
 */
export function parseEnsoConfig(fileText: string): EnsoConfigParseResult {
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
