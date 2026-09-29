import { expect, test } from 'bun:test'
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
