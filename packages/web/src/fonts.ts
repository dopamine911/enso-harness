/**
 * The page's fonts (#407 item 6): the families it ships, the per-role choice in Settings, and how
 * both reach the page.
 *
 * Each theme names its fonts through three variables (`styles/themes.css`: `--font-body`,
 * `--font-display`, `--font-code`). A choice here overrides one of them for this browser: a
 * family by name, the system's own, or nothing — the theme's. The override is an inline style on
 * `<html>`, the element `data-theme` sits on, so it wins over the theme's rule without any
 * specificity game, and removing it hands the role straight back to the theme.
 *
 * THE FILES are not bundled (`server/font-files.ts` says why): `linkFontFaces` adds each family's
 * own `@fontsource` stylesheet, served unbundled under `/fonts/`. They only DECLARE faces — a
 * browser downloads one when text is set in it — so a family no theme or choice uses costs a few
 * lines of `@font-face`, and nothing is inlined into the page's stylesheet.
 */

/** What a font is for: a role maps to one of the themes' three variables. */
export type FontRole = 'body' | 'display' | 'code'

type FontKind = 'sans' | 'serif' | 'mono'

interface FontFamily {
  readonly label: string
  /** The CSS family name the `@fontsource` stylesheet declares. */
  readonly family: string
  readonly kind: FontKind
  /** The package stylesheets that declare its faces, as served under `/fonts/`. */
  readonly stylesheets: readonly string[]
}

/** Every family the page ships — the themes' fonts; `package.json` depends on each package. */
const FAMILIES = {
  geist: {
    label: 'Geist',
    family: 'Geist Variable',
    kind: 'sans',
    stylesheets: ['@fontsource-variable/geist/index.css'],
  },
  inter: {
    label: 'Inter',
    family: 'Inter Variable',
    kind: 'sans',
    stylesheets: ['@fontsource-variable/inter/index.css'],
  },
  'ibm-plex-sans': {
    label: 'IBM Plex Sans',
    family: 'IBM Plex Sans Variable',
    kind: 'sans',
    stylesheets: ['@fontsource-variable/ibm-plex-sans/index.css'],
  },
  'source-sans-3': {
    label: 'Source Sans 3',
    family: 'Source Sans 3 Variable',
    kind: 'sans',
    stylesheets: ['@fontsource-variable/source-sans-3/index.css'],
  },
  sora: { label: 'Sora', family: 'Sora Variable', kind: 'sans', stylesheets: ['@fontsource-variable/sora/index.css'] },
  'space-grotesk': {
    label: 'Space Grotesk',
    family: 'Space Grotesk Variable',
    kind: 'sans',
    stylesheets: ['@fontsource-variable/space-grotesk/index.css'],
  },
  fraunces: {
    label: 'Fraunces',
    family: 'Fraunces Variable',
    kind: 'serif',
    stylesheets: ['@fontsource-variable/fraunces/wght.css', '@fontsource-variable/fraunces/wght-italic.css'],
  },
  'jetbrains-mono': {
    label: 'JetBrains Mono',
    family: 'JetBrains Mono Variable',
    kind: 'mono',
    stylesheets: ['@fontsource-variable/jetbrains-mono/index.css'],
  },
  'ibm-plex-mono': {
    label: 'IBM Plex Mono',
    family: 'IBM Plex Mono',
    kind: 'mono',
    stylesheets: ['@fontsource/ibm-plex-mono/400.css', '@fontsource/ibm-plex-mono/500.css'],
  },
} as const satisfies Record<string, FontFamily>

export type FontFamilyId = keyof typeof FAMILIES

/** A role's choice: the theme's own font, the system's, or one of the families. */
export type FontChoice = 'theme' | 'system' | FontFamilyId

export type FontSettings = Readonly<Record<FontRole, FontChoice>>

/** Nothing chosen: every role is the theme's. */
export const DEFAULT_FONTS: FontSettings = { body: 'theme', display: 'theme', code: 'theme' }

/** The roles as Settings lists them, with the theme variable each one overrides. */
export const FONT_ROLES: ReadonlyArray<{ readonly role: FontRole; readonly label: string; readonly variable: string }> =
  [
    { role: 'body', label: 'Body', variable: '--font-body' },
    { role: 'display', label: 'Headings', variable: '--font-display' },
    { role: 'code', label: 'Code', variable: '--font-code' },
  ]

/** The generic family each kind falls back to — also what "System" means for a role. */
const GENERIC: Readonly<Record<FontKind, string>> = {
  sans: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

/** Code is set in a monospace; every other role in a proportional face. */
function fitsRole(kind: FontKind, role: FontRole): boolean {
  return (kind === 'mono') === (role === 'code')
}

/** The families a role may be set in, in the list's order. */
export function fontOptionsFor(role: FontRole): ReadonlyArray<{ readonly id: FontFamilyId; readonly label: string }> {
  return (Object.entries(FAMILIES) as [FontFamilyId, FontFamily][])
    .filter(([, font]) => fitsRole(font.kind, role))
    .map(([id, font]) => ({ id, label: font.label }))
}

function isFamilyId(value: unknown): value is FontFamilyId {
  return typeof value === 'string' && Object.hasOwn(FAMILIES, value)
}

/** A choice this role may take: the theme's, the system's, or a family that fits it. */
export function isFontChoice(role: FontRole, value: unknown): value is FontChoice {
  if (value === 'theme' || value === 'system') return true
  return isFamilyId(value) && fitsRole(FAMILIES[value].kind, role)
}

/** The font stack a choice sets for a role, or undefined for the theme's — nothing to override. */
export function fontStack(role: FontRole, choice: FontChoice): string | undefined {
  if (choice === 'theme') return undefined
  if (choice === 'system') return GENERIC[role === 'code' ? 'mono' : 'sans']
  const font = FAMILIES[choice]
  return `"${font.family}", ${GENERIC[font.kind]}`
}

/** Where the choice is kept, per browser — beside the theme (`theme.ts`). */
export const FONTS_STORAGE_KEY = 'enso:fonts'

/**
 * The saved choice, role by role; a role saved with a choice this page no longer offers (or one
 * that does not fit it), or nothing readable at all, is the theme's.
 */
export function readSavedFonts(storage: Pick<Storage, 'getItem'> | undefined): FontSettings {
  let saved: unknown
  try {
    saved = JSON.parse(storage?.getItem(FONTS_STORAGE_KEY) ?? 'null')
  } catch {
    return DEFAULT_FONTS
  }
  if (typeof saved !== 'object' || saved === null) return DEFAULT_FONTS
  const record = saved as Record<string, unknown>
  const choiceFor = (role: FontRole): FontChoice => {
    const value = record[role]
    return isFontChoice(role, value) ? value : 'theme'
  }
  return { body: choiceFor('body'), display: choiceFor('display'), code: choiceFor('code') }
}

/** Keep the choice for the next load; a storage that refuses keeps it for this page only. */
export function saveFonts(settings: FontSettings, storage: Pick<Storage, 'setItem'> | undefined): void {
  try {
    storage?.setItem(FONTS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // The fonts still apply to this page; they just will not survive a reload.
  }
}

/** Show the choice now: each role's override on `root`, or none, which is the theme's font. */
export function applyFonts(settings: FontSettings, root: HTMLElement): void {
  for (const { role, variable } of FONT_ROLES) {
    const stack = fontStack(role, settings[role])
    if (stack === undefined) root.style.removeProperty(variable)
    else root.style.setProperty(variable, stack)
  }
}

/**
 * Declare every family's faces: one `<link>` per package stylesheet, under `/fonts/`
 * (`server/font-files.ts`). Once per document — a second call adds nothing.
 */
export function linkFontFaces(document: Document): void {
  for (const font of Object.values(FAMILIES) as FontFamily[]) {
    for (const stylesheet of font.stylesheets) {
      const href = `/fonts/${stylesheet}`
      if (document.head.querySelector(`link[data-enso-font="${stylesheet}"]`) !== null) continue
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.dataset.ensoFont = stylesheet
      document.head.appendChild(link)
    }
  }
}
