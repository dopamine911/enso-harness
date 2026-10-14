import {
  decisionAction,
  ENSO_CATCH_ALL,
  type EnsoDisabledRule,
  type EnsoDraftedRuleGroup,
  type EnsoGroupAddedRule,
  type EnsoPermissionDecision,
  type EnsoPermissionMap,
  type EnsoPermissionPolicyWrite,
  type EnsoPolicyRow,
  type EnsoRuleRecord,
  type EnsoSurfaceValue,
  permissionOf,
  policyRows,
  toPatternMap,
  withoutRule,
} from '@enso/core'
import { decisionAt, type SettingEdits, withGroup, withSettings } from './permissions-draft.ts'

/**
 * Switching rules and rule groups off and on (#945), on a draft of the policy's `permission` block
 * and Enso's record beside it (`ENSO_HOME/permissions.disabled.json`). Pure, as the draft's other
 * edits are: the section only holds state.
 *
 * ⚠ A RULE IS NAMED BY ITS SURFACE AND PATTERN, and a surface has one decision per pattern. So a
 * rule switched off and then written again by hand — or added again — is one rule, in force: its
 * record goes (`liveRecord`), never a second copy of it.
 */

/** The `permission` block and Enso's record, edited together and saved together. */
export interface RuleDraft {
  readonly permission: EnsoPermissionMap
  readonly record: EnsoRuleRecord
}

const sameDecision = (one: EnsoPermissionDecision, other: EnsoPermissionDecision): boolean =>
  decisionAction(one) === decisionAction(other) &&
  (typeof one === 'string' ? undefined : one.reason) === (typeof other === 'string' ? undefined : other.reason)

const isRule = (rule: EnsoDisabledRule, surface: string, pattern: string): boolean =>
  rule.surface === surface && rule.pattern === pattern

/** The record without a rule switched off that is in force again: written back by hand, or added. */
function liveRecord(record: EnsoRuleRecord, permission: EnsoPermissionMap): EnsoRuleRecord {
  const disabled = record.disabled.filter((rule) => decisionAt(permission, rule.surface, rule.pattern) === undefined)
  return disabled.length === record.disabled.length ? record : { ...record, disabled }
}

/**
 * The draft the page shows and switches: the rules edited here, or the file's own, and the record
 * switched here, or the one read — without a rule switched off that is in force again.
 */
export function ruleDraftOf(
  read: { readonly file: Readonly<Record<string, unknown>>; readonly record: EnsoRuleRecord },
  permission: EnsoPermissionMap | undefined,
  record: EnsoRuleRecord | undefined,
): RuleDraft {
  const rules = permission ?? permissionOf(read.file)
  return { permission: rules, record: liveRecord(record ?? read.record, rules) }
}

/** The rule switched off on `surface` with `pattern`, when there is one. */
export function disabledAt(record: EnsoRuleRecord, surface: string, pattern: string): EnsoDisabledRule | undefined {
  return record.disabled.find((rule) => isRule(rule, surface, pattern))
}

/**
 * The draft with the row's rule out of `permission` and in the record, with the key before it to go
 * back after. Enso's `**` is not switched off, as it is not removed: a mode needs it.
 *
 * ⚠ A surface the switch empties stays, as `{}` — no rule, the same to the engine as no key — so it
 * keeps its PLACE. Surfaces are matched as wildcards in file order, last match winning: dropped and
 * put back last, `read: { 'notes/*': 'allow' }` would come after a `'*': 'deny'` it came before, and
 * switching it off and on would turn that deny into an allow.
 */
export function withRuleDisabled(draft: RuleDraft, surface: string, pattern: string): RuleDraft {
  const { permission, record } = draft
  const value = permission[surface]
  const decision = decisionAt(permission, surface, pattern)
  if (value === undefined || decision === undefined || pattern === ENSO_CATCH_ALL) return draft
  const whole = typeof value === 'string'
  // The key before it as the page shows them, rules switched off drawn in place: a neighbour switched
  // off before it is the one it goes back after, so the two come back in their order, whichever is
  // switched on first.
  const shown = withEveryRuleEnabled(draft).permission
  const keys = Object.keys(whole ? shown : toPatternMap(shown[surface] ?? value))
  const before = keys[keys.indexOf(whole ? surface : pattern) - 1]
  const rule: EnsoDisabledRule = {
    surface,
    pattern,
    decision,
    ...(before === undefined ? {} : { after: before }),
    ...(whole ? { whole: true as const } : {}),
  }
  const rest = whole
    ? Object.fromEntries(Object.entries(permission).filter(([key]) => key !== surface))
    : withoutRule(permission, surface, pattern)
  const kept =
    whole || rest[surface] !== undefined
      ? rest
      : Object.fromEntries(Object.entries(permission).map(([key, held]) => [key, key === surface ? {} : held]))
  return { permission: kept, record: { ...record, disabled: [...record.disabled, rule] } }
}

/**
 * Where a rule switched off goes back: after a key in force, first, or — its neighbour gone from
 * the file — last. A neighbour switched off too stands for the key before IT, so rules switched off
 * one after another go back in their order.
 */
export type Placement =
  | { readonly kind: 'after'; readonly key: string }
  | { readonly kind: 'first' }
  | { readonly kind: 'gone'; readonly neighbour: string }

function placementOf(draft: RuleDraft, rule: EnsoDisabledRule): Placement {
  const value = draft.permission[rule.surface]
  let container: Readonly<Record<string, unknown>> | undefined = rule.whole === true ? draft.permission : undefined
  if (rule.whole !== true && value !== undefined) container = toPatternMap(value)
  const seen = new Set<string>()
  let after = rule.after
  while (after !== undefined) {
    if (container !== undefined && Object.hasOwn(container, after)) return { kind: 'after', key: after }
    const key: string = after
    const before = draft.record.disabled.find((other) =>
      rule.whole
        ? other.whole === true && other.surface === key
        : other.whole !== true && isRule(other, rule.surface, key),
    )
    if (before === undefined || seen.has(key)) return { kind: 'gone', neighbour: rule.after ?? key }
    seen.add(key)
    after = before.after
  }
  return { kind: 'first' }
}

/** `entries` with `[key, value]` put at `placement`; first goes after Enso's `**` when it leads. */
function placed<Value>(
  entries: readonly (readonly [string, Value])[],
  key: string,
  value: Value,
  placement: Placement,
): [string, Value][] {
  const rest = entries
    .filter(([existing]) => existing !== key)
    .map(([existing, held]): [string, Value] => [existing, held])
  let at = rest.length
  if (placement.kind === 'after') at = rest.findIndex(([existing]) => existing === placement.key) + 1
  else if (placement.kind === 'first') at = rest[0]?.[0] === ENSO_CATCH_ALL ? 1 : 0
  rest.splice(at, 0, [key, value])
  return rest
}

/** `permission` with the switched-off `rule` back in force at `placement`, under `decision`. */
function restored(
  permission: EnsoPermissionMap,
  rule: EnsoDisabledRule,
  decision: EnsoPermissionDecision,
  placement: Placement,
): EnsoPermissionMap {
  const current = permission[rule.surface]
  if (rule.whole === true && current === undefined && typeof decision === 'string') {
    return Object.fromEntries(placed<EnsoSurfaceValue>(Object.entries(permission), rule.surface, decision, placement))
  }
  // A surface written as one decision since (a hand edit) becomes a map that keeps it as `*`; a
  // whole surface's rule going back onto a map written since is its `*`, first.
  const map = current === undefined ? {} : toPatternMap(current)
  const at: Placement = rule.whole === true || current === undefined ? { kind: 'first' } : placement
  return { ...permission, [rule.surface]: Object.fromEntries(placed(Object.entries(map), rule.pattern, decision, at)) }
}

/** The draft with a rule switched off back in force, where it was (`placementOf`), and out of the record. */
export function withRuleEnabled(draft: RuleDraft, rule: EnsoDisabledRule): RuleDraft {
  const placement = placementOf(draft, rule)
  const disabled = draft.record.disabled.filter((other) => !isRule(other, rule.surface, rule.pattern))
  return {
    permission: restored(draft.permission, rule, rule.decision, placement),
    record: { ...draft.record, disabled },
  }
}

/**
 * The draft without a rule switched off: it was not in force, and now it is not kept either — nor
 * the empty surface that kept its place (`withRuleDisabled`).
 */
export function withDisabledRemoved(draft: RuleDraft, rule: EnsoDisabledRule): RuleDraft {
  const disabled = draft.record.disabled.filter((other) => !isRule(other, rule.surface, rule.pattern))
  // Kept while another rule switched off on it still holds its place.
  const value = draft.permission[rule.surface]
  const emptied = typeof value === 'object' && Object.keys(value).length === 0
  const permission =
    emptied && !disabled.some((other) => other.surface === rule.surface)
      ? Object.fromEntries(Object.entries(draft.permission).filter(([key]) => key !== rule.surface))
      : draft.permission
  return { permission, record: { ...draft.record, disabled } }
}

/** A row on screen: the rule, and — when it is switched off — the record of it and where it goes back. */
export interface ShownRow {
  readonly row: EnsoPolicyRow
  readonly disabled?: { readonly rule: EnsoDisabledRule; readonly placement: Placement }
}

/**
 * The draft with every rule switched off back in place: the order the page draws, and the one a
 * rule switched off takes its neighbour from (`withRuleDisabled`).
 */
function withEveryRuleEnabled(draft: RuleDraft): RuleDraft {
  return draft.record.disabled.reduce((current, rule) => withRuleEnabled(current, rule), draft)
}

/**
 * The rules as written, the ones switched off drawn in place: each where switching it on would put
 * it, in the engine's order. The rules in force are `policyRows(permission)`, in that order.
 */
export function shownRows(draft: RuleDraft): ShownRow[] {
  const placements = new Map(draft.record.disabled.map((rule) => [rule, placementOf(draft, rule)] as const))
  const everything = withEveryRuleEnabled(draft)
  return policyRows(everything.permission).map((row) => {
    const rule = disabledAt(draft.record, row.surface, row.pattern)
    const placement = rule === undefined ? undefined : placements.get(rule)
    return rule === undefined || placement === undefined ? { row } : { row, disabled: { rule, placement } }
  })
}

/** Whether a group's switch is on: the record holds what it added. */
export function groupIsOn(record: EnsoRuleRecord, group: EnsoDraftedRuleGroup): boolean {
  return Object.hasOwn(record.groups, group.id)
}

/**
 * The draft with the group's rules in force and the record of what it added: each rule new to the
 * file, or one whose decision it changed (`replaced`). A rule already in force as the group has it
 * stays yours and is not counted. A rule switched off is yours too: the group leaves it off.
 */
export function withGroupOn(draft: RuleDraft, group: EnsoDraftedRuleGroup): RuleDraft {
  const before = draft.permission
  let after = withGroup(before, group)
  const added: EnsoGroupAddedRule[] = []
  for (const [surface, rules] of Object.entries(after)) {
    for (const [pattern, decision] of Object.entries(toPatternMap(rules))) {
      const was = decisionAt(before, surface, pattern)
      if (was !== undefined && sameDecision(was, decision)) continue
      if (disabledAt(draft.record, surface, pattern) !== undefined) {
        after = withoutRule(after, surface, pattern)
        continue
      }
      added.push({
        surface,
        pattern,
        decision: decisionAction(decision),
        ...(was === undefined ? {} : { replaced: was }),
      })
    }
  }
  const created = Object.keys(after).filter((surface) => before[surface] === undefined)
  return {
    permission: after,
    record: {
      ...draft.record,
      groups: { ...draft.record.groups, [group.id]: created.length > 0 ? { added, created } : { added } },
    },
  }
}

/** The rules the group added that have been changed since: switching it off asks before taking them. */
export function groupEdits(draft: RuleDraft, group: EnsoDraftedRuleGroup): EnsoGroupAddedRule[] {
  return (draft.record.groups[group.id]?.added ?? []).filter((rule) => {
    const now = decisionAt(draft.permission, rule.surface, rule.pattern)
    return now !== undefined && !sameDecision(now, rule.decision)
  })
}

/**
 * `draft` without one rule a group added: out of the file — or back to the decision it replaced —
 * when it is still as the group set it, or when `takeEdited`. Switched off, it leaves the record,
 * and a decision it replaced goes back where it was.
 */
function withoutGroupRule(draft: RuleDraft, rule: EnsoGroupAddedRule, takeEdited: boolean): RuleDraft {
  const { permission, record } = draft
  const now = decisionAt(permission, rule.surface, rule.pattern)
  if (now === undefined) {
    const off = disabledAt(record, rule.surface, rule.pattern)
    if (off === undefined || !sameDecision(off.decision, rule.decision)) return draft
    const rest = withDisabledRemoved(draft, off)
    if (rule.replaced === undefined) return rest
    return { ...rest, permission: restored(permission, off, rule.replaced, placementOf(rest, off)) }
  }
  if (!sameDecision(now, rule.decision) && !takeEdited) return draft
  if (rule.replaced === undefined) return { ...draft, permission: withoutRule(permission, rule.surface, rule.pattern) }
  const map = toPatternMap(permission[rule.surface] as EnsoSurfaceValue)
  return { ...draft, permission: { ...permission, [rule.surface]: { ...map, [rule.pattern]: rule.replaced } } }
}

/**
 * The draft with the group off: each rule it added out of the file (`withoutGroupRule`), and a
 * surface it created gone when nothing but Enso's `**` is left on it. A rule changed since it was
 * added goes too only when `takeEdited`; kept, it is yours.
 */
export function withGroupOff(draft: RuleDraft, group: EnsoDraftedRuleGroup, takeEdited: boolean): RuleDraft {
  const entry = draft.record.groups[group.id]
  if (entry === undefined) return draft
  const taken = entry.added.reduce((current, rule) => withoutGroupRule(current, rule, takeEdited), draft)
  const emptied = new Set(
    (entry.created ?? []).filter((surface) => {
      const left = taken.permission[surface]
      return left !== undefined && Object.keys(toPatternMap(left)).every((pattern) => pattern === ENSO_CATCH_ALL)
    }),
  )
  const permission = Object.fromEntries(Object.entries(taken.permission).filter(([surface]) => !emptied.has(surface)))
  const groups = Object.fromEntries(Object.entries(taken.record.groups).filter(([id]) => id !== group.id))
  return { permission, record: { ...taken.record, groups } }
}

/**
 * What a save sends over `base`, the files as read (#935, #945): the settings edited, then the rules
 * — the file's own where none is edited — and Enso's record when it was switched here, or when a
 * rule it holds is in force again. One write, under the one ETag.
 */
export function savedWrite(
  base: { readonly file: Readonly<Record<string, unknown>>; readonly record: EnsoRuleRecord },
  edits: {
    readonly permission: EnsoPermissionMap | undefined
    readonly settings: SettingEdits | undefined
    readonly record: EnsoRuleRecord | undefined
  },
): EnsoPermissionPolicyWrite {
  const settled = withSettings(base.file, edits.settings ?? {})
  const file = edits.permission === undefined ? settled : { ...settled, permission: edits.permission }
  const record = liveRecord(edits.record ?? base.record, permissionOf(file))
  return edits.record === undefined && record === base.record ? { file } : { file, record }
}
