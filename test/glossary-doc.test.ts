import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasWordSequence, wordsOf } from './gate-support.ts'

/**
 * The glossary keeps its own three rules (#161, PR #164 review; #245).
 *
 * ⚠ Enforcement, not a unit test — the shape of `vendor-gate.test.ts`, pointed at one
 * document instead of the source tree. `docs/glossary.md` claims that vendor names appear
 * only in its vendor map (and, quoted for renaming, in its Retired table), and that every
 * definition is ours. A document that claims a rule nobody checks is a wish; this is the
 * check. It reads WORDS (`gate-support.ts`, shared with the vendor gate), so a `Pi`-prefixed
 * identifier in a domain section counts as naming the vendor and `api` does not.
 *
 * The third rule is a census (#245): where an entry states how many of a thing there are, the
 * count is read off the GENERATED table the entry links, not off a reader's memory. The **gate**
 * and **seam** entries each said five when the generated tables held eleven and ten; a count in
 * prose beside a generated table is exactly the claim nobody checks. So the entry must name the
 * table and agree with it, and an entry that drops the census shape fails here rather than
 * quietly becoming unverifiable again.
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

/**
 * A count the glossary states in prose, and the generated table it is read off. `regionStart` is
 * the line opening that table's region: a heading, or the marker of the block a generator fills.
 * It is matched WHOLE, so a heading reworded on the far page fails here rather than counting the
 * wrong table — and the failure below names the constant to re-point (PR #307 review).
 *
 * ⚠ **leak** is deliberately absent. L1–L6 is a closed historical enumeration with no generated
 * table behind it — the *Leak numbers* section of `docs/seams/README.md` is hand-written, and a
 * seventh leak is not something a generator would learn about. Counting it here would pin prose
 * against prose, which says nothing. `gate` and `seam` are censuses of tables a generator fills
 * from the tree, which is exactly what drifts.
 */
interface Census {
  /** The project-vocabulary entry that states the count. */
  readonly word: string
  /** The page holding the generated table, repository-relative. */
  readonly page: string
  readonly regionStart: string
}

const CENSUSES: readonly Census[] = [
  { word: 'gate', page: 'docs/reference/verification-inventory.md', regionStart: '## Enforcement gates' },
  { word: 'seam', page: 'docs/architecture.md', regionStart: '<!-- generated-block: scripts/docs/seams-table.ts -->' },
]

/** Counts as the glossary writes them: prose, not numerals. A word outside this list is refused. */
const NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
]
const STATED_COUNT = /\b([a-z]+) today\b/

/**
 * A `- **word** — …` entry, bullet line plus its indented continuations, as one line: the glossary
 * wraps at 110 columns, so a claim is read after unwrapping or it is read by luck.
 */
function entryOf(word: string): { text: string; line: number } | undefined {
  const start = lines.findIndex((line) => line.startsWith(`- **${word}** —`))
  if (start < 0) return undefined
  let end = start + 1
  while (lines[end]?.startsWith('  ') === true) end += 1
  return {
    text: lines
      .slice(start, end)
      .map((line) => line.trim())
      .join(' '),
    line: start + 1,
  }
}

/**
 * The data rows of the table opening the region — its contiguous table lines less header and
 * separator — or the offender line when the region holds no table this can count.
 */
function tableRowCount(page: string, regionStart: string): number | string {
  const source = readFileSync(join(import.meta.dir, '..', page), 'utf8').split('\n')
  const start = source.indexOf(regionStart)
  // Names the constant, not just the miss: a reworded heading on the far page is the usual
  // cause, and re-pointing `CENSUSES[…].regionStart` is the usual fix (PR #307 review).
  if (start < 0) return `${page}: no line reads "${regionStart}" — re-point CENSUSES[…].regionStart`
  const table: string[] = []
  for (const line of source.slice(start + 1)) {
    if (line.startsWith('## ') || line === '<!-- /generated-block -->') break
    if (line.startsWith('|')) table.push(line)
    else if (table.length > 0) break
  }
  if (table.length < 3 || (table[1] ?? '').startsWith('|---') === false) {
    return `${page}: "${regionStart}" opens no header-and-rows table`
  }
  return table.length - 2
}

test('⚠ every census the glossary states equals the generated table it names (glossary rule 3)', () => {
  const offenders: string[] = []
  for (const census of CENSUSES) {
    const entry = entryOf(census.word)
    if (entry === undefined) {
      offenders.push(`docs/glossary.md: no **${census.word}** entry to read a census from`)
      continue
    }
    const at = `docs/glossary.md:${entry.line}: **${census.word}**`
    const link = `./${census.page.slice('docs/'.length)}`
    if (!entry.text.includes(`](${link}#`)) offenders.push(`${at} states a count without linking ${link}`)
    const counted = tableRowCount(census.page, census.regionStart)
    if (typeof counted === 'string') {
      offenders.push(counted)
      continue
    }
    const stated = STATED_COUNT.exec(entry.text)?.[1]
    if (stated === undefined) {
      offenders.push(`${at} states no "<number> today" count; ${census.page} has ${counted} rows`)
      continue
    }
    const statedCount = NUMBER_WORDS.indexOf(stated)
    if (statedCount === -1) offenders.push(`${at} says "${stated} today", which is not a count`)
    else if (statedCount !== counted)
      offenders.push(`${at} says ${stated}; ${census.page} → "${census.regionStart}" has ${counted} rows`)
  }
  expect(offenders).toEqual([])
})
