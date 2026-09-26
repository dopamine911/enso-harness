import { Settings2Icon } from 'lucide-react'
import { useState } from 'react'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'
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
import { applyTheme, isThemeId, pageStorage, readSavedTheme, saveTheme, THEME_FAMILIES, type ThemeId } from './theme.ts'

/**
 * The page's settings (the header's gear): its colour theme, and a font per role (#407). A choice
 * applies at once and is kept in this browser (`theme.ts`, `fonts.ts`). Each option draws itself —
 * a theme's swatch wears `data-theme`, so its colours are that theme's variables, and a font's
 * name is set in that font — so nothing here restates a value the page already holds.
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

export function SettingsDialog(): React.ReactNode {
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
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="settings" title="settings — the colour theme and fonts">
          <Settings2Icon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>kept in this browser</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  )
}
