import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createFontFileRoute, FONT_ROUTE_PREFIX } from '../font-files.ts'

/**
 * #407 item 6: the page's fonts are served unbundled from the installed `@fontsource` packages.
 * The surface is closed — a dependency's stylesheets and font files, nothing else — and these pin
 * both halves: what it serves, and everything next to it that it must not.
 */

const webPackageDir = join(import.meta.dir, '..', '..', '..')
const route = createFontFileRoute(webPackageDir, ['@fontsource-variable/inter', 'react', '@enso/core'])
const get = (path: string): Promise<Response> => route(new Request(`http://localhost${FONT_ROUTE_PREFIX}${path}`))

test("serves a dependency's own stylesheet, and the font file it names, unbundled", async () => {
  const stylesheet = await get('@fontsource-variable/inter/index.css')
  expect(stylesheet.status).toBe(200)
  expect(stylesheet.headers.get('content-type')).toContain('text/css')
  const css = await stylesheet.text()
  // The package names its files relatively, which resolves back under this route.
  const named = /url\(\.\/(files\/[a-z0-9-]+\.woff2)\)/.exec(css)?.[1]
  expect(named).toBeDefined()
  const font = await get(`@fontsource-variable/inter/${named}`)
  expect(font.status).toBe(200)
  expect(font.headers.get('content-type')).toContain('font/woff2')
  expect(font.headers.get('cache-control')).toBe('public, max-age=86400')
})

test('⚠ nothing else: another package, a non-font dependency, another file of the package, a way out of it', async () => {
  const refused = [
    // A real @fontsource package, installed, but not one this route was given.
    '@fontsource-variable/geist/index.css',
    // A dependency that is not a font package.
    'react/package.json',
    '@enso/core/package.json',
    // The font package's other files.
    '@fontsource-variable/inter/package.json',
    '@fontsource-variable/inter/README.md',
    '@fontsource-variable/inter/scss/mixins.scss',
    // Out of the package, spelled and encoded.
    '@fontsource-variable/inter/../../react/package.json',
    '@fontsource-variable/inter/files/%2e%2e/package.json',
    '@fontsource-variable/inter/files/../package.json',
    // Shaped right, absent.
    '@fontsource-variable/inter/files/nope.woff2',
  ]
  for (const path of refused) expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 })
})
