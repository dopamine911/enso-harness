import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyTheme,
  DEFAULT_THEME,
  readSavedTheme,
  saveTheme,
  THEME_SCHEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEMES,
} from '../theme.ts'

/**
 * The colour themes (`theme.ts`): what a browser shows for what it saved, and the three places
 * a theme lives — the list, the stylesheet's blocks, and index.html's pre-paint script — kept
 * in step, because each fails silently when it drifts from the others.
 */

const WEB = join(import.meta.dir, '..', '..')
const STYLESHEET = readFileSync(join(WEB, 'src', 'styles', 'themes.css'), 'utf8')

/** The variables a block declares, by name. */
function declared(block: string): Set<string> {
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1] ?? ''))
}

/** The body of the stylesheet block whose selector list ends with `selector`. */
function blockOf(selector: string): string {
  const start = STYLESHEET.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no block for ${selector}`)
  return STYLESHEET.slice(start, STYLESHEET.indexOf('}', start))
}

test('a saved theme is shown; nothing saved, one no longer offered, or storage that refuses, is the default', () => {
  const holding = (value: string | null): Pick<Storage, 'getItem'> => ({ getItem: () => value })
  expect(readSavedTheme(holding('nord'))).toBe('nord')
  expect(readSavedTheme(holding(null))).toBe(DEFAULT_THEME)
  expect(readSavedTheme(holding('solarized'))).toBe(DEFAULT_THEME)
  expect(
    readSavedTheme({
      getItem: () => {
        throw new Error('SecurityError: storage disabled')
      },
    }),
  ).toBe(DEFAULT_THEME)
})

// A theme without a block would show the default under its own name; a block missing a
// variable would borrow the default's value for it — both silently.
test('every theme has a stylesheet block, and each defines every variable the default does', () => {
  const required = declared(blockOf('[data-theme="kanagawa-wave"]'))
  expect(required.size).toBeGreaterThan(30)
  for (const theme of THEMES) {
    const missing = [...required].filter((variable) => !declared(blockOf(`[data-theme="${theme.id}"]`)).has(variable))
    expect({ theme: theme.id, missing }).toEqual({ theme: theme.id, missing: [] })
  }
  const blocks = [...STYLESHEET.matchAll(/\[data-theme="([a-z0-9-]+)"\]/g)].map((match) => match[1])
  expect(new Set(blocks)).toEqual(new Set(THEMES.map((theme) => theme.id)))
})

// A light theme's block must say `color-scheme: light` (native controls, scrollbars), and the
// page must drop the `dark` class for it — or every `dark:` variant paints a light theme dark.
test("every theme block states its theme's colour scheme", () => {
  for (const theme of THEMES)
    expect({
      theme: theme.id,
      scheme: /color-scheme:\s*(\w+)/.exec(blockOf(`[data-theme="${theme.id}"]`))?.[1],
    }).toEqual({
      theme: theme.id,
      scheme: theme.scheme,
    })
})

test('applying a theme sets data-theme and the `dark` class by its scheme; saving keeps the scheme beside it', () => {
  const classes = new Set(['dark'])
  const root = {
    dataset: {} as DOMStringMap,
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
  } as unknown as HTMLElement
  applyTheme('catppuccin-latte', root)
  expect([root.dataset.theme, classes.has('dark')]).toEqual(['catppuccin-latte', false])
  applyTheme('nord', root)
  expect([root.dataset.theme, classes.has('dark')]).toEqual(['nord', true])
  const saved = new Map<string, string>()
  saveTheme('rose-pine-dawn', { setItem: (key: string, value: string) => saved.set(key, value) })
  expect(Object.fromEntries(saved)).toEqual({
    [THEME_STORAGE_KEY]: 'rose-pine-dawn',
    [THEME_SCHEME_STORAGE_KEY]: 'light',
  })
})

// The pre-paint script is inline, so it cannot import the keys: it spells them, and this holds the spelling.
test("index.html's pre-paint script reads the keys the settings dialog saves under", () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8')
  expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`)
  expect(html).toContain(`localStorage.getItem('${THEME_SCHEME_STORAGE_KEY}') === 'light'`)
})
