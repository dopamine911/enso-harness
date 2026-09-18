import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * THE E2E SELECTOR CONTRACT (#277). `packages/web/e2e/chat.e2e.ts` drives the real browser by
 * the composer's accessible names, and `packages/web/e2e/README.md` states the discipline:
 * "Renaming any of those in the UI is a spec change too — the constants at the top of
 * `chat.e2e.ts` are the single place to update." Nothing enforced it, and it broke:
 * `STOP_BUTTON_NAME` kept reading `stop the current response` after #116 renamed the control to
 * `stop the run`, so the `@model` test's proof that a run started queried a name no element
 * carries and `bun run e2e:model` could not pass. Playwright does not run in CI, so the spec
 * itself is never the sensor.
 *
 * ⚠ Enforcement, not a unit test — the shape of `logging-gate.test.ts`. It is one half of a
 * chain: this gate pins the spec's constants to STRING LITERALS in `chat-screen.tsx`, and
 * `packages/web/src/__tests__/thread-pane.test.tsx` mounts the pane and pins those same names
 * to the RENDERED MARKUP. Together: a name in the spec resolves to an element a user can
 * reach. The halves are split because `packages/web/src` is the browser zone and fallow refuses
 * a browser → test import edge; this tier may read both files.
 *
 * Quoted literals only, never the whole file: a comment that still mentions an old name (this
 * page's own header does) must not keep a retired constant green.
 */

const SPEC_PATH = 'packages/web/e2e/chat.e2e.ts'
const COMPOSER_PATH = 'packages/web/src/chat-screen.tsx'
const specSource = readFileSync(join(REPOSITORY_ROOT, SPEC_PATH), 'utf8')
const composerSource = readFileSync(join(REPOSITORY_ROOT, COMPOSER_PATH), 'utf8')

/** The spec's selector constants, by name — each declared as a single-quoted string. */
const SELECTOR_CONSTANTS = ['COMPOSER_PLACEHOLDER', 'SEND_BUTTON_NAME', 'STOP_BUTTON_NAME'] as const

/** Every single- or double-quoted one-line string literal in a source file. */
function quotedLiterals(source: string): string[] {
  return [...source.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((match) => match[1] ?? match[2] ?? '')
}

test('⚠ every e2e selector constant is a name the composer actually renders (#277)', () => {
  const rendered = quotedLiterals(composerSource)
  const declared = SELECTOR_CONSTANTS.map((name) => {
    const found = new RegExp(`const ${name} = '([^'\\n]+)'`).exec(specSource)?.[1]
    // A renamed or reshaped constant is drift too: the spec's header names these three.
    if (found === undefined) throw new Error(`${name} is not a single-quoted string constant in ${SPEC_PATH}`)
    return { name, selector: found }
  })
  const missing = declared.filter((constant) => !rendered.includes(constant.selector))
  expect(missing).toEqual([])
})

/**
 * ⚠ The settle gate, pinned to the one composer reading that flips. `waitForRunToSettle` gated
 * three model-free tests on the SEND button being visible — and send is rendered at every
 * moment (only `disabled`), so "wait for the run to settle" was satisfied on first paint and a
 * run left open would have passed it. The stop control is rendered only while a run is in
 * flight, which `thread-pane.test.tsx` asserts against the real markup; a settle gate that
 * stops naming it is vacuous again.
 */
test('⚠ the e2e settle gate waits for the stop control to be gone, not for send to exist (#277)', () => {
  const declaration = specSource.indexOf('async function waitForRunToSettle')
  if (declaration < 0) throw new Error(`waitForRunToSettle is not declared in ${SPEC_PATH}`)
  // To the closing brace in the first column: the body may hold braces of its own.
  const gate = specSource.slice(declaration, specSource.indexOf('\n}', declaration))
  expect(gate).toContain('STOP_BUTTON_NAME')
  expect(gate).toContain('toHaveCount(0)')
})
