import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectFlows } from '../scripts/docs/flow-tags.ts'

/**
 * FLOW PAGES ARE BUILT FROM TAGS, AND THE TAGS MUST AGREE (#482).
 *
 * ⚠ Enforcement, not a unit test. A `docs/flows/` page is build output (`scripts/docs/flow-pages.ts`),
 * gitignored, so nothing diffs it; what holds it is this. Every `@invariant` is pinned by a test's
 * `@pins` or says `@unpinned` and why; every `@pins` names an invariant that exists; every `@flow`
 * has a diagram a test recorded and nothing records a flow that does not exist. A renamed invariant,
 * a deleted test or a dropped snapshot fails here, before the site build would refuse the page.
 *
 * What it does not hold: that a pinning test proves what its invariant says. Review does.
 */
test('⚠ the flow tags agree: every invariant pinned or said unpinned, every pin and diagram names something (#482)', () => {
  expect(collectFlows().problems).toEqual([])
})

test('the scan finds the pilot flow, so the agreement above is not over nothing (#482)', () => {
  const model = collectFlows()
  expect(model.flows.map((flow) => flow.id)).toContain('prompt-run-settle')
  expect(model.invariants.filter((invariant) => invariant.flow === 'prompt-run-settle').length).toBeGreaterThan(3)
  expect(model.diagrams.filter((diagram) => diagram.flow === 'prompt-run-settle').length).toBeGreaterThan(0)
})

/** A repository-shaped tree with one of each disagreement planted, and one invariant excused. */
function plantedTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'enso-flow-tags-'))
  const files: Record<string, string> = {
    'packages/demo/src/start.ts': [
      '/**',
      ' * @flow demo A demo flow',
      ' * Its paragraph.',
      ' *',
      ' * @invariant demo/pinned A pinned rule.',
      ' * @invariant demo/unpinned A rule nobody pins.',
      ' * @invariant demo/excused A rule no test can reach.',
      ' * @unpinned the double cannot drive it',
      ' * @invariant demo/pinned The same id again.',
      ' */',
      'export function start(): void {}',
      '',
      '/**',
      ' * @invariant demo/loose A doc comment a blank line cut from its declaration.',
      ' */',
      '',
      'export function later(): void {}',
      '',
      '/**',
      ' * @flow unrecorded A flow no test records',
      ' * Its paragraph.',
      ' */',
      'export function unrecorded(): void {}',
    ].join('\n'),
    'packages/demo/src/__tests__/start.test.ts': [
      '// @pins demo/pinned demo/missing unrecorded/none',
      "test('the pinning test', () => {})",
    ].join('\n'),
    'packages/demo/src/__tests__/__snapshots__/start.test.ts.snap': [
      '// Bun Snapshot v1, https://bun.sh/docs/test/snapshots',
      '',
      'exports[`the pinning test: flow demo: the one side 1`] = `"sequenceDiagram\n  A->>B: x"`;',
      '',
      'exports[`the pinning test: flow ghost: nowhere 1`] = `"sequenceDiagram\n  A->>B: y"`;',
    ].join('\n'),
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

test('⚠ each disagreement is refused by name, and an @unpinned invariant is not (#482, PR #488 review)', () => {
  const { problems, invariants } = collectFlows(plantedTree())
  const tests = 'packages/demo/src/__tests__/start.test.ts'
  expect([...problems].toSorted()).toEqual(
    [
      '@invariant demo/pinned is declared twice',
      'packages/demo/src/start.ts: @invariant demo/unpinned is pinned by no test and says no @unpinned',
      // ⚠ The blank line: the tag belongs to nothing, rather than to whatever declaration follows the gap.
      'packages/demo/src/start.ts:13: a @flow or @invariant with no declaration to belong to',
      `${tests}: "the pinning test" pins demo/missing, which no @invariant declares`,
      `${tests}: "the pinning test" pins unrecorded/none, which no @invariant declares`,
      '@flow unrecorded: no test records its diagram',
      `packages/demo/src/__tests__/start.test.ts: "the pinning test" records flow ghost, which no @flow declares`,
    ].toSorted(),
  )
  expect(invariants.find((invariant) => invariant.id === 'demo/excused')?.unpinned).toBe('the double cannot drive it')
})
