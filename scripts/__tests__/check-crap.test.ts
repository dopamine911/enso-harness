import { expect, test } from 'bun:test'
import { type CrapFinding, type CrapPin, crapFailures, crapFindingsOf, crapPinsOf } from '../check-crap.ts'

/**
 * Gate step `crap` (#844): what fails it. A function at CRAP ≥ 30 needs a pin at exactly its
 * score; a pin that is looser than its function, or matches nothing, fails too.
 */

const finding = (path: string, name: string, crap: number, measured = true): CrapFinding => ({
  path,
  name,
  line: 7,
  crap,
  measured,
})
const pin = (path: string, name: string, crap: number): CrapPin => ({ path, function: name, crap, reason: 'why' })

test('a pinned function at exactly its pin passes', () => {
  expect(crapFailures([finding('a.ts', 'run', 238.1)], [pin('a.ts', 'run', 238.1)])).toEqual([])
})

test('a function at or over 30 with no pin fails, named with its line and score', () => {
  const failures = crapFailures([finding('a.ts', 'grew', 30), finding('b.ts', 'cold', 42, false)], [])
  expect(failures).toEqual([
    'a.ts:7 grew: CRAP 30, with no pin; test it under 30, or pin it with its reason',
    "b.ts:7 cold: CRAP 42 (fallow's estimate: no test loads the file), with no pin; test it under 30, or pin it with its reason",
  ])
})

test('a pinned function above its pin fails; one below it fails asking for the lower pin', () => {
  const failures = crapFailures(
    [finding('a.ts', 'worse', 56.1), finding('a.ts', 'better', 52)],
    [pin('a.ts', 'worse', 56), pin('a.ts', 'better', 53.1)],
  )
  expect(failures).toEqual([
    'a.ts:7 worse: CRAP 56.1, over its pin of 56',
    'a.ts:7 better: CRAP 52, under its pin of 53.1; lower the pin to 52',
  ])
})

test('a pin with no function at or over 30 fails: fell under, renamed, moved or deleted', () => {
  const failures = crapFailures([finding('b.ts', 'run', 40)], [pin('a.ts', 'run', 40), pin('b.ts', 'run', 40)])
  expect(failures).toEqual([
    'a.ts run: pinned at 40, but no function of that name there scores 30 or more; delete the pin',
  ])
})

test("fallow's findings: only CRAP at or over 30 counts, and a changed shape throws instead of reading clean", () => {
  const report = {
    findings: [
      { path: 'a.ts', name: 'hot', line: 3, crap: 31.5, coverage_source: 'istanbul' },
      { path: 'a.ts', name: 'guessed', line: 9, crap: 90, coverage_source: 'estimated' },
      { path: 'a.ts', name: 'cool', line: 12, crap: 29.9, coverage_source: 'istanbul' },
      // A cognitive or cyclomatic finding alone carries no CRAP score.
      { path: 'a.ts', name: 'branchy', line: 20, cognitive: 40 },
    ],
  }
  expect(crapFindingsOf(report)).toEqual([
    { path: 'a.ts', name: 'hot', line: 3, crap: 31.5, measured: true },
    { path: 'a.ts', name: 'guessed', line: 9, crap: 90, measured: false },
  ])
  expect(() => crapFindingsOf({})).toThrow('no `findings` list')
  expect(() => crapFindingsOf({ findings: [{ name: 'x', line: 1, crap: 50 }] })).toThrow('without path')
  expect(() => crapFindingsOf({ findings: [{ path: 'a.ts', name: 'x', line: 1, crap: '50' }] })).toThrow('wrong shape')
})

test('crap-pins.json is read checked: each pin whole, with a reason, and pinned once', () => {
  const whole = { path: 'a.ts', function: 'run', crap: 40, reason: 'a live browser' }
  expect(crapPinsOf([whole])).toEqual([whole])
  expect(() => crapPinsOf({})).toThrow('not a list')
  expect(() => crapPinsOf([{ path: 'a.ts', function: 'run', crap: 40 }])).toThrow('needs a path')
  expect(() => crapPinsOf([{ ...whole, crap: '40' }])).toThrow('needs a path')
  expect(() => crapPinsOf([{ ...whole, reason: ' ' }])).toThrow('gives no reason')
  expect(() => crapPinsOf([whole, { ...whole, crap: 41 }])).toThrow('pinned twice')
})
