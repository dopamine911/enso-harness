/**
 * Enso's permission modes (#496): what each mode means, and how a session records which one it
 * is in.
 *
 * `@gotgenes/pi-permission-system` decides every tool call against one policy, the user's
 * `ENSO_HOME/permissions.json`. It has no modes. What it does have is a per-session **agent**:
 *
 * - the last `active_agent` custom entry in a session names the agent;
 * - the `permission` block in that agent's file (`<agentDir>/agents/<name>.md`) is merged over
 *   the user's policy for that session.
 *
 * So a mode here is an agent preset that Enso owns: every mode is the agent `enso-mode-<mode>`,
 * and `default`'s preset is empty (the user's policy as written).
 *
 * ⚠ `default` IS A NAMED AGENT, NEVER `name: null` (#496 review). gotgenes resolves a `null`
 * entry by falling back to the last agent it resolved in that session
 * (`session/permission-session.ts#resolveAgentName`, a field it never clears), so `null` after
 * `/bypassPermissions` kept bypass enforced while every Enso surface said `default`. A name
 * whose file has no `permission` block is an empty scope, and it replaces the previous one.
 *
 * - The harness's permission-modes extension writes the entry (its `/plan`, `/auto` … commands).
 * - The launch surfaces write the agent files (`preparePermissionPolicy`).
 * - The host reads the entry back, to show the mode.
 *
 * ⚠ A MODE CHANGES ONLY ENSO'S CATCH-ALL, NEVER A RULE THE USER WROTE (#499). The engine merges a
 * preset over the user's policy key by key (gotgenes `policy/permission-merge.ts`), and rules are
 * last-match-wins:
 * - a preset key the user's map already has is replaced where it stands, so every rule the user
 *   wrote after it still decides;
 * - a preset key the user's map lacks is appended AFTER all of the user's rules, and wins. That
 *   is how `bypassPermissions` once allowed a command the user denied.
 *
 * So every preset map holds one key, `ENSO_CATCH_ALL`, and the launch puts that key first in every
 * user map a preset touches (`permission-rules.ts#preparePermissionPolicy`). A deny, ask or allow
 * the user wrote then beats every mode, as it does in oh-my-pi's approval modes and in Claude
 * Code's. A surface given as a STRING replaces the user's whole surface instead: `plan` uses that
 * for its denies, so a user's `edit` allow cannot reopen editing in plan.
 *
 * Probed against gotgenes 36.2.0 (#496, #499).
 *
 * @module
 */

/**
 * The modes, in the order the mode menu shows them.
 *
 * @group Permission mode
 */
export const ENSO_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const

/** @group Permission mode */
export type EnsoPermissionModeName = (typeof ENSO_PERMISSION_MODES)[number]

/**
 * The mode a session with no `active_agent` entry is in.
 *
 * @group Permission mode
 */
export const ENSO_DEFAULT_PERMISSION_MODE: EnsoPermissionModeName = 'default'

/**
 * The `customType` gotgenes reads the session's agent from (`session/active-agent.ts`).
 *
 * @group Permission mode
 */
export const ACTIVE_AGENT_CUSTOM_TYPE = 'active_agent'

/**
 * The authorizer link `auto` mode answers asks through. The user's policy names it in
 * `authorizerChain`; a name nobody registered is skipped, so the ask reaches the user.
 *
 * @group Permission mode
 */
export const ENSO_AUTO_AUTHORIZER = 'enso-auto'

/**
 * Enso's catch-all pattern: the one key a mode preset changes, and the pattern `auto` answers.
 *
 * The engine matches `**` exactly as it matches `*` (both compile to "anything",
 * `policy/wildcard-matcher.ts`), but reports it as its own pattern. That lets Enso tell its own
 * catch-all from a surface-wide rule the user wrote: a string surface (`bash: 'ask'`) and a
 * user's `*` are the user's, and reach the user in `auto` (#498).
 *
 * @group Permission mode
 */
export const ENSO_CATCH_ALL = '**'

const MODE_AGENT_PREFIX = 'enso-mode-'

/** A surface's rule: one action for everything, or a map from pattern to action. */
type SurfaceRule = string | Readonly<Record<string, string>>

/** What a mode changes, over the user's policy. */
interface ModePreset {
  /** One line for the mode menu and the Permission modes page. */
  readonly summary: string
  readonly permission: Readonly<Record<string, SurfaceRule>>
}

/**
 * In-project edits and writes run without asking. `path_write` is granted too, because an edit
 * also consults the write side of the path gate. Outside the project, `external_directory_write`
 * still asks.
 *
 * ⚠ Claude Code's acceptEdits also allows `mkdir`, `touch`, `mv` and `cp`. Allowing them here
 * means adding patterns, which would land after the user's rules and beat their denies (#499).
 */
const EDITS_ALLOWED: Readonly<Record<string, SurfaceRule>> = {
  edit: { [ENSO_CATCH_ALL]: 'allow' },
  write: { [ENSO_CATCH_ALL]: 'allow' },
  path_write: { [ENSO_CATCH_ALL]: 'allow' },
}

/**
 * Each mode's preset.
 *
 * ⚠ `bypassPermissions` still asks in two places, because gotgenes floors them to `ask` whatever
 * the rules say: a command run through a wrapper (`bash -c`, `sudo`, `eval`) and a command its
 * parser cannot read. A deny or ask the user wrote keeps deciding in every mode.
 *
 * ⚠ `plan` denies the edit and write TOOLS. A redirect from an allowlisted bash command
 * (`cat a > b`) still writes inside the project, because the seed allows `path_write` there
 * (`permission-rules.ts#ENSO_DEFAULT_PERMISSION_POLICY` says why).
 *
 * @group Permission mode
 */
export const ENSO_MODE_PRESETS: Readonly<Record<EnsoPermissionModeName, ModePreset>> = {
  default: {
    summary: 'the policy in permissions.json, as written',
    permission: {},
  },
  acceptEdits: {
    summary: 'edits and writes inside the project run without asking',
    permission: EDITS_ALLOWED,
  },
  plan: {
    summary: 'read and explore; the edit and write tools are denied',
    permission: { edit: 'deny', write: 'deny' },
  },
  bypassPermissions: {
    summary: 'everything runs without asking, except what your own rules deny or ask',
    permission: {
      '*': 'allow',
      edit: { [ENSO_CATCH_ALL]: 'allow' },
      write: { [ENSO_CATCH_ALL]: 'allow' },
      path_read: { [ENSO_CATCH_ALL]: 'allow' },
      path_write: { [ENSO_CATCH_ALL]: 'allow' },
      external_directory_read: { [ENSO_CATCH_ALL]: 'allow' },
      external_directory_write: { [ENSO_CATCH_ALL]: 'allow' },
      bash: { [ENSO_CATCH_ALL]: 'allow' },
    },
  },
  auto: {
    summary: 'edits run as in acceptEdits; a classifier model answers what would ask',
    permission: EDITS_ALLOWED,
  },
}

/**
 * The agent a mode selects. `default`'s is a real name too, never `null` (see the module's ⚠).
 *
 * @group Permission mode
 */
export function modeAgentName(mode: EnsoPermissionModeName): string {
  return `${MODE_AGENT_PREFIX}${mode}`
}

function isModeName(value: string): value is EnsoPermissionModeName {
  return (ENSO_PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * The mode ONE session entry records, or undefined when the entry is not an `active_agent`
 * entry, is malformed, or names an agent that is not one of Enso's modes.
 *
 * Reads defensively, as every wire crossing does: an unrelated custom entry is ignored, never a
 * throw inside a stream loop.
 *
 * @group Permission mode
 */
export function readRecordedMode(entry: unknown): EnsoPermissionModeName | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  if (!('customType' in entry) || entry.customType !== ACTIVE_AGENT_CUSTOM_TYPE) return undefined
  if (!('data' in entry) || typeof entry.data !== 'object' || entry.data === null) return undefined
  if (!('name' in entry.data)) return undefined
  const { name } = entry.data
  // Not written any more (see the module's ⚠); read as `default`, which is what it asked for.
  if (name === null) return ENSO_DEFAULT_PERMISSION_MODE
  if (typeof name !== 'string' || !name.startsWith(MODE_AGENT_PREFIX)) return undefined
  const mode = name.slice(MODE_AGENT_PREFIX.length)
  return isModeName(mode) ? mode : undefined
}

/**
 * The mode a session is in, from its entries: the LAST `active_agent` entry wins, and a session
 * with none is in `default`.
 *
 * ⚠ Walk the session's ENTRIES in file order, not its branch. That is what gotgenes walks
 * (`session/active-agent.ts#getActiveAgentName`), so the mode shown is the mode enforced, even
 * after `/tree` moves the leaf.
 *
 * ⚠ An `active_agent` entry naming someone else's agent is skipped here, but gotgenes would apply
 * that agent. Only Enso writes the entry in an Enso session; this is the reading to revisit if
 * that ever changes.
 *
 * @group Permission mode
 */
export function recordedPermissionMode(entries: readonly unknown[]): EnsoPermissionModeName {
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position]
    if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'custom') continue
    const recorded = readRecordedMode(entry)
    if (recorded !== undefined) return recorded
  }
  return ENSO_DEFAULT_PERMISSION_MODE
}

/** A frontmatter key: bare when it is a plain word, JSON-quoted otherwise (`"*"`, `"git *"`). */
function frontmatterKey(key: string): string {
  return /^[A-Za-z_]+$/.test(key) ? key : JSON.stringify(key)
}

/**
 * The agent file for a mode, in the frontmatter shape gotgenes reads: `key: value` scalars and
 * nested maps only (its parser takes no arrays, anchors or multi-line values). An empty preset
 * writes no `permission` block, which gotgenes reads as an empty scope.
 *
 * @group Permission mode
 */
export function modeAgentFile(mode: EnsoPermissionModeName): string {
  const preset = ENSO_MODE_PRESETS[mode]
  const entries = Object.entries(preset.permission)
  const lines = ['---', `name: ${modeAgentName(mode)}`, ...(entries.length > 0 ? ['permission:'] : [])]
  for (const [surface, rule] of entries) {
    if (typeof rule === 'string') {
      lines.push(`  ${frontmatterKey(surface)}: ${rule}`)
      continue
    }
    lines.push(`  ${frontmatterKey(surface)}:`)
    for (const [pattern, action] of Object.entries(rule)) lines.push(`    ${frontmatterKey(pattern)}: ${action}`)
  }
  lines.push('---', `Enso's ${mode} permission mode: ${preset.summary}. Written by Enso at every launch (#496).`, '')
  return lines.join('\n')
}
