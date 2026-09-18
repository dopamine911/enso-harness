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

/** The string literals of an `export const <symbol> = [ … ]`, in declaration order. */
function declaredCorpus(symbol: string): string[] {
  const start = permissionContextSource.indexOf(`export const ${symbol} = [`)
  if (start < 0) {
    throw new Error(`@ladbabynpm/picc-permission-modes@${version} declares no ${symbol} in permissionContext.ts`)
  }
  const end = permissionContextSource.indexOf(']', start)
  if (end < 0) throw new Error(`${symbol} is not a closed array literal`)
  const body = permissionContextSource.slice(start, end)
  return [...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? '')
}

test(`⚠ CONTRACT: the persistence-write basenames still match picc@${version}'s DANGEROUS_FILES`, () => {
  expect(PERSISTENCE_WRITE_BASENAMES).toEqual(declaredCorpus('DANGEROUS_FILES'))
})

test(`⚠ CONTRACT: the persistence-write directories still match picc@${version}'s DANGEROUS_DIRECTORIES`, () => {
  expect(PERSISTENCE_WRITE_DIRECTORIES).toEqual(declaredCorpus('DANGEROUS_DIRECTORIES'))
})
