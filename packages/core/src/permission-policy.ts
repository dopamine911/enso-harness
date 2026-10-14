import { type Static, Type } from 'typebox'
import { EnsoGuardCheck } from './guard.ts'
import {
  ENSO_AUTO_AUTHORIZER,
  ENSO_CATCH_ALL,
  ENSO_MODE_PRESETS,
  type EnsoPermissionModeName,
} from './permission-modes.ts'

/**
 * The user's permission policy as Settings shows and edits it (#474): `ENSO_HOME/permissions.json`,
 * in the engine's format — a `permission` map of surface → a decision, or pattern → decision (last
 * match wins) — plus the knobs the same file carries.
 *
 * ⚠ ONE READING OF THE ENGINE'S RULES, AND IT IS PINNED TO THE ENGINE. What a mode does to the file
 * (`effectivePermission`) is the engine's own merge, modelled here so the page can show every mode
 * without a live session: the `path` / `external_directory` shorthand expands into its two
 * directions, then the mode's preset merges over the user's map key by key when both sides are
 * maps, and REPLACES the surface when either side is a single decision (`plan`'s `edit: 'deny'`
 * drops every edit rule the user wrote). `agent-host.test.ts` asks the real engine the same
 * questions in every mode, so this model cannot drift from it unnoticed. Re-pinned against 40.0.2
 * (#744), whose `expandDirectionalSugar` and `mergeFlatPermissions` are unchanged; it still exports
 * no resolved policy to read instead (#517 item 3).
 *
 * Nothing here reads or writes the file; the host does (`host/permission-policy-file.ts`), for the
 * server's routes.
 *
 * @group Permission policy
 */

/** @group Permission policy */
export const EnsoPermissionAction = Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')])
/** @group Permission policy */
export type EnsoPermissionAction = Static<typeof EnsoPermissionAction>

/**
 * A rule's decision as the file writes it: an action, or a deny with the reason the agent is told.
 *
 * @group Permission policy
 */
export type EnsoPermissionDecision = EnsoPermissionAction | { readonly action: 'deny'; readonly reason?: string }

/** @group Permission policy */
export type EnsoSurfaceValue = EnsoPermissionAction | Readonly<Record<string, EnsoPermissionDecision>>

/**
 * A file's `permission` block: surface → value, in the file's order.
 *
 * @group Permission policy
 */
export type EnsoPermissionMap = Readonly<Record<string, EnsoSurfaceValue>>

/** @group Permission policy */
export function decisionAction(decision: EnsoPermissionDecision): EnsoPermissionAction {
  return typeof decision === 'string' ? decision : decision.action
}

/**
 * The file's `permission` block, or an empty one. The server has validated the file against the
 * engine's schema before anything reads it this way.
 *
 * @group Permission policy
 */
export function permissionOf(file: Readonly<Record<string, unknown>>): EnsoPermissionMap {
  const permission = file.permission
  return typeof permission === 'object' && permission !== null ? (permission as EnsoPermissionMap) : {}
}

/**
 * Who a row belongs to. `catch-all` is Enso's `**`, the one key a mode changes (#499); `yours` is
 * every rule after it, which holds in every mode; `mode` is a rule the mode's preset put there (only
 * in an effective view).
 *
 * @group Permission policy
 */
export type EnsoPolicyRowOwner = 'catch-all' | 'yours' | 'mode'

/** @group Permission policy */
export interface EnsoPolicyRow {
  readonly surface: string
  /** `*` for a surface written as a single decision. */
  readonly pattern: string
  readonly decision: EnsoPermissionDecision
  readonly owner: EnsoPolicyRowOwner
  /** Why an `allow` on this pattern lets the agent run code it wrote, unasked; absent when it does not. */
  readonly runsCode?: string
}

/** Whose a rule is: the mode's when its preset put it there, else Enso's `**` or the user's. */
function ownerOf(
  surface: string,
  pattern: string,
  modeKeys: ReadonlyMap<string, ReadonlySet<string>>,
): EnsoPolicyRowOwner {
  if (modeKeys.get(surface)?.has(pattern) === true) return 'mode'
  return pattern === ENSO_CATCH_ALL ? 'catch-all' : 'yours'
}

/**
 * The rules, in the engine's order: surfaces as the map orders them, patterns as each surface does.
 * `modeKeys` names, per surface, the patterns a mode's preset contributed (`effectiveRows`).
 */
function rowsOf(permission: EnsoPermissionMap, modeKeys: ReadonlyMap<string, ReadonlySet<string>>): EnsoPolicyRow[] {
  return Object.entries(permission).flatMap(([surface, value]) => {
    const entries: [string, EnsoPermissionDecision][] =
      typeof value === 'string' ? [['*', value]] : Object.entries(value)
    return entries.map(([pattern, decision]) => {
      const owner = ownerOf(surface, pattern, modeKeys)
      const runsCode = runsAnyCode(surface, pattern, decision)
      return runsCode === undefined
        ? { surface, pattern, decision, owner }
        : { surface, pattern, decision, owner, runsCode }
    })
  })
}

/**
 * The file's own rules, as written.
 *
 * @group Permission policy
 */
export function policyRows(permission: EnsoPermissionMap): EnsoPolicyRow[] {
  return rowsOf(permission, new Map())
}

/** The shorthand surfaces and the two directions each stands for (the engine's `surfaceFamilyMembers`). */
const DIRECTIONAL: Readonly<Record<string, readonly [string, string]>> = {
  path: ['path_read', 'path_write'],
  external_directory: ['external_directory_read', 'external_directory_write'],
}

const toPatternMap = (value: EnsoSurfaceValue): Readonly<Record<string, EnsoPermissionDecision>> =>
  typeof value === 'string' ? { '*': value } : value

/** The engine's `expandDirectionalSugar`: a shorthand's entries first, then the direction's own. */
function expandDirectional(permission: EnsoPermissionMap): Record<string, EnsoSurfaceValue> {
  const expanded: Record<string, EnsoSurfaceValue> = {}
  for (const [surface, rule] of Object.entries(permission)) {
    const members = DIRECTIONAL[surface]
    if (members === undefined) {
      if (!Object.hasOwn(expanded, surface)) expanded[surface] = rule
      continue
    }
    for (const member of members) {
      const explicit = permission[member]
      if (explicit === undefined) {
        expanded[member] = typeof rule === 'string' ? rule : { ...rule }
        continue
      }
      const explicitPatterns = toPatternMap(explicit)
      const sugar = Object.entries(toPatternMap(rule)).filter(([pattern]) => !Object.hasOwn(explicitPatterns, pattern))
      expanded[member] = { ...Object.fromEntries(sugar), ...explicitPatterns }
    }
  }
  return expanded
}

/**
 * The permission map the engine runs under in `mode`, and which patterns the mode put there: the
 * user's map with the mode's preset merged over it (see the module's ⚠).
 */
function mergedForMode(
  permission: EnsoPermissionMap,
  mode: EnsoPermissionModeName,
): { readonly permission: EnsoPermissionMap; readonly modeKeys: ReadonlyMap<string, ReadonlySet<string>> } {
  const merged: Record<string, EnsoSurfaceValue> = expandDirectional(permission)
  const modeKeys = new Map<string, Set<string>>()
  for (const [surface, presetRule] of Object.entries(expandDirectional(ENSO_MODE_PRESETS[mode].permission))) {
    const base = merged[surface]
    if (typeof base === 'object' && typeof presetRule === 'object') {
      merged[surface] = { ...base, ...presetRule }
      modeKeys.set(surface, new Set(Object.keys(presetRule)))
    } else {
      merged[surface] = presetRule
      modeKeys.set(surface, new Set(Object.keys(toPatternMap(presetRule))))
    }
  }
  return { permission: merged, modeKeys }
}

/** @group Permission policy */
export function effectivePermission(permission: EnsoPermissionMap, mode: EnsoPermissionModeName): EnsoPermissionMap {
  return mergedForMode(permission, mode).permission
}

/**
 * The rules the engine runs under in `mode`, each marked with who it belongs to: a rule the mode put
 * there is `mode`, even where it replaced one of yours (`plan`'s `edit`).
 *
 * @group Permission policy
 */
export function effectiveRows(permission: EnsoPermissionMap, mode: EnsoPermissionModeName): EnsoPolicyRow[] {
  const merged = mergedForMode(permission, mode)
  return rowsOf(merged.permission, merged.modeKeys)
}

/**
 * The knobs the policy file carries beside its rules that change what is asked, and what is kept.
 *
 * @group Permission policy
 */
export interface EnsoPolicyKnobs {
  /** `yoloMode`: every ask becomes allow, in every mode. */
  readonly yoloMode: boolean
  /** `permissionReviewLog` (on unless the file says `false`): every decision is written to a log. */
  readonly reviewLog: boolean
  /** Enso's classifier is in `authorizerChain`, so `auto` classifies rather than asks. */
  readonly autoClassifier: boolean
}

/** @group Permission policy */
export function policyKnobs(file: Readonly<Record<string, unknown>>): EnsoPolicyKnobs {
  const chain = file.authorizerChain
  return {
    yoloMode: file.yoloMode === true,
    reviewLog: file.permissionReviewLog !== false,
    autoClassifier: Array.isArray(chain) && chain.includes(ENSO_AUTO_AUTHORIZER),
  }
}

/**
 * Command patterns that, allowed, let the agent run code it wrote without asking: the interpreter
 * one-liners, the runners that take any script or command, and `find` (whose `-exec` the engine
 * floors to a question anyway — the pattern is flagged for what it means, not for what gets through).
 */
const RUNS_CODE: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^\*$/, why: 'allows every command' },
  {
    pattern: /^(?:python3?|node|deno|bun|ruby|perl|php|lua)\s+(?:-c|-e|-p|-r|eval)\b/,
    why: 'runs code passed on the command line',
  },
  { pattern: /^(?:ba|z|da)?sh\s+-c\b/, why: 'runs any shell command passed to it' },
  { pattern: /^(?:eval|xargs|env|sudo|exec)\b/, why: 'runs any command given to it' },
  {
    pattern: /^(?:npm|pnpm|yarn|bun)\s+(?:run|exec|x)\b|^(?:npx|bunx|pnpx)\b/,
    why: 'runs a package script or package',
  },
  { pattern: /^(?:make|just)\b/, why: 'runs whatever the project’s build file says' },
  { pattern: /^find\b/, why: 'find -exec runs commands (the engine asks for it anyway)' },
]

/**
 * Why allowing `pattern` on `surface` lets the agent run code it chose, unasked; `undefined` when it
 * does not, or when the decision is not `allow`.
 *
 * @group Permission policy
 */
export function runsAnyCode(surface: string, pattern: string, decision: EnsoPermissionDecision): string | undefined {
  if (surface !== 'bash' || decisionAction(decision) !== 'allow') return undefined
  return RUNS_CODE.find((rule) => rule.pattern.test(pattern.trim()))?.why
}

/**
 * A rule Settings offers to add, grouped by what it stops or allows (#474). Opt-in: nothing here is
 * applied until the user adds it, and it lands after `**`, so it holds in every mode.
 *
 * @group Permission policy
 */
export interface EnsoDraftedRuleGroup {
  readonly id: string
  readonly title: string
  readonly note: string
  readonly rules: readonly {
    readonly surface: string
    readonly pattern: string
    readonly decision: EnsoPermissionAction
  }[]
}

/** @group Permission policy */
export const ENSO_DRAFTED_RULE_GROUPS: readonly EnsoDraftedRuleGroup[] = [
  {
    id: 'publishing',
    title: 'Publishing',
    note: 'Denied: nothing leaves as a release or a merge without you doing it yourself.',
    rules: [
      { surface: 'bash', pattern: 'npm publish*', decision: 'deny' },
      { surface: 'bash', pattern: 'bun publish*', decision: 'deny' },
      { surface: 'bash', pattern: 'gh release create*', decision: 'deny' },
      { surface: 'bash', pattern: 'gh pr merge*', decision: 'deny' },
    ],
  },
  {
    id: 'remote-writes',
    title: 'Remote writes',
    note: 'Asked, in every mode: a push, a pull request or a POST leaves your machine.',
    rules: [
      { surface: 'bash', pattern: 'git push *', decision: 'ask' },
      { surface: 'bash', pattern: 'gh pr create*', decision: 'ask' },
      { surface: 'bash', pattern: 'curl * -X POST*', decision: 'ask' },
    ],
  },
  {
    id: 'secrets',
    title: 'Secrets on the path gate',
    note: 'Denied on the path gate, for the tools that take a path. Whatever these rules say, a guard refuses these paths in every mode: for those tools (secret-read) and named in a shell command (secret-path).',
    rules: [
      { surface: 'path', pattern: '~/.ssh/*', decision: 'deny' },
      { surface: 'path', pattern: '~/.aws/*', decision: 'deny' },
      { surface: 'path', pattern: '*.pem', decision: 'deny' },
    ],
  },
]

/**
 * The surfaces a rule for `surface` belongs on. ⚠ A `path` / `external_directory` rule goes into
 * each direction the file already spells out: the engine puts a shorthand's entries BEFORE a
 * direction's own, so on the seed — `path_read: { '**': 'allow', … }` — a deny written on `path`
 * would land before that `**` allow and never win (last match wins). Found in review of #474.
 */
function targetSurfaces(permission: EnsoPermissionMap, surface: string): readonly string[] {
  const members = DIRECTIONAL[surface]
  if (members === undefined) return [surface]
  const spelled = members.filter((member) => permission[member] !== undefined)
  return spelled.length === 0 ? [surface] : spelled
}

/**
 * `permission` with `pattern` on `surface` set to `decision`: in place when the pattern is there,
 * appended otherwise — last, so it wins over what came before, and after `**`, so it holds in every
 * mode. A surface written as a single decision becomes a map that keeps it as `*`. A shorthand
 * surface's rule lands on its spelled-out directions (`targetSurfaces`).
 *
 * @group Permission policy
 */
export function withRule(
  permission: EnsoPermissionMap,
  surface: string,
  pattern: string,
  decision: EnsoPermissionDecision,
): EnsoPermissionMap {
  // One copy, written in place: the loop visits each target surface once, so this is the spread
  // per surface it replaced without copying the whole map again for each (#596).
  const updated: Record<string, EnsoSurfaceValue> = { ...permission }
  for (const target of targetSurfaces(permission, surface)) {
    const current = updated[target]
    const map = current === undefined ? {} : toPatternMap(current)
    updated[target] = { ...map, [pattern]: decision }
  }
  return updated
}

/**
 * Whether `pattern` is already on `surface` with `decision` — on every direction a shorthand rule
 * would land on — so a drafted rule already in force is not offered again.
 *
 * @group Permission policy
 */
export function hasRule(
  permission: EnsoPermissionMap,
  surface: string,
  pattern: string,
  decision: EnsoPermissionDecision,
): boolean {
  return targetSurfaces(permission, surface).every((target) => {
    const current = permission[target]
    if (current === undefined) return false
    const existing = toPatternMap(current)[pattern]
    return existing !== undefined && decisionAction(existing) === decisionAction(decision)
  })
}

/**
 * `permission` without `pattern` on `surface`; a surface left with no rule is dropped. Enso's `**`
 * is not a user's to remove: a mode needs it.
 *
 * @group Permission policy
 */
export function withoutRule(permission: EnsoPermissionMap, surface: string, pattern: string): EnsoPermissionMap {
  const current = permission[surface]
  if (current === undefined || pattern === ENSO_CATCH_ALL) return permission
  const remaining = Object.entries(toPatternMap(current)).filter(([key]) => key !== pattern)
  if (remaining.length > 0) return { ...permission, [surface]: Object.fromEntries(remaining) }
  return Object.fromEntries(Object.entries(permission).filter(([key]) => key !== surface))
}

/**
 * `permission` with `pattern` moved one place earlier (`-1`) or later (`1`) on its surface. Order is
 * the engine's precedence: last match wins. Nothing moves above `**` or moves `**`.
 *
 * @group Permission policy
 */
export function withRuleMoved(
  permission: EnsoPermissionMap,
  surface: string,
  pattern: string,
  direction: -1 | 1,
): EnsoPermissionMap {
  const current = permission[surface]
  if (typeof current !== 'object') return permission
  const entries = Object.entries(current)
  const from = entries.findIndex(([key]) => key === pattern)
  const to = from + direction
  const blocked =
    from < 0 || to < 0 || to >= entries.length || pattern === ENSO_CATCH_ALL || entries[to]?.[0] === ENSO_CATCH_ALL
  if (blocked) return permission
  const moved = [...entries]
  const [entry] = moved.splice(from, 1)
  if (entry !== undefined) moved.splice(to, 0, entry)
  return { ...permission, [surface]: Object.fromEntries(moved) }
}

/** A rule's decision on the wire: an action, or a deny with the reason the agent is told. */
const EnsoPermissionDecisionSchema = Type.Union([
  EnsoPermissionAction,
  Type.Object({ action: Type.Literal('deny'), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
])

/**
 * A rule switched off in Settings (#945): out of the engine's `permission` block, kept here to go
 * back where it was. `after` is the key before it in the map it came from — the pattern before it on
 * its surface, or, for a surface written as one decision (`whole`), the surface before it — and is
 * absent when it was first.
 *
 * @group Permission policy
 */
export const EnsoDisabledRule = Type.Object(
  {
    surface: Type.String({ minLength: 1 }),
    pattern: Type.String({ minLength: 1 }),
    decision: EnsoPermissionDecisionSchema,
    after: Type.Optional(Type.String()),
    /** The surface was written as this one decision: `pattern` is `*`, and it goes back as the surface's value. */
    whole: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoDisabledRule = Static<typeof EnsoDisabledRule>

/**
 * A rule a group's switch put in the file (#945). `replaced` is the decision the same pattern had
 * before the group set its own: switching the group off puts it back instead of removing the rule.
 *
 * @group Permission policy
 */
export const EnsoGroupAddedRule = Type.Object(
  {
    surface: Type.String({ minLength: 1 }),
    pattern: Type.String({ minLength: 1 }),
    decision: EnsoPermissionAction,
    replaced: Type.Optional(EnsoPermissionDecisionSchema),
  },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoGroupAddedRule = Static<typeof EnsoGroupAddedRule>

/**
 * Enso's own record beside the policy file (#945), `ENSO_HOME/permissions.disabled.json`: the rules
 * switched off, and, per rule group switched on, the rules it added and the surfaces it created.
 *
 * ⚠ A SIDECAR, NOT A KEY OF `permissions.json`: the engine's schema refuses any top-level key it
 * does not know (`additionalProperties: false`), and it reads a file its schema refuses as an EMPTY
 * policy. The engine never reads this file.
 *
 * @group Permission policy
 */
export const EnsoRuleRecord = Type.Object(
  {
    disabled: Type.Array(EnsoDisabledRule),
    groups: Type.Record(
      Type.String(),
      Type.Object(
        { added: Type.Array(EnsoGroupAddedRule), created: Type.Optional(Type.Array(Type.String())) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoRuleRecord = Static<typeof EnsoRuleRecord>

/**
 * The record before anything is switched: what a missing file reads as.
 *
 * @group Permission policy
 */
export const ENSO_EMPTY_RULE_RECORD: EnsoRuleRecord = { disabled: [], groups: {} }

/**
 * `GET /api/permissions` (#474): the policy file as read, with its `ETag` — or why it cannot be
 * read, since the engine reads a file it cannot parse as an EMPTY policy (every call asks, every
 * deny gone) and the page must say so rather than show nothing. The `ETag` names the policy file and
 * Enso's record beside it together (#945): a save writes both, or neither.
 *
 * @group Permission policy
 */
export const EnsoPermissionPolicyRead = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('ok'),
      path: Type.String(),
      etag: Type.String(),
      file: Type.Record(Type.String(), Type.Unknown()),
      /** Where the engine writes its review log, when `permissionReviewLog` is on. */
      reviewLogDirectory: Type.String(),
      /** Enso's default policy, for a reset's diff: the page cannot import it (it lives with `node:fs`). */
      ensoDefault: Type.Record(Type.String(), Type.Unknown()),
      /** Enso's record beside the file (#945): the rules switched off, and what each group added. */
      record: EnsoRuleRecord,
      recordPath: Type.String(),
      /** Why the record on disk cannot be read: it is shown empty, and a save that writes it replaces it. */
      recordProblem: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('unreadable'),
      path: Type.String(),
      etag: Type.Optional(Type.String()),
      reason: Type.String(),
      reviewLogDirectory: Type.String(),
      ensoDefault: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
])
/** @group Permission policy */
export type EnsoPermissionPolicyRead = Static<typeof EnsoPermissionPolicyRead>

/**
 * `PUT /api/permissions`'s body: the whole file as the page wants it, and Enso's record when the
 * page changed it (#945; absent, the record on disk stays). The server validates the file against
 * the engine's own schema, puts `**` first where a mode needs it, and writes both atomically.
 *
 * @group Permission policy
 */
export const EnsoPermissionPolicyWrite = Type.Object(
  { file: Type.Record(Type.String(), Type.Unknown()), record: Type.Optional(EnsoRuleRecord) },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoPermissionPolicyWrite = Static<typeof EnsoPermissionPolicyWrite>

/**
 * `POST /api/permissions/reset`'s answer: Enso's default policy is in force, and the file it
 * replaced is kept at `backup` (never overwritten: the first free `permissions.json.bak[.N]`) —
 * absent when there was no file to keep.
 *
 * @group Permission policy
 */
export const EnsoPermissionPolicyReset = Type.Object(
  { backup: Type.Optional(Type.String()), policy: EnsoPermissionPolicyRead },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoPermissionPolicyReset = Static<typeof EnsoPermissionPolicyReset>

/**
 * A save the engine's schema refused: nothing was written, and each problem says where.
 *
 * @group Permission policy
 */
export const EnsoPermissionPolicyRefusal = Type.Object(
  {
    reason: Type.String(),
    problems: Type.Array(Type.Object({ at: Type.String(), message: Type.String() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoPermissionPolicyRefusal = Static<typeof EnsoPermissionPolicyRefusal>

/**
 * `POST /api/threads/:threadId/permissions/check`'s body: a value on a surface — a command for
 * `bash`, a path for a path gate, a tool name for a tool.
 *
 * @group Permission policy
 */
export const EnsoPermissionCheckRequest = Type.Object(
  { surface: Type.String({ minLength: 1, maxLength: 64 }), value: Type.String({ maxLength: 4000 }) },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoPermissionCheckRequest = Static<typeof EnsoPermissionCheckRequest>

/**
 * A thread's verdict on a value, layer by layer, as a call meets them (#474, #881): the guards first
 * (`guard`), then the engine in the thread's mode — its decision, the pattern that won and where that
 * rule came from (`global` is the user's file, `agent` the mode's preset). A guard's refusal decides:
 * the engine is never asked about a refused call, so its fields then say what it WOULD answer, moot.
 *
 * @group Permission policy
 */
export const EnsoPermissionVerdict = Type.Object(
  {
    mode: Type.String(),
    guard: EnsoGuardCheck,
    state: EnsoPermissionAction,
    matchedPattern: Type.Optional(Type.String()),
    origin: Type.String(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Permission policy */
export type EnsoPermissionVerdict = Static<typeof EnsoPermissionVerdict>
