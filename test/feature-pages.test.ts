import { expect, test } from 'bun:test'
import { featureProblems, renderFeaturePage } from '../scripts/docs/feature-pages.ts'
import { FEATURE_SPECS } from '../scripts/docs/features/index.ts'
import { type FeatureFacts, type FeatureSpec, type ShotFacts, withShotFacts } from '../scripts/docs/features/spec.ts'

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
  landingTagline: 'a demo',
  shows: ['It shows.'],
  opens: [],
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

/** Two shots of the finished thread and one the session takes, the second reached by one more click. */
const MULTI: FeatureSpec = {
  ...SPEC,
  opens: ['{steps}.', 'Or type `/demo`.'],
  lookFor: [],
  shots: [
    { image: 'first', alt: 'First', go: async () => undefined, marks: [] },
    {
      image: 'second',
      alt: 'Second',
      go: async () => undefined,
      marks: [],
      measure: { cost: () => undefined as never },
    },
    { image: 'asked', alt: 'Asked', during: 'questionnaire', marks: [], measure: { cost: () => undefined as never } },
  ],
}
const shotFacts = (image: string, steps: string[]): ShotFacts => ({ image, steps, shown: [], measured: {} })

test("the first shot's steps open the page where {steps} places them; every other shot says how it was reached above its image", () => {
  const page = renderFeaturePage(MULTI, {
    feature: 'demo',
    shots: [
      shotFacts('first', ['open a thread from the rail', 'choose the **Stats** tab at the top of the thread']),
      shotFacts('second', ['open a thread from the rail', 'choose **commands**']),
      shotFacts('asked', []),
    ],
  })
  expect(page).toContain(
    '## How to open it\n\n- Open a thread from the rail, then choose the **Stats** tab at the top of the thread.\n- Or type `/demo`.\n',
  )
  // Said once: not again above the first image, where How to open it already said it.
  expect(page).toContain('## What it looks like\n\n![First](./images/first.png)')
  expect(page).toContain(
    'To see it: open a thread from the rail, then choose **commands**.\n\n![Second](./images/second.png)',
  )
  // A shot the session takes has no steps of its own to say.
  expect(page).toContain('\n![Asked](./images/asked.png)')
  expect(page).not.toContain('To see it: .')
})

test('⚠ two shots measuring one name, {steps} with nothing to place, and a session shot to retake are each refused by name', () => {
  const facts: FeatureFacts = {
    feature: 'demo',
    shots: [shotFacts('first', []), { ...shotFacts('second', []), measured: { cost: '$1' } }, shotFacts('asked', [])],
  }
  expect(featureProblems(MULTI, facts)).toEqual([
    'demo: "{cost}" is measured by both second and asked',
    'demo: How to open it places {steps}, but the first shot took no steps',
  ])
  // `--only` skips the session's own stops, so a stale session shot names the full run.
  expect(featureProblems(MULTI, { ...facts, shots: facts.shots.slice(0, 2) })).toContain(
    'demo: shot asked was not captured; recapture with `bun run docs:screenshots` (a shot taken during the session needs the full run)',
  )
})

test("recapturing one shot replaces its facts and keeps the others, in the spec's order, dropping shots the spec no longer has", () => {
  const old: FeatureFacts = {
    feature: 'demo',
    shots: [shotFacts('asked', ['then']), shotFacts('gone', []), shotFacts('first', ['old'])],
  }
  expect(withShotFacts(MULTI, old, shotFacts('first', ['new']))).toEqual({
    feature: 'demo',
    shots: [shotFacts('first', ['new']), shotFacts('asked', ['then'])],
  })
  expect(withShotFacts(MULTI, undefined, shotFacts('second', []))).toEqual({
    feature: 'demo',
    shots: [shotFacts('second', [])],
  })
})
