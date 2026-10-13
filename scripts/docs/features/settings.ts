import { constantIn, type LiteralObject, type LiteralValue } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const THEME_FILE = 'packages/web/src/theme.ts'
const FONTS_FILE = 'packages/web/src/fonts.ts'

const isObject = (value: LiteralValue | undefined): value is LiteralObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Settings' theme list, family → id → label (`theme.ts`), and the theme a browser with nothing saved shows. */
const FAMILIES = constantIn(THEME_FILE, 'FAMILIES')
const DEFAULT_THEME = constantIn(THEME_FILE, 'DEFAULT_THEME')
if (!isObject(FAMILIES) || typeof DEFAULT_THEME !== 'string')
  throw new Error(`settings: ${THEME_FILE} FAMILIES is not an object, or DEFAULT_THEME not an id`)

/** The default theme's family and label, as Settings lists it. */
const [DEFAULT] = Object.entries(FAMILIES).flatMap(([family, members]) => {
  const label = isObject(members) ? members[DEFAULT_THEME] : undefined
  return typeof label === 'string' ? [{ family, label }] : []
})
if (DEFAULT === undefined)
  throw new Error(`settings: ${THEME_FILE} FAMILIES does not list DEFAULT_THEME ${DEFAULT_THEME}`)

/** Every family but the default's, in Settings' order. */
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
/** Settings' page, by its heading: every mark below is inside it but the subtitle. */
const PAGE: MarkTarget = { role: 'region', name: 'Settings' }
const SECTIONS: MarkTarget = { role: 'navigation', name: 'Settings sections' }

/** Settings (#407, #869): the look of the page, (#474) the permission rules pi runs under, and (#578) what trees take on disk. */
export const SETTINGS: FeatureSpec = {
  id: 'settings',
  title: 'Settings',
  landingTagline: 'themes · fonts · permissions · storage',
  shows: [
    `**Appearance**: the look of the page, a colour theme and a font for each of ${ROLE_COUNT} roles. ${DEFAULT.label} is the default theme, and the others include ${listed(OTHER_FAMILIES)}, in dark and light variants.`,
    "**Permissions**: the rules pi runs under, from `ENSO_HOME/permissions.json` in the permission engine's own format, in the order the engine reads them. You edit them as written: change a rule's pattern or decision, move or remove it, add rules and drafted groups of rules, save, and reset to Enso's policy. A card per mode previews the rules that mode puts in effect, read-only. **Try a command** asks the open thread what it would decide.",
    '**Storage**: the totals across every project (trees, what they take, and what the snapshot stores take), then every thread tree with what it takes on disk, and a Delete for each. See [Thread trees](./thread-trees.md).',
    "A project's own settings are on the project's page, not here: **Project settings…** in its menu on the rail. See [Thread trees](./thread-trees.md).",
  ],
  opens: [
    '{steps}, at the foot of the rail. Settings opens as a page in place of the thread, which keeps running behind it; opening a thread from the rail leaves the page.',
    "Each section has an address of its own, `?page=settings&section=appearance`, `permissions` or `storage`, beside the thread's `?thread=`: a reload, a link or the browser's back button comes back to it.",
  ],
  shots: [
    {
      image: 'settings',
      alt: 'The Settings page, on Appearance',
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ role: 'button', name: 'Settings', exact: true })
        await ui.page.getByRole('region', { name: 'Settings' }).getByText('Theme', { exact: true }).waitFor()
      },
      marks: [
        {
          target: SECTIONS,
          says: 'The sections: **Appearance**, **Permissions** and **Storage**, each at its own address.',
        },
        {
          target: { text: 'Theme', exact: true, within: PAGE },
          says: '**{shown}**. It applies at once, to every thread on the page.',
        },
        {
          target: { text: FIRST_ROLE, exact: true, within: PAGE },
          says: `The font roles: ${listed(ROLE_LABELS.map((label) => `**${label}**`))}. **{themeFont}** follows the theme. Any other choice keeps its font on every theme.`,
        },
        {
          target: { text: 'Appearance stays in this browser' },
          says: 'Where each section is kept: "{shown}" Appearance is not on the server, so another browser starts from the default.',
        },
      ],
      measure: {
        // The first role's choice with nothing saved: the option that follows the theme.
        themeFont: (page) => page.getByRole('region', { name: 'Settings' }).getByLabel(FIRST_ROLE, { exact: true }),
      },
    },
    {
      image: 'settings-permissions',
      alt: 'The Permissions section of Settings',
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ role: 'button', name: 'Settings', exact: true })
        await ui.click({ role: 'button', name: 'Permissions', exact: true, within: SECTIONS })
        await ui.page.getByRole('region', { name: 'Settings' }).getByRole('radiogroup', { name: 'Rules' }).waitFor()
      },
      marks: [
        {
          target: { text: 'This section is saved on the server', within: PAGE },
          says: 'Where the rules are: the one file the engine reads, saved on the server. A save names the version it read, so a change made by hand while the page was open is never overwritten unseen; the page offers **Reload from disk** or **Overwrite with mine**.',
        },
        {
          target: { role: 'button', name: 'Save', exact: true, within: PAGE },
          says: '**{shown}** writes the whole file. A policy the engine would not run as written is refused before it is written, each problem named at its place: the engine runs a file it cannot read as an EMPTY policy, every deny gone.',
        },
        {
          target: { role: 'radiogroup', name: 'Rules', within: PAGE },
          says: 'The views, one card each: **as written**, the rules you edit, then each mode, a read-only preview of the rules it puts in effect, in the order the engine reads them, with the ones that mode put there marked **from** it. Arrow keys move between the cards.',
        },
        {
          target: { text: 'yours — holds in every mode', within: PAGE },
          says: "Who a rule belongs to. **{shown}**: a rule of yours, which no mode changes. Enso's `**` rule on a surface is marked **Enso's catch-all — a mode may change this**: its decision can be edited, but it cannot be moved or removed, and every rule of yours comes after it.",
        },
      ],
      after: [
        "Below the rules: **Add a rule**, three **Drafted rules** groups (publishing, remote writes, and secrets on the path gate) that add only the rules not already in force, **Reset to Enso's policy…**, which shows what it would change before it asks and keeps the replaced file as `permissions.json.bak`, and **Try a command**.",
        'A banner says when `yoloMode` is on, since it makes every ask an allow. When the review log is on, the page names where it is written.',
        "An unsaved change is kept while the browser page is open: leaving Settings for a thread, or moving to another section, doesn't lose it. A reload does.",
      ],
    },
  ],
  lookFor: [
    'Pick the code font with the tool rows in mind. Commands, paths, tool input and output, and the debug drawer all use it, so it is the font you read most of a run in.',
    "A font is loaded the first time something uses it. Choosing a font you haven't used yet can take a moment to show.",
    "A saved rule is in force at a running thread's next tool call, with no restart. The settings beside the rules, such as `yoloMode`, are read when a prompt starts.",
    "A rule a run needs to keep is safer as **deny** than as **ask**: bypassPermissions makes Enso's asks allows, but not a deny of yours.",
  ],
  limits: [
    'Appearance is not stored on the server or in `ENSO_HOME`. Another browser, or a private window, starts from the default.',
    "Permissions shows only your file. A project's own policy, which the engine reads only for a trusted project, is not shown or edited here.",
    "**Try a command** answers for the policy as saved. It asks the open thread, in its current mode: its guards first, which refuse a call in every mode (a refusal is the answer, and the engine's verdict after it is moot), then its engine. It says so when no engine has loaded there, rather than guessing. The guards are asked only for a command (`bash`) or a path gate's path, as the `bash`, `read` or `write` call it stands for; a `path` check asks both the read and the write, as the engine answers it with the stricter of the two. On any other surface the answer says they were not asked.",
    "The terminal is not affected by Appearance. It uses pi's own theme. It does run under the same permission rules.",
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
