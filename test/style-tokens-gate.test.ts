import { expect, test } from 'bun:test'
import { codeOffenders } from './gate-support.ts'

/**
 * The pages size and colour themselves with TOKENS, never literals: a colour is a theme
 * variable (`text-chart-2`, `bg-primary`), a size a Tailwind variable — the spacing scale, or a
 * named measure in `styles/global.css`'s `@theme` (`max-w-transcript`, `w-debug-pane`). A literal
 * cannot follow a theme or a token change; that is the whole of the rule.
 *
 * ⚠ Enforcement, not a unit test — the shape of `vendor-gate.test.ts`: a line scan over our own
 * page code, comment lines skipped, the allowlist the ratchet. It refuses, per line:
 *   - a Tailwind ARBITRARY value, `w-[30rem]`, `text-[var(--chart-2)]` — name it in `@theme`, or as
 *     an `@utility`, in `global.css`;
 *   - a HEX colour, or a colour function — `rgb(`, `hsl(`, `oklch(` and their kin;
 *   - a raw PALETTE colour, `text-red-500`, `bg-black` — the theme's roles are the palette;
 *   - PIXELS — a `…px` length, or a `*_PX` constant handed to a style.
 *
 * Out of its reach, by construction: `components/` (the vendored shadcn and ai-elements
 * primitives, fenced by `presentation-gate.test.ts`), `host/` and `server/` (they draw
 * nothing), the stylesheet itself (where the tokens are defined), and a number passed to a
 * `style` prop under a name that does not end in `_PX`.
 */

const PAGE_ROOTS = ['packages/web/src']
const NOT_PAGES = [
  'packages/web/src/components',
  'packages/web/src/host',
  'packages/web/src/server',
  'packages/web/src/__tests__',
]

/**
 * The ratchet. One exception, three files, one reason: the debug pages' log lists are
 * VIRTUALIZED, and the virtualizer places rows by arithmetic in pixels — its row height is a
 * pixel number by contract (`@tanstack/react-virtual`'s `estimateSize`), and the rows are drawn
 * at that height so the arithmetic holds. Leaves if the lists measure their rows instead.
 */
const PIXELS_ALLOWED = [
  'packages/web/src/debug/log-row.tsx',
  'packages/web/src/debug/log-tail-view.tsx',
  'packages/web/src/debug/thread-timeline-screen.tsx',
]

/** `w-[30rem]`, `sm:max-w-[16ch]`, `text-[var(--x)]`: a utility with a bracketed value. An arbitrary VARIANT (`[&_svg]:…`) is a selector, and passes. */
const ARBITRARY_VALUE = /(?:^|[\s"'`{:])-?[a-z][a-z0-9-]*-\[[^\]\s]+\]/
/** Six- or eight-digit hex, or three/four digits with a letter among them — so `#361`, an issue, is not a colour. */
const HEX_COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]{0,3}[a-fA-F])[0-9a-fA-F]{3,4})\b/
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/
const PALETTE_COLOUR =
  /\b(?:bg|text|border|fill|stroke|ring|outline|decoration|shadow|accent|caret|divide|from|via|to)-(?:(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}|black|white)\b/
/** A `…px` length — a literal, or one after an interpolation (`${n}px`) — or a `*_PX` constant. */
const PIXELS = /\b\d+(?:\.\d+)?px\b|\}px\b|\b[A-Z0-9_]*_PX\b/

const colourOrArbitrary = (line: string): boolean =>
  ARBITRARY_VALUE.test(line) || HEX_COLOUR.test(line) || COLOUR_FUNCTION.test(line) || PALETTE_COLOUR.test(line)

test('a page colours with theme tokens: no arbitrary value, hex, colour function or raw palette colour', () => {
  expect(codeOffenders({ roots: PAGE_ROOTS, exemptRoots: NOT_PAGES, lineMatches: colourOrArbitrary })).toEqual([])
})

test('a page sizes with Tailwind variables, never pixels — the virtualized debug lists excepted', () => {
  expect(
    codeOffenders({
      roots: PAGE_ROOTS,
      exemptRoots: NOT_PAGES,
      allowed: PIXELS_ALLOWED,
      lineMatches: (line: string) => PIXELS.test(line),
    }),
  ).toEqual([])
})

// The matchers are the gate; a matcher that sees nothing passes everything. Each is pinned on
// what it must catch and what it must let through.
test('the matchers catch the literals and pass the tokens', () => {
  for (const literal of [
    'className="w-[30rem] shrink-0"',
    "'text-[var(--chart-6)]'",
    'className="sm:max-w-[16ch]"',
    "background: '#1f1f28'",
    "color: 'rgb(40, 42, 54)'",
    'className="text-red-500"',
    'className="bg-black/50"',
  ])
    expect(colourOrArbitrary(literal)).toBe(true)
  for (const token of [
    'className="w-debug-pane shrink-0 text-chart-2"',
    'className="[&_svg]:size-4 max-w-transcript"',
    "entry.id + '#0'",
    "'PR #361 review'",
    "backgroundColor: 'color-mix(in oklab, currentColor 18%, transparent)'",
  ])
    expect(colourOrArbitrary(token)).toBe(false)
  // The template is assembled, so the fixture is not itself a template-looking string.
  const interpolatedPixels = `minWidth: \`$${'{'}n}px\``
  for (const pixels of ["boxShadow: '0 0 0 2px red'", 'style={{ height: ROW_HEIGHT_PX }}', interpolatedPixels])
    expect(PIXELS.test(pixels)).toBe(true)
  for (const variable of ['calc(var(--spacing) * 2.5)', 'className="h-5.5 px-4"'])
    expect(PIXELS.test(variable)).toBe(false)
})
