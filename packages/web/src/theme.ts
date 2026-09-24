/**
 * The page's colour themes — each a set of the shadcn variables in `styles/global.css`, chosen
 * by `data-theme` on `<html>` and kept in this browser's localStorage. Every theme is dark, so
 * the `dark` class stays on `<html>` whatever is chosen and `dark:` variants keep applying.
 *
 * The choice is read before first paint by `theme-boot.ts` (so a reload shows no flash of the
 * default) and changed from the settings dialog, which applies it at once and saves it.
 */

export const THEMES = [
  { id: 'kanagawa-wave', label: 'Kanagawa Wave' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'nord', label: 'Nord' },
  { id: 'one-dark', label: 'One Dark' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'synthwave-84', label: "SynthWave '84" },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

/** What a browser with nothing saved shows — the theme the page has always had. */
export const DEFAULT_THEME: ThemeId = 'kanagawa-wave'

/** Where the choice is kept, per browser. */
export const THEME_STORAGE_KEY = 'enso:theme'

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value)
}

/** The saved theme, or the default — for nothing saved, an id this page no longer offers, or storage that refuses to be read. */
export function readSavedTheme(storage: Pick<Storage, 'getItem'>): ThemeId {
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY)
    return isThemeId(saved) ? saved : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Show `theme` now: the variables follow `data-theme` on the root. */
export function applyTheme(theme: ThemeId, root: HTMLElement): void {
  root.dataset.theme = theme
}

/** Keep `theme` for the next load; a storage that refuses (private mode, quota) keeps it for this page only. */
export function saveTheme(theme: ThemeId, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The theme still applies to this page; it just will not survive a reload.
  }
}
