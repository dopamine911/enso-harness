import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { builtFeaturePages, renderedFeaturePages } from '../scripts/docs/feature-pages.ts'
import { FEATURE_SPECS } from '../scripts/docs/features/index.ts'
import { type FeatureFacts, factsPath } from '../scripts/docs/features/spec.ts'
import { quotedLiterals, REPOSITORY_ROOT, sourceFiles } from './gate-support.ts'

/**
 * THE FEATURES PAGES DESCRIBE A UI THAT EXISTS (#437).
 *
 * `docs/features/` is written for someone using Enso, not changing it, so it names what they
 * see: a tab, a button, a panel's title. Those names are the page's whole contract with the
 * reader, and they are exactly what a UI change renames without a thought for the docs. A
 * renamed button should fail here, not leave a page describing a control nobody can find.
 *
 * THE CONVENTION THIS HOLDS. On a Features page, **bold is reserved for UI labels.** Every bold
 * span must be a string the web surface renders: a static string literal, or a JSX text node,
 * somewhere in `packages/web/src` (tests aside), or a string the capture read off the running
 * page (#482: a tool row's arguments, a request's heading, which no literal spells). The match
 * ignores case, because the UI upper-cases some labels in CSS (`REFUSED · NETWORK EGRESS` is
 * `network egress` in source).
 * Emphasis that is not a label is written in italics, and commands and paths in code spans.
 *
 * ⚠ The e2e selector gate (`e2e-selectors.test.ts`, #277) is the model and the scanner is shared
 * with it (`quotedLiterals`): a comment still naming an old label must not keep it alive.
 *
 * WHAT IT DOES NOT HOLD: that a label is on the screen the page says it is on. A label moved
 * from one panel to another still passes. The screenshots are the check for that — they are
 * regenerated from the app (`scripts/docs/feature-screenshots.ts`), and a capture that cannot
 * find a control fails.
 */

const FEATURES = join(REPOSITORY_ROOT, 'docs/features')
const WEB_SOURCE = join(REPOSITORY_ROOT, 'packages/web/src')

/** The six parts every page has, in order (#437). */
const SHAPE = [
  'What it shows',
  'How to open it',
  'What it looks like',
  'What to look for',
  "What it doesn't do",
  'Go deeper',
] as const

/** A page's screenshots: at least one, at most two, per the issue's shape. */
const MAX_IMAGES = 2

/**
 * Every Features page by file name, with its text. A built page (#482) is RENDERED here from its
 * spec and facts, never read from disk: the copy a past build left is stale, and a fresh checkout
 * has none, and either way the gate must check the page the site will serve.
 */
const built = new Set(builtFeaturePages().map((page) => basename(page)))
const texts = new Map<string, string>([
  ...readdirSync(FEATURES)
    .filter((name) => name.endsWith('.md') && name !== 'README.md' && !built.has(name))
    .map((name): [string, string] => [name, readFileSync(join(FEATURES, name), 'utf8')]),
  ...renderedFeaturePages().map(({ page, text }): [string, string] => [basename(page), text]),
])
const pages = [...texts.keys()].sort()
const textOf = (page: string): string => texts.get(page) ?? ''

/** Comments, removed so a label named only in prose does not count as rendered. */
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\w])\/\/[^\n]*/g

/**
 * The text of every JSX text node in `source`: what sits between a `>` and the next `<` with no
 * expression in it. Crude by design: a stray `=>` can contribute a nonsense "label", which only
 * makes the rendered set larger. What must never happen is a real label being MISSED, and a JSX
 * text node is exactly the run this reads.
 */
function jsxText(source: string): string[] {
  return [...source.replace(COMMENT, '').matchAll(/>([^<>{}]+)</g)]
    .map((match) => (match[1] ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => text !== '')
}

/** Every string the web surface can render, lower-cased. */
function renderedStrings(): Set<string> {
  const rendered = new Set<string>()
  for (const file of sourceFiles(WEB_SOURCE)) {
    const source = readFileSync(file, 'utf8')
    for (const text of [...quotedLiterals(source), ...jsxText(source)]) rendered.add(text.toLowerCase())
  }
  return rendered
}

/** The bold spans of a page, outside code: `**label**`. */
function boldSpans(markdown: string): string[] {
  const prose = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  return [...prose.matchAll(/\*\*([^*\n]+)\*\*/g)].map((match) => match[1] ?? '')
}

/**
 * What the capture read off the running page (#482): the text a ring's element showed, a measured
 * value, a control a step clicked. Rendered by construction, the capture having found it on
 * screen, and so as good a witness as a source literal; lower-cased.
 */
function capturedStrings(): string[] {
  return FEATURE_SPECS.flatMap((spec) => {
    const path = join(REPOSITORY_ROOT, factsPath(spec.id))
    if (!existsSync(path)) return []
    const facts = JSON.parse(readFileSync(path, 'utf8')) as FeatureFacts
    return facts.shots.flatMap((shot) => [
      ...shot.shown,
      ...Object.values(shot.measured),
      ...shot.steps.flatMap(boldSpans),
    ])
  }).map((captured) => captured.toLowerCase())
}

test('⚠ every bold label on a Features page is a string the web surface renders (#437)', () => {
  const rendered = renderedStrings()
  // A floor: a scan that found nothing would pass every page.
  expect(rendered.size).toBeGreaterThan(500)
  for (const captured of capturedStrings()) rendered.add(captured)
  const missing = pages.flatMap((page) =>
    boldSpans(textOf(page))
      .filter((label) => !rendered.has(label.toLowerCase()))
      .map((label) => `${page}: **${label}**`),
  )
  // Named, not counted: the output IS the list of labels to fix — in the page, or in the UI.
  expect(missing).toEqual([])
})

test('every Features page has the six parts, in order, and one or two screenshots (#437)', () => {
  expect(pages.length).toBeGreaterThanOrEqual(11)
  const offenders: string[] = []
  for (const page of pages) {
    const text = textOf(page)
    // Outside fenced blocks: a `## ` line in sample output is text, not the page's structure.
    const headings = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^## (.+)$/gm)].map((match) => match[1])
    if (JSON.stringify(headings) !== JSON.stringify(SHAPE))
      offenders.push(`${page}: sections are ${headings.join(' / ')}`)
    const looks = text.slice(text.indexOf('## What it looks like'), text.indexOf('## What to look for'))
    const images = [...looks.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].length
    // A page with nothing to screenshot (the terminal is pi's own interface) shows its output
    // as text instead; it still shows something.
    if (images === 0 && !looks.includes('```')) offenders.push(`${page}: shows nothing under "What it looks like"`)
    if (images > MAX_IMAGES) offenders.push(`${page}: ${images} screenshots, more than ${MAX_IMAGES}`)
  }
  expect(offenders).toEqual([])
})

test('the overview lists every page, and every screenshot is used by a page (#437)', () => {
  const overview = readFileSync(join(FEATURES, 'README.md'), 'utf8')
  expect(pages.filter((page) => !overview.includes(`](./${page})`))).toEqual([])
  const embedded = new Set(
    pages.flatMap((page) => [...textOf(page).matchAll(/!\[[^\]]*\]\(\.\/images\/([^)]+)\)/g)].map((match) => match[1])),
  )
  const images = existsSync(join(FEATURES, 'images')) ? readdirSync(join(FEATURES, 'images')) : []
  // An image no page shows is a capture that outlived its page, and it ships with the site.
  expect(images.filter((image) => !embedded.has(image))).toEqual([])
  expect([...embedded].filter((image) => !images.includes(image ?? ''))).toEqual([])
})

// The readers' own contract: both failures are silent — a label the scan cannot see fails a
// correct page, and a bold span it cannot see is a label nobody checks.
test('the label readers see JSX text, skip comments, and read bold outside code only (#437)', () => {
  expect(jsxText('<b className="x">Session analysis</b>')).toEqual(['Session analysis'])
  expect(jsxText('<p>\n  Context   Events\n</p>')).toEqual(['Context Events'])
  // An expression is not text the source states.
  expect(jsxText('<p>{label}</p>')).toEqual([])
  expect(jsxText('/* <p>Old label</p> */ <p>New label</p>')).toEqual(['New label'])
  expect(boldSpans('Use **Stats**, not `**not bold**`.\n```\n**nor this**\n```')).toEqual(['Stats'])
})
