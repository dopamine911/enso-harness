import { expect, test } from 'bun:test'
import { featureProblems } from '../scripts/docs/feature-pages.ts'
import { FEATURE_SPECS } from '../scripts/docs/features/index.ts'
import type { FeatureFacts, FeatureSpec } from '../scripts/docs/features/spec.ts'

/**
 * A FEATURES PAGE IS BUILT ONLY FROM FACTS ITS SPEC STILL MATCHES (#482).
 *
 * ⚠ Enforcement, not a unit test. `docs/features/<id>.md` for a spec'd feature is build output
 * from the spec (`scripts/docs/features/<id>.ts`) and the facts its last capture wrote
 * (`docs/features/facts/<id>.json`). Change a spec's marks, shots or quoted values without
 * recapturing and the page would say what nobody captured; this refuses that, naming the command.
 *
 * What it does not hold: that the capture was run against the current UI. The capture itself is
 * the check for that: it fails when a mark's element is gone or a measured value is empty.
 */
test('⚠ every spec agrees with its captured facts (#482)', () => {
  expect(FEATURE_SPECS.flatMap((spec) => featureProblems(spec))).toEqual([])
})

const SPEC: FeatureSpec = {
  id: 'demo',
  title: 'Demo',
  shows: ['It shows.'],
  shots: [
    {
      image: 'demo',
      alt: 'Demo',
      go: async () => undefined,
      marks: [
        { target: { text: 'one' }, says: '`{shown}`' },
        { target: { role: 'heading', name: 'Two' }, says: '**{shown}** costs {cost}' },
      ],
    },
  ],
  lookFor: ['It cost {cost}, and {never} was measured by nobody.'],
  limits: [],
  see: [],
}

const CAPTURED = { image: 'demo', steps: ['open it'], shown: ['one'], measured: { cost: '$1', empty: '' } }
const FACTS: FeatureFacts = { feature: 'demo', shots: [CAPTURED] }

test('⚠ a stale capture is refused by what disagrees, and each refusal names the recapture (#482)', () => {
  const recapture = 'recapture with `bun run docs:screenshots --only demo`'
  expect(featureProblems(SPEC, undefined)).toEqual([`demo: no docs/features/facts/demo.json; ${recapture}`])
  expect(featureProblems(SPEC, FACTS).sort()).toEqual(
    [
      `demo: demo has 2 marks, the capture rang 1; ${recapture}`,
      'demo: "{never}" is quoted but the capture measured no value for it',
    ].sort(),
  )
  expect(featureProblems(SPEC, { ...FACTS, shots: [{ ...CAPTURED, image: 'other' }] })).toContain(
    `demo: shot demo was not captured; ${recapture}`,
  )
  // A value the capture read as empty is as unmeasured as one it never read.
  expect(
    featureProblems({ ...SPEC, lookFor: ['{empty}'] }, { ...FACTS, shots: [{ ...CAPTURED, shown: ['one', 'Two'] }] }),
  ).toEqual(['demo: "{empty}" is quoted but the capture measured no value for it'])
})
