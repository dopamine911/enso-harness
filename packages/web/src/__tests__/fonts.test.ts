import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  applyFonts,
  DEFAULT_FONTS,
  FONTS_STORAGE_KEY,
  fontOptionsFor,
  linkFontFaces,
  readSavedFonts,
  saveFonts,
} from '../fonts.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * #407 item 6: a font per role, kept in this browser, over the theme's; and the families' faces
 * declared from their own stylesheets, unbundled.
 */

// The links are what is asserted; happy-dom would otherwise fetch each one from nowhere.
type HappyDomWindow = {
  happyDOM: { settings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } }
}
let saved = { disableCSSFileLoading: false, handleDisabledFileLoadingAsSuccess: false }
beforeAll(() => {
  ensureDom()
  const { settings } = (window as unknown as HappyDomWindow).happyDOM
  saved = {
    disableCSSFileLoading: settings.disableCSSFileLoading,
    handleDisabledFileLoadingAsSuccess: settings.handleDisabledFileLoadingAsSuccess,
  }
  settings.disableCSSFileLoading = true
  settings.handleDisabledFileLoadingAsSuccess = true
})
afterAll(async () => {
  Object.assign((window as unknown as HappyDomWindow).happyDOM.settings, saved)
  await releaseDom()
})

const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) }
}

test('a saved choice comes back role by role; one this page cannot honour is the theme’s', () => {
  const storage = memoryStorage()
  saveFonts({ body: 'inter', display: 'fraunces', code: 'system' }, storage)
  expect(readSavedFonts(storage)).toEqual({ body: 'inter', display: 'fraunces', code: 'system' })
  // A monospace is not a body face, a proportional face is not code, and a family this page no
  // longer ships is nothing — each falls back to the theme's, alone, leaving the others.
  storage.setItem(FONTS_STORAGE_KEY, JSON.stringify({ body: 'jetbrains-mono', display: 'gone', code: 'inter' }))
  expect(readSavedFonts(storage)).toEqual(DEFAULT_FONTS)
  storage.setItem(FONTS_STORAGE_KEY, JSON.stringify({ body: 'geist', code: 'ibm-plex-mono' }))
  expect(readSavedFonts(storage)).toEqual({ body: 'geist', display: 'theme', code: 'ibm-plex-mono' })
  // Unreadable is the default, never a throw on boot.
  storage.setItem(FONTS_STORAGE_KEY, '{not json')
  expect(readSavedFonts(storage)).toEqual(DEFAULT_FONTS)
  expect(readSavedFonts(undefined)).toEqual(DEFAULT_FONTS)
})

test('code offers the monospaces; body and headings every other family', () => {
  const ids = (role: Parameters<typeof fontOptionsFor>[0]): string[] => fontOptionsFor(role).map((option) => option.id)
  expect(ids('code')).toEqual(['jetbrains-mono', 'ibm-plex-mono'])
  expect(ids('body')).toContain('fraunces')
  expect(ids('body')).not.toContain('jetbrains-mono')
  expect(ids('display')).toEqual(ids('body'))
})

// The override sits on the element `data-theme` does, so it wins over the theme; "the theme's"
// is the override REMOVED — the role then follows every theme switch, not a snapshot of one.
test("a choice overrides its role's theme variable on the root; the theme's font removes the override", () => {
  const root = document.createElement('html')
  applyFonts({ body: 'inter', display: 'theme', code: 'system' }, root)
  expect(root.style.getPropertyValue('--font-body')).toBe('"Inter Variable", ui-sans-serif, system-ui, sans-serif')
  expect(root.style.getPropertyValue('--font-display')).toBe('')
  expect(root.style.getPropertyValue('--font-code')).toBe('ui-monospace, SFMono-Regular, Menlo, monospace')
  applyFonts(DEFAULT_FONTS, root)
  expect(root.style.getPropertyValue('--font-body')).toBe('')
  expect(root.style.getPropertyValue('--font-code')).toBe('')
})

// Each link is a file the font route serves: a real stylesheet of a `@fontsource` package the web
// package depends on (the route's own condition, `server/font-files.ts`). A family added here
// without its dependency, or a stylesheet renamed upstream, fails here instead of 404ing a face.
test('⚠ the faces are declared once per document, each from a stylesheet the font route serves', () => {
  const page = document.implementation.createHTMLDocument('fonts')
  linkFontFaces(page)
  linkFontFaces(page)
  const hrefs = [...page.head.querySelectorAll<HTMLLinkElement>('link[data-enso-font]')].map((link) =>
    link.getAttribute('href'),
  )
  expect(new Set(hrefs).size).toBe(hrefs.length)
  expect(hrefs.length).toBeGreaterThan(0)
  const webPackageDir = join(import.meta.dir, '..', '..')
  const dependencies = Object.keys(
    (JSON.parse(readFileSync(join(webPackageDir, 'package.json'), 'utf8')) as { dependencies: object }).dependencies,
  )
  const linkedPackages = new Set<string>()
  for (const href of hrefs) {
    const [scope, name, ...file] = (href ?? '').replace(/^\/fonts\//, '').split('/')
    const packageName = `${scope}/${name}`
    linkedPackages.add(packageName)
    expect(dependencies).toContain(packageName)
    const packageDir = dirname(Bun.resolveSync(`${packageName}/package.json`, webPackageDir))
    expect({ href, exists: existsSync(join(packageDir, ...file)) }).toEqual({ href, exists: true })
  }
  // And the other direction: no font package is shipped that the page never links.
  expect([...linkedPackages].toSorted()).toEqual(
    dependencies.filter((name) => name.startsWith('@fontsource')).toSorted(),
  )
})
