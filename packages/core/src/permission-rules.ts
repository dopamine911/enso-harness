/**
 * The permission rules pi runs under (#446): `ENSO_HOME/permissions.json`, never a copy of
 * another tool's settings.
 *
 * The permission-modes extension reads its user rules from the file the host and the terminal
 * launcher point it at. Two facts about how it reads them make this module necessary:
 *
 *   1. Left unpointed, it reads a `config.json` inside its own `node_modules` directory: one
 *      copy per checkout, reset by `bun install`, outside `ENSO_HOME`.
 *   2. ⚠ A file with NO RULES is read as "import Claude Code's": the extension then reads
 *      `~/.claude/settings.json` and writes its `permissions` block into the file. It does that
 *      every time the file is empty, not once. So Enso never lets the extension see an empty
 *      or missing file: `preparePermissionRules` seeds `ENSO_DEFAULT_DENY_RULES` first.
 *
 * A file that is there and unreadable refuses the launch rather than being replaced: it is a
 * policy file, like `ENSO_HOME/config.json`, and the extension would otherwise treat it as
 * empty and import Claude Code's rules into it.
 *
 * Only plain JSON is accepted. The extension also strips JavaScript-style comments before it
 * parses, so every file this module accepts, the extension reads the same way. A commented file
 * is refused here even though the extension would read it; that is the safe direction.
 *
 * @module
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The rules a fresh `ENSO_HOME` starts with: the git escapes Enso's guards do not already
 * refuse (force-push is `cc-safety-net`'s `git.push-force`). Deny rules only, so seeding never
 * widens what runs without asking.
 *
 * ⚠ `git commit * -n*` is deliberately absent: through the extension's matcher it also denies
 * a commit whose MESSAGE contains ` -n` (probed). `-n` right after `commit` is still denied.
 *
 * @group Permission mode
 */
export const ENSO_DEFAULT_DENY_RULES: readonly string[] = [
  'Bash(git commit --no-verify*)',
  'Bash(git commit * --no-verify*)',
  'Bash(git commit -n*)',
  'Bash(git push --delete *)',
  'Bash(git push * --delete *)',
]

/**
 * How many rules of each behaviour a permissions file holds, counted as the extension counts
 * them: strings that are not blank, in the `permissions` block's `allow`, `deny` and `ask`.
 *
 * @group Permission mode
 */
export interface PermissionRuleCounts {
  readonly allow: number
  readonly deny: number
  readonly ask: number
}

/**
 * What `preparePermissionRules` found and did.
 *
 * - `kept`: the file holds rules; it is used as it is.
 * - `seeded`: the file was absent, or held no rules, and now holds `ENSO_DEFAULT_DENY_RULES`.
 * - `unreadable`: the file is there but is not a JSON object; nothing was written, and the
 *   caller refuses to start.
 *
 * @group Permission mode
 */
export type PermissionRulesPreparation =
  | { readonly kind: 'kept'; readonly path: string; readonly counts: PermissionRuleCounts }
  | { readonly kind: 'seeded'; readonly path: string; readonly was: 'absent' | 'without rules' }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string }

function countRules(value: unknown): number {
  return Array.isArray(value) ? value.filter((rule) => typeof rule === 'string' && rule.trim().length > 0).length : 0
}

function countsOf(file: Readonly<Record<string, unknown>>): PermissionRuleCounts {
  const block = file.permissions
  if (typeof block !== 'object' || block === null) return { allow: 0, deny: 0, ask: 0 }
  const rules = block as Readonly<Record<string, unknown>>
  return { allow: countRules(rules.allow), deny: countRules(rules.deny), ask: countRules(rules.ask) }
}

/**
 * Make `path` a permissions file the extension will use as it is: keep one that holds rules,
 * seed one that is absent or holds none, and refuse one that is not a JSON object. Seeding
 * keeps every other top-level key the file had.
 *
 * Call it before the extension loads, with the path the extension is pointed at.
 *
 * @group Permission mode
 */
export function preparePermissionRules(path: string): PermissionRulesPreparation {
  let existing: Record<string, unknown> = {}
  const present = existsSync(path)
  if (present) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error: unknown) {
      return { kind: 'unreadable', path, reason: error instanceof Error ? error.message : String(error) }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { kind: 'unreadable', path, reason: 'not a JSON object' }
    }
    existing = parsed as Record<string, unknown>
    const counts = countsOf(existing)
    if (counts.allow + counts.deny + counts.ask > 0) return { kind: 'kept', path, counts }
  }
  const seeded = { ...existing, permissions: { allow: [], deny: [...ENSO_DEFAULT_DENY_RULES], ask: [] } }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(seeded, null, 2)}\n`)
  return { kind: 'seeded', path, was: present ? 'without rules' : 'absent' }
}

/**
 * The line both launch surfaces log for a preparation that did not refuse — the same words on
 * the web host and the terminal launcher, so a reader finds one in the logs by the other.
 *
 * @group Permission mode
 */
export function describePermissionRules(
  preparation: Exclude<PermissionRulesPreparation, { readonly kind: 'unreadable' }>,
): string {
  if (preparation.kind === 'seeded') {
    return (
      `permission rules: ${preparation.path} was ${preparation.was}, so it now holds Enso's ` +
      `${ENSO_DEFAULT_DENY_RULES.length} default deny rules; Claude Code's settings are not read (#446)`
    )
  }
  const { allow, deny, ask } = preparation.counts
  return `permission rules: ${preparation.path} — ${allow} allow, ${deny} deny, ${ask} ask`
}
