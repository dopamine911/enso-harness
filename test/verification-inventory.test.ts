import { expect, test } from 'bun:test'
import { complexityRatchets, firstHeaderSentence } from '../scripts/docs/verification-inventory.ts'

/**
 * THE INVENTORY'S READERS, ON THE SHAPES THE REPOSITORY DOES NOT HOLD TODAY (#174, #832).
 *
 * `docs/reference/verification-inventory.md` states what each gate enforces and which ratchets
 * hold the code. The live page only exercises the shapes the repository currently has; these pin
 * the rest, because a reader that misparses a new shape publishes a wrong claim about a gate, and
 * one that skips an entry it cannot read publishes an inventory with a hole in it.
 */

test("a gate's rule is the first sentence of its header that is not a ⚠ warning", () => {
  const source = [
    'import { test } from "bun:test"',
    '/**',
    ' * ⚠ Enforcement, not a unit test. Every route names its',
    ' * owner. Anything else is a finding.',
    ' */',
    '/** A second comment is never the header. */',
  ].join('\n')
  expect(firstHeaderSentence(source, 'probe.ts')).toBe('Every route names its owner.')
})

test('a stop inside a code span, or not followed by space, does not end the sentence', () => {
  expect(firstHeaderSentence('/** The `a.b` file is read at v1.2 only. Then more. */', 'probe.ts')).toBe(
    'The `a.b` file is read at v1.2 only.',
  )
  expect(firstHeaderSentence('/** Nothing is skipped! */', 'probe.ts')).toBe('Nothing is skipped!')
})

test('a header the splitter cannot read is refused by file, never guessed at', () => {
  expect(() => firstHeaderSentence('// a line comment only', 'probe.ts')).toThrow('probe.ts: no header comment')
  expect(() => firstHeaderSentence('/** The `open span. */', 'probe.ts')).toThrow(
    'probe.ts: header has an unpaired backtick',
  )
  expect(() => firstHeaderSentence('/** ⚠ Only a warning. */', 'probe.ts')).toThrow(
    'probe.ts: no non-warning sentence in header',
  )
  expect(() => firstHeaderSentence('/** No sentence ends here */', 'probe.ts')).toThrow(
    'probe.ts: no non-warning sentence in header',
  )
})

const SCRIPTS = { 'complexity:check': 'fallow health --max-cognitive 15 --quiet' }
const PIN = { files: ['scripts/a.ts'], functions: ['parse'], maxCognitive: 30, reason: 'One parser, one switch.' }

test('the complexity ceiling comes first, then every pin in declared order', () => {
  const config = { health: { thresholdOverrides: [PIN, { ...PIN, functions: ['emit'], maxCognitive: 20 }] } }
  expect(complexityRatchets(SCRIPTS, config)).toEqual([
    {
      kind: 'Complexity ceiling',
      value: 'cognitive max `15`',
      location: '[`package.json`](../../package.json) — `complexity:check`',
      reason: 'Global cognitive-complexity ceiling for code without a narrower pin.',
    },
    {
      kind: 'Complexity pin',
      value: 'cognitive max `30`',
      location: '[`.fallowrc.jsonc`](../../.fallowrc.jsonc) — `scripts/a.ts:parse`',
      reason: 'One parser, one switch.',
    },
    {
      kind: 'Complexity pin',
      value: 'cognitive max `20`',
      location: '[`.fallowrc.jsonc`](../../.fallowrc.jsonc) — `scripts/a.ts:emit`',
      reason: 'One parser, one switch.',
    },
  ])
  // No pins is the state the ratchet aims for: the ceiling alone, not a refusal.
  expect(complexityRatchets(SCRIPTS, { health: { thresholdOverrides: [] } })).toHaveLength(1)
})

test('a complexity gate without a ceiling, or a pin list that is not a list, is refused', () => {
  const config = { health: { thresholdOverrides: [PIN] } }
  expect(() => complexityRatchets({ 'complexity:check': 'fallow health' }, config)).toThrow(
    'package.json: `complexity:check` sets no --max-cognitive',
  )
  expect(() => complexityRatchets({}, config)).toThrow('sets no --max-cognitive')
  for (const unreadable of [null, {}, { health: null }, { health: {} }, { health: { thresholdOverrides: {} } }]) {
    expect(() => complexityRatchets(SCRIPTS, unreadable)).toThrow(
      '.fallowrc.jsonc: health.thresholdOverrides is not a list',
    )
  }
})

// ⚠ A pin covering two files or two functions cannot be published as one row without dropping
// half of it, so it is refused rather than shown as its first entry.
test('a pin that is not one file, one function, a number and a reason is refused, never skipped', () => {
  for (const pin of [
    { ...PIN, files: ['a.ts', 'b.ts'] },
    { ...PIN, functions: ['f', 'g'] },
    { ...PIN, files: 'scripts/a.ts' },
    { ...PIN, functions: 'parse' },
    { ...PIN, maxCognitive: '30' },
    { ...PIN, reason: 7 },
    { files: PIN.files, functions: PIN.functions, maxCognitive: PIN.maxCognitive },
    null,
    'scripts/a.ts:parse',
  ]) {
    expect(() => complexityRatchets(SCRIPTS, { health: { thresholdOverrides: [PIN, pin] } })).toThrow(
      '.fallowrc.jsonc: a complexity override is not one file + one function',
    )
  }
})
