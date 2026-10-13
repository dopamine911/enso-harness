import { Type } from 'typebox'

/**
 * The Claude Code identity Enso presents on a Claude login (#925): the version in the
 * `claude-cli/<version>` user-agent that every request made with a Claude Code OAuth credential
 * carries, the conversation's (pi's) and the web search's (Enso's) alike.
 *
 * ⚠ Anthropic enforces a minimum version per model and moves it: a request below it is refused
 * as `claude_code_version_too_old` ("Claude Code 2.1.75 does not support this model; version
 * 2.1.280 or newer is required"). pi hardcodes its own version and moves it in its releases; when
 * Anthropic moves first, the person sets `claudeCode.version` in their config and both paths
 * claim it — no pi release to wait for, no Claude Code install read. Unset, conversations send
 * pi's value and the search sends the same one (`CLAUDE_CODE_DEFAULT_VERSION`).
 *
 * @module
 */

/**
 * The version the search claims when the config sets none: EXACTLY pi-ai's own hardcoded
 * `claudeCodeVersion` (`anthropic-messages.js`), which pi's conversation path sends. pi exports no
 * constant and `harness/core` may not import pi (#145), so it is copied, and
 * `harness/extensions/web-search/__tests__/claude-code-version.test.ts` reads pi's installed value
 * and fails when this one differs: a pi upgrade that moves it is caught there, not in a search.
 *
 * @group Configuration
 */
export const CLAUDE_CODE_DEFAULT_VERSION = '2.1.280'

/**
 * The `claudeCode` section: `version`, the Claude Code version to claim on a Claude login, as
 * Anthropic names versions (`2.1.284`). User-only: a project's own config may not set it
 * (`harness/core/session-config.ts`), since a checkout the agent can write must not change what
 * Enso tells Anthropic it is.
 *
 * @group Configuration
 */
export const ClaudeCodeConfig = Type.Object(
  {
    version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' }),
  },
  { additionalProperties: false },
)

/**
 * The user-agent a Claude login's request carries: `claude-cli/<version>`.
 *
 * @group Configuration
 */
export function claudeCodeUserAgent(version: string): string {
  return `claude-cli/${version}`
}

/**
 * Whether an Anthropic credential is a Claude login (a Claude Code OAuth token) rather than an API
 * key: only a Claude login's requests claim to be Claude Code.
 *
 * @group Configuration
 */
export function isClaudeLoginCredential(apiKey: string | undefined): boolean {
  return apiKey?.includes('sk-ant-oat') === true
}

/**
 * Anthropic's refusal of the claimed version, read from an error's text: the version it requires,
 * where its sentence names one. (The version sent is in Anthropic's own sentence, which is shown.)
 *
 * @group Configuration
 */
export interface ClaudeCodeVersionRefusal {
  readonly required: string | undefined
}

const VERSION_REFUSAL_CODE = 'claude_code_version_too_old'
const VERSION_REFUSAL_SENTENCE =
  /Claude Code \d+\.\d+\.\d+ does not support this model(?:; version (\d+\.\d+\.\d+) or newer)?/

/**
 * The version refusal in an error's text — its `error_code` or its sentence — or `undefined`.
 *
 * @group Configuration
 */
export function claudeCodeVersionRefusalOf(text: string): ClaudeCodeVersionRefusal | undefined {
  const sentence = VERSION_REFUSAL_SENTENCE.exec(text)
  if (sentence === null && !text.includes(VERSION_REFUSAL_CODE)) return undefined
  return { required: sentence?.[1] }
}

/**
 * What a person does about a version refusal, in Enso's terms. Anthropic's own sentence says
 * "Run 'claude update'", which changes nothing Enso sends: the version is Enso's setting.
 *
 * @group Configuration
 */
export function claudeCodeVersionHint(refusal: ClaudeCodeVersionRefusal): string {
  const version = refusal.required ?? '<version>'
  return (
    `Enso sets the Claude Code version it claims, so 'claude update' doesn't change it: set ` +
    `"claudeCode": { "version": "${version}" } in config.json in ENSO_HOME (~/.enso by default), ` +
    `then start a new session.`
  )
}
