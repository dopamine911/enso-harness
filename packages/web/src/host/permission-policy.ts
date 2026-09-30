import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { EnsoPermissionPolicyRefusal } from '@enso/core'
import { Compile } from 'typebox/compile'

/**
 * Whether a permission policy is one the engine will run as written (#474), judged by the engine's
 * OWN schema (`@gotgenes/pi-permission-system/schemas/permissions.schema.json`), compiled once.
 *
 * ⚠ WHY A SAVE MUST BE REFUSED, NOT WRITTEN AND WARNED ABOUT. The engine reads a file it cannot
 * parse, or one its schema rejects, as an EMPTY policy: every call asks and every deny is gone
 * (`docs/seams/permission-mode.md`, Known gaps). A save that lands such a file drops the user's
 * denies mid-session. So Settings writes only what this accepts.
 *
 * Here and not in `@enso/core`: only the host may name the engine (`test/vendor-gate.test.ts`).
 */

type Problem = EnsoPermissionPolicyRefusal['problems'][number]

let compiled: ReturnType<typeof Compile> | undefined

/** The engine's schema, beside the package's entry point (its `exports` do not name the file). */
function engineSchema(): ReturnType<typeof Compile> {
  if (compiled !== undefined) return compiled
  const entry = createRequire(import.meta.url).resolve('@gotgenes/pi-permission-system')
  const path = join(dirname(entry), '..', 'schemas', 'permissions.schema.json')
  compiled = Compile(JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof Compile>[0])
  return compiled
}

const ACTIONS: ReadonlySet<string> = new Set(['allow', 'ask', 'deny'])

/** A rule's decision the engine accepts: an action, or `{ action: 'deny', reason? }`. */
function isDecision(value: unknown): boolean {
  if (typeof value === 'string') return ACTIONS.has(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { action, reason, ...rest } = value as Record<string, unknown>
  return action === 'deny' && (reason === undefined || typeof reason === 'string') && Object.keys(rest).length === 0
}

/**
 * The rules' problems, each at its exact place. The schema alone reports a bad pattern's decision
 * as its SURFACE failing every alternative ("must be string", "must be equal to constant"…), which
 * does not say which rule to fix.
 */
function ruleProblems(permission: unknown): Problem[] {
  if (typeof permission !== 'object' || permission === null || Array.isArray(permission)) {
    return [{ at: '/permission', message: 'a policy needs a `permission` block: without one pi runs under no rules' }]
  }
  const problems: Problem[] = []
  for (const [surface, rule] of Object.entries(permission)) {
    if (typeof rule === 'string' || typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      if (!isDecision(rule)) problems.push({ at: `/permission/${surface}`, message: 'must be allow, ask or deny' })
      continue
    }
    for (const [pattern, decision] of Object.entries(rule)) {
      if (pattern === '') problems.push({ at: `/permission/${surface}`, message: 'a pattern cannot be empty' })
      else if (!isDecision(decision)) {
        problems.push({
          at: `/permission/${surface}/${pattern}`,
          message: 'must be allow, ask, deny or a deny with a reason',
        })
      }
    }
  }
  return problems
}

/**
 * Why the engine would not run `file` as written: its rules first, each named, then whatever else
 * its schema refuses (an unknown key, a knob of the wrong type), one line per place. Empty when the
 * engine accepts it.
 */
export function policyProblems(file: Readonly<Record<string, unknown>>): Problem[] {
  const rules = ruleProblems(file.permission)
  if (rules.length > 0) return rules
  const schema = engineSchema()
  if (schema.Check(file)) return []
  const seen = new Set<string>()
  const problems: Problem[] = []
  for (const error of schema.Errors(file)) {
    const at = error.instancePath === '' ? '/' : error.instancePath
    if (seen.has(at)) continue
    seen.add(at)
    problems.push({ at, message: error.message })
  }
  return problems
}
