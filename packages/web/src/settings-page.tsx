import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { CheckIcon, ChevronRightIcon, FolderIcon, GlobeIcon, LayersIcon, LockIcon, ShieldAlertIcon } from 'lucide-react'
import { useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select.tsx'
import {
  applyFonts,
  FONT_ROLES,
  type FontRole,
  type FontSettings,
  fontOptionsFor,
  fontStack,
  isFontChoice,
  readSavedFonts,
  saveFonts,
} from './fonts.ts'
import { cn } from './lib/utils.ts'
import { SUB_TITLE } from './page-styles.ts'
import { PermissionsSection, type PolicyEditor } from './permissions-settings.tsx'
import { SecuritySection } from './security-settings.tsx'
import { applyTheme, pageStorage, readSavedTheme, saveTheme, THEME_FAMILIES, type ThemeId } from './theme.ts'
import { SETTINGS_SECTIONS, type SettingsSection } from './thread-url.ts'
import { TreesSection } from './trees-settings.tsx'
import { WebToolsSection } from './web-tools-settings.tsx'

/**
 * Settings, a page (#869; the header's dialog before it), in five sections, each its own route.
 * Appearance: the page's colour theme, and a font per role (#407) — a choice applies at once and is
 * kept in this browser (`theme.ts`, `fonts.ts`). Each option draws itself — a theme's card preview
 * wears `data-theme`, so its colours are that theme's variables, and a font's name is set in that font —
 * so nothing here restates a value the page already holds. Permissions (#474): the rules pi runs
 * under, saved on the server (`permissions-settings.tsx`); its draft is held beneath the page
 * (`routed-page.tsx`), so leaving Settings keeps it. Security (#933): `config.json`'s `security`
 * section and the judge's key (`security-settings.tsx`). Web tools (#924, #932): the hosts
 * `web_fetch` may read, and `web_search`'s backend, Tavily domains and key, saved on the server in
 * `ENSO_HOME/config.json` and `secrets.env` (`web-tools-settings.tsx`). Storage (#578):
 * what each thread tree and snapshot store costs on disk, measured when the section opens, with each
 * tree's Delete (`trees-settings.tsx`).
 */

/**
 * A theme drawn in its own colours (#417, the prototype's theme card): a rail, two lines of text, a
 * primary pill and three chart dots. The preview wears `data-theme`, so every colour in it is that
 * theme's variable whatever the page wears.
 */
function ThemePreview({ theme }: { theme: ThemeId }): React.ReactNode {
  return (
    <span
      data-theme={theme}
      aria-hidden="true"
      className="grid h-16 grid-cols-theme-preview overflow-hidden rounded-sm border bg-background"
    >
      <span className="border-r bg-sidebar" />
      <span className="grid content-center gap-1.5 px-2">
        <span className="h-1.5 rounded-full bg-muted-foreground opacity-60" />
        <span className="h-1.5 w-3/5 rounded-full bg-muted-foreground opacity-60" />
        <span className="h-2.5 w-2/5 rounded-full bg-primary" />
        <span className="flex gap-1">
          <span className="size-2 rounded-full bg-chart-2" />
          <span className="size-2 rounded-full bg-chart-3" />
          <span className="size-2 rounded-full bg-chart-4" />
        </span>
      </span>
    </span>
  )
}

/** Every theme, in the families' order: the order the arrow keys walk the cards in. */
const THEME_ORDER: readonly ThemeId[] = THEME_FAMILIES.flatMap(({ themes }) => themes.map((option) => option.id))

/**
 * The themes as the prototype's card grid, one group per family: one radio group whose arrow keys
 * walk every card, the chosen one the only tab stop (the ARIA radio group's keyboard).
 */
function ThemeCards({ theme, onChoose }: { theme: ThemeId; onChoose: (theme: ThemeId) => void }): React.ReactNode {
  const move = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + step + THEME_ORDER.length) % THEME_ORDER.length]
    if (next === undefined) return
    onChoose(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-theme-card="${next}"]`)?.focus()
  }
  return (
    <div role="radiogroup" aria-labelledby="settings-theme-label" tabIndex={-1} className="grid gap-3" onKeyDown={move}>
      {THEME_FAMILIES.map(({ family, themes }) => (
        <div key={family} className="grid gap-2">
          <span aria-hidden="true" className="font-mono text-meta tracking-wider text-muted-foreground uppercase">
            {family}
          </span>
          <div className="grid grid-cols-theme-cards gap-3">
            {themes.map((option) => {
              const checked = option.id === theme
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={`${option.label}, ${option.scheme}`}
                  tabIndex={checked ? 0 : -1}
                  data-theme-card={option.id}
                  onClick={() => onChoose(option.id)}
                  className={cn(
                    'grid gap-2 rounded-lg border bg-card p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    checked ? 'border-primary ring-1 ring-primary' : 'hover:border-border-strong',
                  )}
                >
                  <ThemePreview theme={option.id} />
                  <span className="flex items-center justify-between gap-2 px-1 text-sm font-medium">
                    <span>{option.label}</span>
                    {checked ? (
                      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                    ) : (
                      <span className="font-mono text-tag text-muted-foreground">{option.scheme}</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Each role's sample line, set in the role's own font: the prototype's, so a choice shows before the page does. */
const FONT_SAMPLES: Readonly<Record<FontRole, { readonly text: string; readonly face: string }>> = {
  body: { text: 'pi read 3 files and changed one.', face: 'font-sans' },
  display: { text: 'Give agents room to work.', face: 'font-heading' },
  code: { text: 'git push --dry-run origin main', face: 'font-mono' },
}

/**
 * One role's font: the theme's (the default — the role follows every theme switch), the system's,
 * or a family that fits the role, each named in its own face. Opening the list is what downloads
 * those faces; a closed list costs nothing. A row as the prototype draws it: label, choice, sample.
 */
function FontField({
  role,
  label,
  fonts,
  onChoose,
}: {
  role: FontRole
  label: string
  fonts: FontSettings
  onChoose: (role: FontRole, value: string) => void
}): React.ReactNode {
  const id = `settings-font-${role}`
  return (
    <div className="grid items-center gap-x-4 gap-y-2 rounded-sm border bg-card px-4 py-3 lg:grid-cols-font-row">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <Select value={fonts[role]} onValueChange={(value) => onChoose(role, value)}>
        <SelectTrigger
          id={id}
          className="h-10 w-full rounded-sm border-border-strong bg-background dark:border-border-strong dark:bg-background"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="theme">the theme's font</SelectItem>
          <SelectItem value="system">
            <span style={{ fontFamily: fontStack(role, 'system') }}>system</span>
          </SelectItem>
          {fontOptionsFor(role).map((option) => (
            <SelectItem key={option.id} value={option.id}>
              <span style={{ fontFamily: fontStack(role, option.id) }}>{option.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span aria-hidden="true" className={cn('truncate text-muted-foreground', FONT_SAMPLES[role].face)}>
        {FONT_SAMPLES[role].text}
      </span>
    </div>
  )
}

function AppearanceFields(): React.ReactNode {
  const [theme, setTheme] = useState<ThemeId>(() => readSavedTheme(pageStorage()))
  const [fonts, setFonts] = useState<FontSettings>(() => readSavedFonts(pageStorage()))
  const chooseFont = (role: FontRole, value: string): void => {
    if (!isFontChoice(role, value)) return
    const next = { ...fonts, [role]: value }
    setFonts(next)
    applyFonts(next, document.documentElement)
    saveFonts(next, pageStorage())
  }
  const choose = (value: ThemeId): void => {
    setTheme(value)
    applyTheme(value, document.documentElement)
    saveTheme(value, pageStorage())
  }
  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-muted-foreground">Changes apply at once, to every thread on this page.</p>
      <div className="grid gap-3">
        <h3 id="settings-theme-label" className={SUB_TITLE}>
          Theme
        </h3>
        <ThemeCards theme={theme} onChoose={choose} />
      </div>
      <div className="grid gap-3">
        <h3 className={SUB_TITLE}>Fonts</h3>
        {FONT_ROLES.map(({ role, label }) => (
          <FontField key={role} role={role} label={label} fonts={fonts} onChoose={chooseFont} />
        ))}
        <p className="text-sm text-muted-foreground">
          A role set to the theme's font follows the theme; any other choice keeps its font on every theme.
        </p>
      </div>
    </div>
  )
}

/** Each section's link: its label and icon. */
const SECTION_LINKS: Readonly<Record<SettingsSection, { readonly label: string; readonly icon: React.ReactNode }>> = {
  appearance: { label: 'Appearance', icon: <LayersIcon /> },
  permissions: { label: 'Permissions', icon: <LockIcon /> },
  security: { label: 'Security', icon: <ShieldAlertIcon /> },
  'web-tools': { label: 'Web tools', icon: <GlobeIcon /> },
  storage: { label: 'Storage', icon: <FolderIcon /> },
}

/**
 * The sections' links, the one shown marked as the current page, then past a hairline the way to
 * the Projects page (#417, as the prototype's nav ends): a column, a row on a narrow screen.
 */
function SectionNav({
  section,
  onSection,
  onOpenProjects,
}: {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
  onOpenProjects: () => void
}): React.ReactNode {
  const link =
    'flex min-h-10 shrink-0 items-center gap-2 rounded-sm px-3 text-left text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:w-full [&_svg]:size-4'
  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto md:sticky md:top-6 md:grid md:w-settings-nav md:shrink-0 md:gap-0.5"
    >
      {SETTINGS_SECTIONS.map((linked) => (
        <button
          key={linked}
          type="button"
          aria-current={linked === section ? 'page' : undefined}
          onClick={() => onSection(linked)}
          className={cn(
            link,
            linked === section
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-card hover:text-foreground',
          )}
        >
          {SECTION_LINKS[linked].icon}
          {SECTION_LINKS[linked].label}
        </button>
      ))}
      <hr className="my-2 hidden h-px border-0 bg-border md:block" />
      <button
        type="button"
        onClick={onOpenProjects}
        className={cn(link, 'text-muted-foreground hover:bg-card hover:text-foreground')}
      >
        <FolderIcon aria-hidden="true" />
        Projects
        <ChevronRightIcon aria-hidden="true" className="size-3!" />
      </button>
    </nav>
  )
}

export interface SettingsPageProps {
  readonly section: SettingsSection
  /** Show another section: a navigation of its own, so back returns to this one. */
  readonly onSection: (section: SettingsSection) => void
  /** The Permissions section's editor (`usePermissionPolicy`), held beneath the page so leaving keeps a draft. */
  readonly permissions: PolicyEditor
  /** The thread behind the page: the one "Try a command" asks. */
  readonly threadId: string | undefined
  readonly fetch?: FetchLike | undefined
  /** The page's projects, heading Storage's (#578). */
  readonly projects: readonly EnsoProject[]
  /** The stored listing: Storage names each tree's thread by it. */
  readonly stored: readonly EnsoStoredThread[]
  /** A thread deleted from Storage: the page leaves it, as the header's Delete does. */
  readonly onDeleted: (threadId: string) => void
  /** Open a project's page at its Storage tab (#871), from Storage's group of that project. */
  readonly onOpenProject: (projectId: string) => void
  /** Open the Projects page, from the nav's last link. */
  readonly onOpenProjects: () => void
}

/** The section on screen, as the dialog's tab held it: mounted when shown, so Storage measures as it opens. */
function SectionBody({
  section,
  permissions,
  threadId,
  fetch,
  projects,
  stored,
  onDeleted,
  onOpenProject,
}: SettingsPageProps): React.ReactNode {
  if (section === 'appearance') return <AppearanceFields />
  if (section === 'permissions') return <PermissionsSection editor={permissions} threadId={threadId} fetch={fetch} />
  if (section === 'web-tools') return <WebToolsSection fetch={fetch} stored={stored} onOpenProject={onOpenProject} />
  if (section === 'security') return <SecuritySection fetch={fetch} />
  return (
    <TreesSection
      fetch={fetch}
      projects={projects}
      stored={stored}
      onDeleted={onDeleted}
      onOpenProject={onOpenProject}
    />
  )
}

/**
 * Where a section is kept, beside its title (the prototype's pill): this browser for Appearance, the
 * server's file for Permissions — its real path once read — for Security (`config.json`, by name:
 * the section reads its file itself, so its real path is beside each field) and for Web tools, and
 * Storage measured on the server.
 */
function savedWhere(section: SettingsSection, permissions: PolicyEditor): string {
  if (section === 'appearance') return 'Saved in this browser'
  if (section === 'storage') return 'Measured on the server when you open this'
  if (section === 'web-tools') return 'Saved on the server · ENSO_HOME/config.json'
  if (section === 'security') return 'Saved on the server · config.json'
  const { state } = permissions
  return state.kind === 'loaded' ? `Saved on the server · ${state.policy.path}` : 'Saved on the server'
}

export function SettingsPage(props: SettingsPageProps): React.ReactNode {
  const { section, onSection, onOpenProjects, permissions } = props
  return (
    <div className="mx-auto flex w-full max-w-settings flex-col gap-4 px-4 pt-4 pb-12 md:flex-row md:items-start md:gap-6 md:px-6 md:pt-6 md:pb-16 lg:gap-8">
      <SectionNav section={section} onSection={onSection} onOpenProjects={onOpenProjects} />
      <section aria-labelledby="settings-section-heading" className="grid min-w-0 flex-1 content-start gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="settings-section-heading" className="font-heading text-xl leading-tight font-semibold">
            {SECTION_LINKS[section].label}
          </h2>
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-meta text-muted-foreground">
            <CheckIcon aria-hidden="true" className="size-2.5 shrink-0" />
            <span className="truncate">{savedWhere(section, permissions)}</span>
          </span>
        </div>
        <SectionBody {...props} />
      </section>
    </div>
  )
}
