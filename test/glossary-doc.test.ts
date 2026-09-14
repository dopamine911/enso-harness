import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasWordSequence, wordsOf } from './gate-support.ts'

/**
 * The glossary keeps its own two rules (#161, PR #164 review).
 *
 * ⚠ Enforcement, not a unit test — the shape of `vendor-gate.test.ts`, pointed at one
 * document instead of the source tree. `docs/glossary.md` claims that vendor names appear
 * only in its vendor map (and, quoted for renaming, in its Retired table), and that every
 * definition is ours. A document that claims a rule nobody checks is a wish; this is the
 * check. It reads WORDS (`gate-support.ts`, shared with the vendor gate), so a `Pi`-prefixed
 * identifier in a domain section counts as naming the vendor and `api` does not.
 *
 * Two more things a hand edit breaks silently and a renderer hides: a table row with the
 * wrong number of cells (GitHub renders it, misaligned, without a word), and an in-page
 * link to a heading that moved. Both are asserted here so the document stays reviewable.
 *
 * The RETIRED-WORDS gate over the source tree (the Retired table applied to code) is
 * `glossary-gate.test.ts` (#165), not this file.
 */

const GLOSSARY = join(import.meta.dir, '..', 'docs', 'glossary.md')
/** The heading from which vendor names may appear: the Retired table, then the vendor map. */
const VENDOR_SECTION_HEADING = '## Retired'

/** One word is the whole name. */
const VENDOR_WORDS = ['pi', 'picc', 'tanstack', 'agui', 'dsh', 'deepseek', 'logtape', 'earendil', 'vercel'] as const
/** …and the ones spelled in several words, however they are joined. */
const VENDOR_WORD_SEQUENCES = [
  ['ag', 'ui'],
  ['ai', 'elements'],
  ['cc', 'safety', 'net'],
  ['pi', 'multi', 'account'],
] as const

function namesVendor(line: string): boolean {
  const words = wordsOf(line)
  return (
    VENDOR_WORDS.some((vendor) => words.includes(vendor)) ||
    VENDOR_WORD_SEQUENCES.some((sequence) => hasWordSequence(words, sequence))
  )
}

const lines: readonly string[] = readFileSync(GLOSSARY, 'utf8').split('\n')
const vendorSectionStart = lines.indexOf(VENDOR_SECTION_HEADING)

test('the glossary has the section where vendor names begin', () => {
  expect(vendorSectionStart).toBeGreaterThan(0)
})

test('⚠ no domain section names a vendor — definitions are ours (glossary rule 2)', () => {
  const offenders: string[] = []
  lines.slice(0, vendorSectionStart).forEach((line, index) => {
    if (namesVendor(line)) offenders.push(`docs/glossary.md:${index + 1}: ${line.trim()}`)
  })
  expect(offenders).toEqual([])
})

test('every table row has the same number of cells as its header', () => {
  const offenders: string[] = []
  let headerCells: number | undefined
  lines.forEach((line, index) => {
    if (!line.startsWith('|')) {
      headerCells = undefined
      return
    }
    const cells = line.split('|').length
    if (headerCells === undefined) headerCells = cells
    else if (cells !== headerCells)
      offenders.push(`docs/glossary.md:${index + 1}: ${cells - 2} cells, header has ${headerCells - 2}`)
  })
  expect(offenders).toEqual([])
})

test('every in-page link resolves to a heading', () => {
  const headings = new Set(
    lines
      .filter((line) => line.startsWith('## '))
      .map((line) =>
        line
          .slice(3)
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, '')
          .replace(/ /g, '-'),
      ),
  )
  const offenders: string[] = []
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\]\(#([^)]+)\)/g)) {
      if (!headings.has(match[1] ?? '')) offenders.push(`docs/glossary.md:${index + 1}: #${match[1]}`)
    }
  })
  expect(offenders).toEqual([])
})
