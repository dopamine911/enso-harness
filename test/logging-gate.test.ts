import { expect, test } from 'bun:test'
import { codeOffenders } from './gate-support.ts'

/**
 * Every record goes through the one logger (#132), and the substrate stays behind it.
 *
 * ⚠ Enforcement, not a unit test — the same shape as `vendor-gate.test.ts`. Two lines, both
 * ratchets:
 *
 *   1. No production `console.*` in a migrated root. A `console.error` is a record with no
 *      level, no thread, no file, and no test that can hear it — exactly what the server's
 *      `onProblem` seams were until this gate. Tests are outside it; the browser (#132
 *      slice 3) and the vendored ai-elements components are inside it, and clean.
 *   2. `@logtape/*` is named only where the schema lives (`core/src/log.ts`) and where a
 *      process configures its sink (`core/src/log-process.ts`, `web/src/browser-logging.ts`).
 *      Everything else goes through `zenLogger`, so the record shape is ours to hold and the
 *      substrate is ours to swap (one maintainer — the #132 assessment's named risk).
 *
 * ⚠ It rides `codeOffenders` (#254), and that is the point of the rewrite: this gate kept its
 * own walker and `continue`d an allowlisted file, so a row that no longer matched — or named
 * a file that had been renamed or deleted — passed in silence. The shared walker reports
 * `"(allowlisted, matches nothing)"` for both, which is the failure class #162 workstream 4
 * designed it to close; this gate predated that fold and was left behind.
 *
 * ⚠ The substrate is matched in ANY string, not only a `from` clause (#254, the shape
 * `vendor-gate.test.ts` already used): `await import('@logtape/logtape')` — a lazily loaded
 * browser configurator is the realistic version — `require('@logtape/logtape')` and the
 * side-effect `import '@logtape/logtape'` are the same dependency by another spelling, and a
 * `from`-anchored needle saw none of them.
 *
 * `MIGRATED_ROOTS` covers every layer now: the browser landed with slice 3, and `scripts` and
 * `packages/web/e2e` joined with #254 — the rule said "only the schema and the configurators"
 * while two first-party trees were outside the scan entirely. Both were already clean (0
 * console calls, 0 substrate names), so neither root brought an allowlist row with it.
 * Removing a root is a design conversation.
 *
 * What it still cannot catch, said up front: it is a line scan. A specifier assembled at
 * runtime (`"@log" + "tape/logtape"`) is out of reach by construction, and the record SHAPE
 * is held by `@zen/core`'s schema rather than by this gate.
 */

const MIGRATED_ROOTS = [
  'packages/core/src',
  'packages/harness',
  'packages/web/e2e',
  'packages/web/src',
  'scripts',
] as const
/** The console is a sink LogTape owns; nothing here writes to it by hand. */
const CONSOLE_CALL = /\bconsole\.(?:log|error|warn|info|debug|trace)\s*\(/
/** Where the substrate may be named — in any string that names it, not only a `from` clause. */
const LOGTAPE_IMPORT = /["']@logtape\//
/**
 * Each row with the condition that retires it. The recorder at
 * `packages/core/src/__tests__/log-recorder.ts` is NOT here: `__tests__` is outside the scan,
 * and it is a declared, reasoned exception (`no-duplicate-shapes.test.ts`'s barrel note).
 */
const LOGTAPE_ALLOWED = [
  // The record schema and `zenLogger` itself — the one place the substrate's types are ours
  // to re-export. Leaves only if the record shape stops being held in @zen/core.
  'packages/core/src/log.ts',
  // The node-side sink configurator (`@logtape/file`, `/pretty`, `/redaction`). Leaves when
  // a process configures its sink through a seam of ours instead of LogTape's own API.
  'packages/core/src/log-process.ts',
  // The browser's configurator, same condition on the browser side.
  'packages/web/src/browser-logging.ts',
] as const

function offendersMatching(pattern: RegExp, allowed: readonly string[]): string[] {
  return codeOffenders({ roots: MIGRATED_ROOTS, allowed, lineMatches: (line: string) => pattern.test(line) })
}

test('⚠ no production console.* in a migrated root — every record goes through zenLogger (#132)', () => {
  expect(offendersMatching(CONSOLE_CALL, [])).toEqual([])
})

test('⚠ @logtape/* is named only by the schema and the configurators (#132, #254)', () => {
  expect(offendersMatching(LOGTAPE_IMPORT, LOGTAPE_ALLOWED)).toEqual([])
})
