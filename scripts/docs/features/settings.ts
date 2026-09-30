import { constantIn, type LiteralObject, type LiteralValue } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const THEME_FILE = 'packages/web/src/theme.ts'
const FONTS_FILE = 'packages/web/src/fonts.ts'

const isObject = (value: LiteralValue | undefined): value is LiteralObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The dialog's theme list, family → id → label (`theme.ts`), and the theme a browser with nothing saved shows. */
const FAMILIES = constantIn(THEME_FILE, 'FAMILIES')
const DEFAULT_THEME = constantIn(THEME_FILE, 'DEFAULT_THEME')
if (!isObject(FAMILIES) || typeof DEFAULT_THEME !== 'string')
  throw new Error(`settings: ${THEME_FILE} FAMILIES is not an object, or DEFAULT_THEME not an id`)

/** The default theme's family and label, as the dialog lists it. */
const [DEFAULT] = Object.entries(FAMILIES).flatMap(([family, members]) => {
  const label = isObject(members) ? members[DEFAULT_THEME] : undefined
  return typeof label === 'string' ? [{ family, label }] : []
})
if (DEFAULT === undefined)
  throw new Error(`settings: ${THEME_FILE} FAMILIES does not list DEFAULT_THEME ${DEFAULT_THEME}`)

/** Every family but the default's, in the dialog's order. */
const OTHER_FAMILIES = Object.keys(FAMILIES).filter((family) => family !== DEFAULT.family)

/** The font roles as Settings lists them (`fonts.ts`), by label. */
const FONT_ROLES = constantIn(FONTS_FILE, 'FONT_ROLES')
if (!Array.isArray(FONT_ROLES)) throw new Error(`settings: ${FONTS_FILE} FONT_ROLES is not an array`)
const ROLE_LABELS = FONT_ROLES.map((fontRole) => {
  const label = isObject(fontRole) ? fontRole.label : undefined
  if (typeof label !== 'string') throw new Error(`settings: ${FONTS_FILE} FONT_ROLES has an entry without a label`)
  return label
})

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  const last = items.at(-1) ?? ''
  return items.length < 2 ? last : `${items.slice(0, -1).join(', ')} and ${last}`
}

/** A small count as a reader writes it. */
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'] as const
const ROLE_COUNT = COUNT_WORDS[ROLE_LABELS.length]
if (ROLE_COUNT === undefined)
  throw new Error(`settings: ${FONTS_FILE} FONT_ROLES has ${ROLE_LABELS.length} roles, no word for it`)

const [FIRST_ROLE = ''] = ROLE_LABELS
const DIALOG: MarkTarget = { role: 'dialog', name: 'Settings' }

/** Settings (#407): the look of the page, from the header of the demo thread. */
export const SETTINGS: FeatureSpec = {
  id: 'settings',
  title: 'Settings',
  landingTagline: 'themes · fonts',
  shows: [
    `The look of the page: a colour theme, and a font for each of ${ROLE_COUNT} roles. ${DEFAULT.label} is the default theme, and the others include ${listed(OTHER_FAMILIES)}, in dark and light variants.`,
  ],
  opens: ['{steps}, the sliders icon at the right of the header.'],
  shots: [
    {
      image: 'settings',
      alt: 'The Settings dialog',
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ role: 'button', name: 'settings' })
        await ui.page.getByRole('dialog', { name: 'Settings' }).getByText('Theme', { exact: true }).waitFor()
      },
      marks: [
        {
          target: { text: 'Theme', exact: true, within: DIALOG },
          says: '**{shown}**. It applies at once, to every thread on the page.',
        },
        {
          target: { text: FIRST_ROLE, exact: true, within: DIALOG },
          says: `The font roles: ${listed(ROLE_LABELS.map((label) => `**${label}**`))}. **{themeFont}** follows the theme. Any other choice keeps its font on every theme.`,
        },
        {
          target: { text: 'kept in this browser', within: DIALOG },
          says: '**{shown}**: settings are saved in this browser only.',
        },
      ],
      measure: {
        // The first role's choice with nothing saved: the option that follows the theme.
        themeFont: (page) => page.getByRole('dialog', { name: 'Settings' }).getByLabel(FIRST_ROLE, { exact: true }),
      },
    },
  ],
  lookFor: [
    'Pick the code font with the tool rows in mind. Commands, paths, tool input and output, and the debug drawer all use it, so it is the font you read most of a run in.',
    "A font is loaded the first time something uses it. Choosing a font you haven't used yet can take a moment to show.",
  ],
  limits: [
    'Settings are not stored on the server or in `ENSO_HOME`. Another browser, or a private window, starts from the default.',
    'They change only how the page looks. Nothing here changes what pi does.',
    "The terminal is not affected. It uses pi's own theme.",
  ],
  see: [
    {
      path: 'docs/seams/presentation.md',
      label: 'Presentation seam',
      why: 'how the page renders what the thread sends it',
    },
    { path: 'docs/features/chat.md', label: 'Chat' },
  ],
}
