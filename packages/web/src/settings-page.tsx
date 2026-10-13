import type { EnsoProject, EnsoStoredThread } from '@enso/core'
import { FolderIcon, LayersIcon, LockIcon } from 'lucide-react'
import { useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Field, FieldDescription, FieldGroup, FieldLabel } from './components/ui/field.tsx'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './components/ui/select.tsx'
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
import { PermissionsSection, type PolicyEditor } from './permissions-settings.tsx'
import { applyTheme, isThemeId, pageStorage, readSavedTheme, saveTheme, THEME_FAMILIES, type ThemeId } from './theme.ts'
import { SETTINGS_SECTIONS, type SettingsSection } from './thread-url.ts'
import { TreesSection } from './trees-settings.tsx'

/**
 * Settings, a page (#869; the header's dialog before it), in three sections, each its own route.
 * Appearance: the page's colour theme, and a font per role (#407) — a choice applies at once and is
 * kept in this browser (`theme.ts`, `fonts.ts`). Each option draws itself — a theme's swatch wears
 * `data-theme`, so its colours are that theme's variables, and a font's name is set in that font —
 * so nothing here restates a value the page already holds. Permissions (#474): the rules pi runs
 * under, saved on the server (`permissions-settings.tsx`); its draft is held beneath the page
 * (`routed-page.tsx`), so leaving Settings keeps it. Storage (#578): what each thread tree
 * and snapshot store costs on disk, measured when the section opens, with each tree's Delete
 * (`trees-settings.tsx`).
 */

/** A theme in its own colours: its background, then its primary and three of its chart colours. */
function ThemeSwatch({ theme }: { theme: ThemeId }): React.ReactNode {
  return (
    <span data-theme={theme} aria-hidden="true" className="flex items-center gap-0.5 rounded-sm bg-background p-0.5">
      <span className="size-2.5 rounded-full bg-primary" />
      <span className="size-2.5 rounded-full bg-chart-2" />
      <span className="size-2.5 rounded-full bg-chart-3" />
      <span className="size-2.5 rounded-full bg-chart-4" />
    </span>
  )
}

/**
 * One role's font: the theme's (the default — the role follows every theme switch), the system's,
 * or a family that fits the role, each named in its own face. Opening the list is what downloads
 * those faces; a closed list costs nothing.
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
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={fonts[role]} onValueChange={(value) => onChoose(role, value)}>
        <SelectTrigger id={id} className="w-full">
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
    </Field>
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
  const choose = (value: string): void => {
    if (!isThemeId(value)) return
    setTheme(value)
    applyTheme(value, document.documentElement)
    saveTheme(value, pageStorage())
  }
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="settings-theme">Theme</FieldLabel>
        <Select value={theme} onValueChange={choose}>
          <SelectTrigger id="settings-theme" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_FAMILIES.map(({ family, themes }) => (
              <SelectGroup key={family}>
                <SelectLabel>{family}</SelectLabel>
                {themes.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    <ThemeSwatch theme={option.id} />
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>applies at once, to every thread on this page</FieldDescription>
      </Field>
      {FONT_ROLES.map(({ role, label }) => (
        <FontField key={role} role={role} label={label} fonts={fonts} onChoose={chooseFont} />
      ))}
      <FieldDescription>
        a role set to the theme's font follows the theme; any other choice keeps its font on every theme
      </FieldDescription>
    </FieldGroup>
  )
}

/** Each section's link: its label and icon. */
const SECTION_LINKS: Readonly<Record<SettingsSection, { readonly label: string; readonly icon: React.ReactNode }>> = {
  appearance: { label: 'Appearance', icon: <LayersIcon /> },
  permissions: { label: 'Permissions', icon: <LockIcon /> },
  storage: { label: 'Storage', icon: <FolderIcon /> },
}

/** The sections' links, the one shown marked as the current page: a column, a row on a narrow screen. */
function SectionNav({
  section,
  onSection,
}: {
  section: SettingsSection
  onSection: (section: SettingsSection) => void
}): React.ReactNode {
  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto md:sticky md:top-0 md:w-50 md:shrink-0 md:flex-col"
    >
      {SETTINGS_SECTIONS.map((linked) => (
        <button
          key={linked}
          type="button"
          aria-current={linked === section ? 'page' : undefined}
          onClick={() => onSection(linked)}
          className={cn(
            'flex min-h-10 shrink-0 items-center gap-2 rounded-md px-3 text-left text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-4',
            linked === section
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-popover hover:text-foreground',
          )}
        >
          {SECTION_LINKS[linked].icon}
          {SECTION_LINKS[linked].label}
        </button>
      ))}
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
  if (section === 'appearance')
    return (
      <div className="max-w-sm">
        <AppearanceFields />
      </div>
    )
  if (section === 'permissions') return <PermissionsSection editor={permissions} threadId={threadId} fetch={fetch} />
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

export function SettingsPage(props: SettingsPageProps): React.ReactNode {
  const { section, onSection } = props
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:flex-row md:items-start md:gap-8 md:p-6">
      <SectionNav section={section} onSection={onSection} />
      <section aria-labelledby="settings-section-heading" className="flex min-w-0 flex-1 flex-col gap-4">
        <h2 id="settings-section-heading" className="font-heading text-lg font-semibold">
          {SECTION_LINKS[section].label}
        </h2>
        <SectionBody {...props} />
      </section>
    </div>
  )
}
