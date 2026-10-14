import {
  decisionAction,
  ENSO_CATCH_ALL,
  type EnsoDraftedRuleGroup,
  type EnsoPermissionAction,
  type EnsoPermissionDecision,
  type EnsoPermissionMap,
  type EnsoPolicyRow,
  hasRule,
  permissionOf,
  withRule,
} from '@enso/core'

/**
 * The Permissions section's edits and reading aids (#474), on a draft of the file's `permission`
 * block: the edits the core helpers do not make (an action changed in place, a pattern renamed in
 * place), a drafted group added whole, and a reset's diff. Pure, so the section only holds state.
 */

/** The surfaces "Try a command" offers before any the file names: the tools and the path gates. */
const CHECK_SURFACES: readonly string[] = [
  'bash',
  'read',
  'edit',
  'write',
  'path',
  'path_read',
  'path_write',
  'web_fetch',
  'web_search',
  'ask_user',
]

/**
 * The surfaces a rule can be added to, or a value checked on: the known ones, then the file's own.
 * ⚠ Not the top-level `*`: it is the fallback for every surface and takes a single action (#474).
 */
export function surfaceChoices(permission: EnsoPermissionMap): string[] {
  const named = Object.keys(permission).filter((surface) => surface !== '*' && !CHECK_SURFACES.includes(surface))
  return [...CHECK_SURFACES, ...named]
}

/** The shorthands the engine expands before any call meets them, and the directions each stands for. */
const SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
  path: ['path_read', 'path_write'],
  external_directory: ['external_directory_read', 'external_directory_write'],
}

/**
 * The surfaces "Try a command" offers: `surfaceChoices` with each shorthand followed by its
 * directions. ⚠ The engine answers a shorthand as the stricter of its two directions (its resolver's
 * fold, as for a shell command naming a path it cannot tell is read or written), and the host asks
 * the guards both calls (#874); a direction is asked alone.
 */
export function checkSurfaces(permission: EnsoPermissionMap): string[] {
  return [...new Set(surfaceChoices(permission).flatMap((surface) => [surface, ...(SHORTHANDS[surface] ?? [])]))]
}

/** The decision `pattern` has on `surface`, when it is there. */
function decisionAt(
  permission: EnsoPermissionMap,
  surface: string,
  pattern: string,
): EnsoPermissionDecision | undefined {
  const value = permission[surface]
  if (typeof value === 'string') return pattern === '*' ? value : undefined
  return value?.[pattern]
}

/**
 * `permission` with the rule's action changed where it stands. A surface written as one action
 * stays one action (the top-level `*` must), and a deny keeps the reason it was written with.
 * ⚠ Not `withRule`: that sends a `path` rule to the directions the file spells out, and this row
 * is on the surface it is shown on.
 */
export function withAction(
  permission: EnsoPermissionMap,
  surface: string,
  pattern: string,
  action: EnsoPermissionAction,
): EnsoPermissionMap {
  const current = permission[surface]
  if (current === undefined || typeof current === 'string') return { ...permission, [surface]: action }
  const existing = current[pattern]
  const keepsReason = typeof existing === 'object' && action === 'deny'
  return { ...permission, [surface]: { ...current, [pattern]: keepsReason ? existing : action } }
}

export type Renamed = { readonly permission: EnsoPermissionMap } | { readonly refusal: string }

/** `permission` with `from` renamed `to` on `surface`, in the same place — order is precedence. */
export function withPatternRenamed(permission: EnsoPermissionMap, surface: string, from: string, to: string): Renamed {
  const current = permission[surface]
  if (typeof current !== 'object' || from === ENSO_CATCH_ALL) return { refusal: `${from} cannot be renamed` }
  if (to.length === 0) return { refusal: 'a pattern cannot be empty' }
  if (to === ENSO_CATCH_ALL) return { refusal: `${ENSO_CATCH_ALL} is Enso's catch-all; a mode needs it` }
  if (to !== from && Object.hasOwn(current, to)) return { refusal: `${surface} already has ${to}` }
  const renamed = Object.entries(current).map(([pattern, decision]) => [pattern === from ? to : pattern, decision])
  return { permission: { ...permission, [surface]: Object.fromEntries(renamed) } }
}

/** Why a new rule cannot be added as typed; `undefined` when it can. */
export function newRuleRefusal(permission: EnsoPermissionMap, surface: string, pattern: string): string | undefined {
  if (pattern.length === 0) return 'type a pattern'
  if (pattern === ENSO_CATCH_ALL) return `${ENSO_CATCH_ALL} is Enso's catch-all: change its action in the list`
  if (decisionAt(permission, surface, pattern) !== undefined) {
    return `${surface} already has ${pattern}: change it in the list`
  }
  return undefined
}

/** `permission` with every rule of `group` not already in force, each last on its surface (after `**`). */
export function withGroup(permission: EnsoPermissionMap, group: EnsoDraftedRuleGroup): EnsoPermissionMap {
  return group.rules.reduce(
    (draft, rule) =>
      hasRule(draft, rule.surface, rule.pattern, rule.decision)
        ? draft
        : withRule(draft, rule.surface, rule.pattern, rule.decision),
    permission,
  )
}

/** Rows as the engine orders them, run together per surface. */
export function rowsBySurface(
  rows: readonly EnsoPolicyRow[],
): { readonly surface: string; readonly rows: readonly EnsoPolicyRow[] }[] {
  const groups: { surface: string; rows: EnsoPolicyRow[] }[] = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last?.surface === row.surface) last.rows.push(row)
    else groups.push({ surface: row.surface, rows: [row] })
  }
  return groups
}

/** A decision in words: its action, and a deny's reason. */
function decisionWords(decision: EnsoPermissionDecision): string {
  if (typeof decision === 'string' || decision.reason === undefined) return decisionAction(decision)
  return `deny — ${decision.reason}`
}

/** One difference a reset would make: a rule on a surface, or one of the file's other settings. */
export interface PolicyChange {
  readonly kind: 'added' | 'removed' | 'changed'
  /** The surface, or `settings` for a key beside `permission`. */
  readonly section: string
  /** The pattern, or the setting's key. */
  readonly subject: string
  readonly before?: string
  readonly after?: string
}

/** The differences between two `section → subject → words` tables, `after`'s order first. */
function tableDiff(
  before: ReadonlyMap<string, ReadonlyMap<string, string>>,
  after: ReadonlyMap<string, ReadonlyMap<string, string>>,
): PolicyChange[] {
  const sections = [...new Set([...after.keys(), ...before.keys()])]
  return sections.flatMap((section) => {
    const was = before.get(section) ?? new Map<string, string>()
    const will = after.get(section) ?? new Map<string, string>()
    return [...new Set([...will.keys(), ...was.keys()])].flatMap((subject): PolicyChange[] => {
      const beforeWords = was.get(subject)
      const afterWords = will.get(subject)
      if (beforeWords === afterWords) return []
      if (beforeWords === undefined)
        return afterWords === undefined ? [] : [{ kind: 'added', section, subject, after: afterWords }]
      if (afterWords === undefined) return [{ kind: 'removed', section, subject, before: beforeWords }]
      return [{ kind: 'changed', section, subject, before: beforeWords, after: afterWords }]
    })
  })
}

/** A file as `section → subject → words`: its rules per surface, then its other settings. */
function fileTable(file: Readonly<Record<string, unknown>>): Map<string, Map<string, string>> {
  const table = new Map<string, Map<string, string>>()
  for (const [surface, surfaceValue] of Object.entries(permissionOf(file))) {
    const patterns: [string, EnsoPermissionDecision][] =
      typeof surfaceValue === 'string' ? [['*', surfaceValue]] : Object.entries(surfaceValue)
    table.set(surface, new Map(patterns.map(([pattern, decision]) => [pattern, decisionWords(decision)])))
  }
  const settings = Object.entries(file).filter(([key]) => key !== 'permission')
  if (settings.length > 0) {
    table.set('settings', new Map(settings.map(([key, value]) => [key, JSON.stringify(value)])))
  }
  return table
}

/** What replacing `current` (absent: unreadable) with `target` changes, rule by rule and setting by setting. */
export function policyDiff(
  current: Readonly<Record<string, unknown>> | undefined,
  target: Readonly<Record<string, unknown>>,
): PolicyChange[] {
  return tableDiff(fileTable(current ?? {}), fileTable(target))
}

/**
 * The Behaviour part's edits (#935), key by key over the file's settings beside `permission`: a
 * key's new value, or `undefined` — the key taken off the file, so the engine's default is in force.
 * A key not named is untouched.
 */
export type SettingEdits = Readonly<Record<string, unknown>>

/**
 * `file` with `edits` applied: an edited key keeps its place, a removed one goes, a new one comes
 * last. Every key not edited — the rules among them — is the file's own, untouched.
 */
export function withSettings(file: Readonly<Record<string, unknown>>, edits: SettingEdits): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [settingKey, settingValue] of Object.entries(file)) {
    if (!Object.hasOwn(edits, settingKey)) next[settingKey] = settingValue
    else if (edits[settingKey] !== undefined) next[settingKey] = edits[settingKey]
  }
  for (const [settingKey, edited] of Object.entries(edits)) {
    if (!Object.hasOwn(file, settingKey) && edited !== undefined) next[settingKey] = edited
  }
  return next
}
