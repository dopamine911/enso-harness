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
import { applyTheme, isThemeId, readSavedTheme, saveTheme, type ThemeId, themesByFamily } from './theme.ts'

/**
 * The page's settings (the header's gear): today its colour theme. A choice applies at once and
 * is kept in this browser (`theme.ts`). Each option draws its own theme — the swatch wears
 * `data-theme`, so its colours are that theme's variables, not values written here.
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

export function SettingsDialog(): React.ReactNode {
  const [theme, setTheme] = useState<ThemeId>(() => readSavedTheme(localStorage))
  const choose = (value: string): void => {
    if (!isThemeId(value)) return
    setTheme(value)
    applyTheme(value, document.documentElement)
    saveTheme(value, localStorage)
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="settings" title="settings — the colour theme">
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
                {themesByFamily().map(({ family, themes }) => (
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
        </FieldGroup>
      </DialogContent>
    </Dialog>
  )
}
