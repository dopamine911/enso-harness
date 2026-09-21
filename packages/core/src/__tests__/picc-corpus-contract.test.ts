import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PERSISTENCE_WRITE_BASENAMES, PERSISTENCE_WRITE_DIRECTORIES } from '../guard.ts'

/**
 * The picc CORPUS CONTRACT TEST (#222), the shape of `cc-safety-net-contract.test.ts` and
 * `agent-loop-contract.test.ts`: read the installed vendor, assert the shape we copied.
 *
 * `guard.ts` vendors `DANGEROUS_FILES` / `DANGEROUS_DIRECTORIES` from
 * `@ladbabynpm/picc-permission-modes` as a COPY rather than a deep import — the lists are a
 * corpus, not logic, and an unversioned deep import into a v0.1.x package is the risk #7
 * names — and stated its safeguard as "a divergence is visible in a diff". That was a manual
 * procedure with no sensor: two of three vendored corpora had a contract test and this one
 * did not. On a picc bump the copy would silently stop matching upstream's, and the layer
 * `guard.ts` calls "the only always-on denial" — the one covering print runs, which load no
 * picc at all (#20) — would quietly diverge from the mode extension it backstops.
 *
 * ⚠ READ AS SOURCE TEXT, NOT IMPORTED. picc ships raw `.ts` whose modules pull in pi's peer
 * packages; importing the corpus would put a vendor module (and its peers) in the graph of a
 * core test to read two array literals. Text is also what makes a RENAME red rather than
 * silently empty: a missing declaration throws here, naming the symbol.
 *
 * ⚠ ORDER IS ASSERTED, because `guard.ts` keeps upstream's order for exactly that reason. A
 * reordered upstream is not a behaviour change for us — both lists are membership tests — so
 * a red line here means "re-fit the copy and its comment", not "a hole opened".
 *
 * NOT asserted: our own additions (`ZEN_PERSISTENCE_WRITE_DIRECTORIES`) are deliberately a
 * separate constant so the vendored block stays byte-comparable, and picc has no reason to
 * know them.
 */

const require = createRequire(import.meta.url)
const piccPackage = require.resolve('@ladbabynpm/picc-permission-modes/package.json')
const { version } = JSON.parse(readFileSync(piccPackage, 'utf8')) as { version: string }
const permissionContextSource = readFileSync(join(dirname(piccPackage), 'permissionContext.ts'), 'utf8')

/**
 * The string literals of an `export const <symbol> = [ … ]`, in declaration order.
 *
 * ⚠ The array ends at its MATCHING bracket, not the first `]` after it (PR #314 review). A
 * `]` inside an entry — upstream adding a bracketed note or a regex-shaped name — would
 * otherwise truncate the slice and compare a PARTIAL list, which is the one outcome this
 * file's header promises cannot happen: a divergence has to be red, never quietly narrower.
 * Quoted entries are skipped while scanning so a bracket inside one is content.
 */
function declaredCorpus(symbol: string, source: string = permissionContextSource): string[] {
  const opening = `export const ${symbol} = [`
  const start = source.indexOf(opening)
  if (start < 0) {
    throw new Error(`@ladbabynpm/picc-permission-modes@${version} declares no ${symbol} in permissionContext.ts`)
  }
  let depth = 1
  let quote = ''
  let end = -1
  for (let index = start + opening.length; index < source.length; index += 1) {
    const character = source[index] ?? ''
    if (quote !== '') {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === "'" || character === '"' || character === '`') quote = character
    else if (character === '[') depth += 1
    else if (character === ']' && --depth === 0) {
      end = index
      break
    }
  }
  if (end < 0) throw new Error(`${symbol} is not a closed array literal`)
  const body = source.slice(start, end)
  return [...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? '')
}

test(`⚠ CONTRACT: the persistence-write basenames still match picc@${version}'s DANGEROUS_FILES`, () => {
  expect(PERSISTENCE_WRITE_BASENAMES).toEqual(declaredCorpus('DANGEROUS_FILES'))
})

test(`⚠ CONTRACT: the persistence-write directories still match picc@${version}'s DANGEROUS_DIRECTORIES`, () => {
  expect(PERSISTENCE_WRITE_DIRECTORIES).toEqual(declaredCorpus('DANGEROUS_DIRECTORIES'))
})

// ⚠ The READER itself, over a fixture (PR #314 review). The two contracts above read the
// installed corpus, which carries no bracket inside an entry — so the scanner that replaced
// `indexOf(']')` is exercised by nothing there, and an off-by-one in its escape handling
// would surface as a quietly SHORTER list: the one failure this file promises cannot happen.
test('the corpus reader ends at the array’s own bracket, whatever the entries contain', () => {
  const source = "export const DANGEROUS_FILES = ['a]b', 'plain', 'trailing']\nexport const OTHER = ['not mine']"
  expect(declaredCorpus('DANGEROUS_FILES', source)).toEqual(['a]b', 'plain', 'trailing'])
  // A nested array is still inside the same literal, so the scan does not stop early either.
  expect(declaredCorpus('X', "export const X = [['a'], 'b']")).toEqual(['a', 'b'])
  // A symbol that is not declared is named, never read as empty.
  expect(() => declaredCorpus('MISSING', source)).toThrow(/declares no MISSING/)
  expect(() => declaredCorpus('X', 'export const X = [')).toThrow(/not a closed array literal/)
})
