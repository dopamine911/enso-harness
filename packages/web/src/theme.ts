/**
 * The page's colour themes — each a set of the shadcn variables in `styles/themes.css`, chosen
 * by `data-theme` on `<html>` and kept in this browser's localStorage. A theme is dark or light:
 * a dark one keeps the `dark` class on `<html>` (Tailwind's `dark:` variants follow it), a light
 * one removes it.
 *
 * The choice is applied before first paint by `index.html`'s inline script (so a reload shows no
 * flash of the default) — it reads the id AND the scheme, saved side by side, because it cannot
 * import this list — and changed from the settings dialog, which applies it at once and saves it.
 */

export type ThemeScheme = 'dark' | 'light'

export interface ThemeOption {
  readonly id: ThemeId
  readonly label: string
  /** The dialog groups by it. */
  readonly family: string
  readonly scheme: ThemeScheme
}

/** The themes as the dialog lists them: family → id → label. Every theme is dark unless it is in `LIGHT_THEMES`. */
const FAMILIES = {
  Kanagawa: { 'kanagawa-wave': 'Kanagawa Wave' },
  Catppuccin: {
    'catppuccin-latte': 'Catppuccin Latte',
    'catppuccin-frappe': 'Catppuccin Frappé',
    'catppuccin-macchiato': 'Catppuccin Macchiato',
    'catppuccin-mocha': 'Catppuccin Mocha',
  },
  Dracula: { dracula: 'Dracula' },
  Everforest: {
    'everforest-dark-hard': 'Everforest Dark Hard',
    'everforest-dark-medium': 'Everforest Dark Medium',
    'everforest-dark-soft': 'Everforest Dark Soft',
    'everforest-light-hard': 'Everforest Light Hard',
    'everforest-light-medium': 'Everforest Light Medium',
    'everforest-light-soft': 'Everforest Light Soft',
  },
  Gruvbox: { 'gruvbox-dark': 'Gruvbox Dark' },
  Nord: { nord: 'Nord' },
  'One Dark': { 'one-dark': 'One Dark' },
  'Rosé Pine': {
    'rose-pine-main': 'Rosé Pine',
    'rose-pine-moon': 'Rosé Pine Moon',
    'rose-pine-dawn': 'Rosé Pine Dawn',
  },
  "SynthWave '84": { 'synthwave-84': "SynthWave '84" },
  'Tokyo Dark': { tokyodark: 'Tokyo Dark' },
} as const

type Families = typeof FAMILIES
export type ThemeId = { [Family in keyof Families]: keyof Families[Family] }[keyof Families]

const LIGHT_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>([
  'catppuccin-latte',
  'everforest-light-hard',
  'everforest-light-medium',
  'everforest-light-soft',
  'rose-pine-dawn',
])

export const THEMES: readonly ThemeOption[] = Object.entries(FAMILIES).flatMap(([family, members]) =>
  // `Object.entries` widens the keys to `string`; they are the ids `ThemeId` is built from.
  (Object.entries(members) as Array<[ThemeId, string]>).map(
    ([id, label]): ThemeOption => ({ id, label, family, scheme: LIGHT_THEMES.has(id) ? 'light' : 'dark' }),
  ),
)

/** What a browser with nothing saved shows — the theme the page has always had. */
export const DEFAULT_THEME: ThemeId = 'kanagawa-wave'

/** Where the choice is kept, per browser — the id, and beside it the scheme the pre-paint script needs. */
export const THEME_STORAGE_KEY = 'enso:theme'
export const THEME_SCHEME_STORAGE_KEY = 'enso:theme-scheme'

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value)
}

function schemeOf(theme: ThemeId): ThemeScheme {
  return LIGHT_THEMES.has(theme) ? 'light' : 'dark'
}

/** The themes by family, in the list's order — the dialog's groups. */
export function themesByFamily(): Array<{ family: string; themes: ThemeOption[] }> {
  const families: Array<{ family: string; themes: ThemeOption[] }> = []
  for (const theme of THEMES) {
    const group = families.find((candidate) => candidate.family === theme.family)
    if (group === undefined) families.push({ family: theme.family, themes: [theme] })
    else group.themes.push(theme)
  }
  return families
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

/** Show `theme` now: the variables follow `data-theme`, and `dark:` variants the `dark` class. */
export function applyTheme(theme: ThemeId, root: HTMLElement): void {
  root.dataset.theme = theme
  root.classList.toggle('dark', schemeOf(theme) === 'dark')
}

/** Keep `theme` for the next load; a storage that refuses (private mode, quota) keeps it for this page only. */
export function saveTheme(theme: ThemeId, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme)
    storage.setItem(THEME_SCHEME_STORAGE_KEY, schemeOf(theme))
  } catch {
    // The theme still applies to this page; it just will not survive a reload.
  }
}
