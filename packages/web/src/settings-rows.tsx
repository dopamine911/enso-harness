import { TriangleAlertIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { FieldError } from './components/ui/field.tsx'
import { cn } from './lib/utils.ts'
import { PAGE_BUTTON, PAGE_OUTLINE_BUTTON, SAVE_BAR } from './page-styles.ts'
import type { Unavailable } from './permissions-connection.ts'
import type { SettingsFileRead } from './settings-file-connection.ts'

/**
 * What Settings' `config.json` sections draw alike (Security #933, Projects & threads #934): a key's
 * row and where it stands in its file, the one Save for the file, and what a read or save that
 * failed says.
 */

/** Where a key lives — `file` is its real path, as the server read it — and whether it is set there. */
export function SourceLine(props: {
  readonly id?: string
  readonly file: string
  readonly keyPath: string
  readonly set: boolean
  readonly defaultText: string
  readonly unsaved: boolean
}): React.ReactNode {
  return (
    <p id={props.id} className="text-xs break-words text-muted-foreground">
      <span className="font-mono text-meta text-foreground">{props.file}</span> ›{' '}
      <span className="font-mono text-meta text-foreground">{props.keyPath}</span> ·{' '}
      {props.set ? 'set in the file' : `not in the file — the default is ${props.defaultText}`}
      {props.unsaved ? (
        <>
          {' '}
          · <span className="font-semibold text-chart-3">unsaved</span>
        </>
      ) : null}
    </p>
  )
}

/**
 * One key's row: its words and where it lives on the left, its control on the right — or under
 * them when `stacked`. `id` is the control's; a control with no id to point a `<label>` at (a
 * switch, a list of selects) is `labelled`, and names itself by `${id}-label`.
 */
export function SettingRow({
  id,
  label,
  help,
  source,
  problem,
  stacked = false,
  labelled = false,
  children,
}: {
  id: string
  label: string
  help: React.ReactNode
  source: React.ReactNode
  problem?: string | undefined
  stacked?: boolean
  labelled?: boolean
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div
      className={cn(
        'grid items-start gap-x-6 gap-y-2 p-4 [&+&]:border-t',
        stacked ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-setting-row',
      )}
    >
      <div className="grid min-w-0 gap-1">
        {labelled ? (
          <span id={`${id}-label`} className="text-sm font-semibold">
            {label}
          </span>
        ) : (
          <label id={`${id}-label`} htmlFor={id} className="text-sm font-semibold">
            {label}
          </label>
        )}
        <p id={`${id}-help`} className="max-w-reading text-detail text-muted-foreground">
          {help}
        </p>
        {source}
      </div>
      <div className={cn('grid min-w-0 gap-2', stacked ? 'justify-items-stretch' : 'md:justify-items-end')}>
        {children}
        {problem === undefined ? null : (
          <FieldError id={`${id}-error`} className="justify-self-stretch">
            {problem}
          </FieldError>
        )}
      </div>
    </div>
  )
}

/** Discard and the one Save for the file, and what is unsaved: pinned while there is something to save. */
export function SaveBar(props: {
  readonly dirtyLabels: readonly string[]
  readonly path: string
  readonly disabled: boolean
  readonly onDiscard: () => void
  readonly onSave: () => void
}): React.ReactNode {
  const { dirtyLabels, path, disabled, onDiscard, onSave } = props
  const dirty = dirtyLabels.length > 0
  return (
    <div
      role="region"
      aria-label="unsaved settings"
      className={dirty ? SAVE_BAR : 'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3'}
    >
      <span className="min-w-50 flex-1 text-sm">
        <strong className="block">
          {dirty ? `${dirtyLabels.length} unsaved ${dirtyLabels.length === 1 ? 'change' : 'changes'}` : 'saved'}
        </strong>
        <span className="font-mono text-meta break-words text-muted-foreground">
          {dirty ? `${dirtyLabels.join(' · ')} → ` : 'Saves to '}
          {path}
        </span>
      </span>
      <Button variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={!dirty || disabled} onClick={onDiscard}>
        Discard
      </Button>
      <Button className={PAGE_BUTTON} disabled={!dirty || disabled} onClick={onSave}>
        Save
      </Button>
    </div>
  )
}

/** A save refused with 412: the file changed on disk since it was read, and nothing was written. */
export function ConflictNotice({
  detail,
  working,
  onReload,
}: {
  detail: string
  working: boolean
  onReload: () => void
}): React.ReactNode {
  return (
    <div
      role="alert"
      aria-label="changed on disk"
      className="grid gap-3 rounded-sm border border-chart-3 bg-card p-4 text-sm"
    >
      <p>
        config.json changed on disk since it was read ({detail}). Nothing was written. Reload to see the file as it is
        now; your changes here are dropped.
      </p>
      <Button
        variant="outline"
        className={cn(PAGE_OUTLINE_BUTTON, 'justify-self-start')}
        disabled={working}
        onClick={onReload}
      >
        Reload from disk
      </Button>
    </div>
  )
}

/** A read that failed, or a `config.json` that cannot be read: said, with a way to read again. */
function SettingsAlert(props: {
  readonly label: string
  readonly title: string
  readonly action: string
  readonly onReload: () => void
  readonly children: React.ReactNode
}): React.ReactNode {
  return (
    <Alert variant="destructive" aria-label={props.label}>
      <TriangleAlertIcon />
      <AlertTitle>{props.title}</AlertTitle>
      <AlertDescription>{props.children}</AlertDescription>
      <Button variant="outline" className={cn(PAGE_OUTLINE_BUTTON, 'mt-2 justify-self-start')} onClick={props.onReload}>
        {props.action}
      </Button>
    </Alert>
  )
}

/** What a section's file read holds: its path and `ETag`, and — when unreadable — why. */
type FileRead = {
  readonly kind: 'ok' | 'unreadable'
  readonly path: string
  readonly etag?: string
  readonly reason?: string
}

/** The read is of a readable file: the narrowing a generic `kind` check cannot give. */
function readable<Read extends FileRead>(settings: Read): settings is Extract<Read, { kind: 'ok' }> {
  return settings.kind === 'ok'
}

/**
 * A section over the user's `config.json`: read when it opens, its failure said with Try again, an
 * unreadable file said with what that costs (`consequence`), else its form. A new version of the
 * file (a save, a reload after a conflict) is the form's new baseline: it is remounted on it.
 */
export function SettingsFileSection<Read extends FileRead>(props: {
  readonly fetchImpl: FetchLike | undefined
  readonly read: (fetchImpl: FetchLike | undefined) => Promise<SettingsFileRead<Read>>
  /** The section's name in a failed read's title. */
  readonly name: string
  readonly intro: string
  readonly consequence: string
  readonly form: (
    settings: Extract<Read, { kind: 'ok' }>,
    replace: (settings: Read) => void,
    reload: () => void,
  ) => React.ReactNode
}): React.ReactNode {
  const { fetchImpl, read } = props
  const [load, setLoad] = useState<SettingsFileRead<Read> | undefined>(undefined)
  const reload = useCallback(() => void read(fetchImpl).then(setLoad), [fetchImpl, read])
  useEffect(reload, [reload])
  if (load === undefined) return <p className="text-sm text-muted-foreground">reading config.json…</p>
  if (load.kind === 'unavailable') {
    return (
      <SettingsAlert
        label={`${props.name} settings unavailable`}
        title={`${props.name} settings could not be read`}
        action="Try again"
        onReload={reload}
      >
        {load.detail}
      </SettingsAlert>
    )
  }
  const { settings } = load
  const replace = (next: Read): void => setLoad({ kind: 'loaded', settings: next })
  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-reading text-muted-foreground">{props.intro}</p>
      {readable(settings) ? (
        <div key={settings.etag ?? 'no file'} className="contents">
          {props.form(settings, replace, reload)}
        </div>
      ) : (
        <SettingsAlert label="unreadable config" title="config.json cannot be read" action="Reload" onReload={reload}>
          {props.consequence} {settings.reason}. Fix {settings.path} by hand, then reload.
        </SettingsAlert>
      )}
    </div>
  )
}

/**
 * One control's own save (a key, a trust default) beside the file's: whether it is working, what
 * went wrong, and `send`, which says a failure as "Not saved" in the server's words.
 */
export function useSending(): {
  readonly working: boolean
  readonly problem: string | undefined
  readonly send: <Saved extends { readonly kind: 'saved' }>(
    sent: Promise<Saved | Unavailable>,
    onSaved: (saved: Saved) => void,
  ) => void
} {
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const send = <Saved extends { readonly kind: 'saved' }>(
    sent: Promise<Saved | Unavailable>,
    onSaved: (saved: Saved) => void,
  ): void => {
    setWorking(true)
    setProblem(undefined)
    void sent.then((saved) => {
      setWorking(false)
      if (saved.kind === 'unavailable') setProblem(`Not saved: ${saved.detail}`)
      else onSaved(saved)
    })
  }
  return { working, problem, send }
}
