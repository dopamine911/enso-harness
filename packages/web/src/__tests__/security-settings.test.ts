import { expect, test } from 'bun:test'
import { looseningsOf } from '../security-settings.tsx'

/**
 * Settings › Security (#933) says plainly, before Save, every way a save protects less. The
 * direction differs per key — a smaller window counts less, larger signal counts act later — and
 * an absent key is its default, so a wrong sign or a missed default would wave a loosening through.
 */

test('a save that loosens is said, key by key, measured against the defaults when a key is absent', () => {
  expect(
    looseningsOf(
      { incidents: { halt: true }, judge: { backend: 'jev' } },
      { incidents: { windowCalls: 4, highAtSignals: 5, highAtKinds: 1, incidentAtSignals: 5 } },
    ),
  ).toEqual([
    'Halting goes off: an incident will no longer suspend tools — it is only an alert.',
    'Calls in the risk window: 8 → 4 calls. Fewer calls are counted together, so risk is reached less often.',
    'Signals for high risk: 3 → 5 signals. More is needed before it acts, so it acts less often.',
    'The command judge goes off: commands will no longer get a second opinion.',
  ])
})

test('tightening, or writing the default out, is not a loosening', () => {
  expect(
    looseningsOf({}, { incidents: { halt: true, windowCalls: 12, highAtSignals: 3, incidentAtSignals: 2 } }),
  ).toEqual([])
})

test('more kinds, or more signals for an incident, is a loosening too', () => {
  expect(
    looseningsOf({ incidents: { highAtKinds: 2 } }, { incidents: { highAtKinds: 3, incidentAtSignals: 6 } }),
  ).toEqual([
    'Kinds of signal for high risk: 2 → 3 kinds. More is needed before it acts, so it acts less often.',
    'Signals for an incident: 5 → 6 signals. More is needed before it acts, so it acts less often.',
  ])
})
