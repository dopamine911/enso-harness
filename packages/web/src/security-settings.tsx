import {
  DEFAULT_RISK_THRESHOLDS,
  ENSO_JUDGE_KEY_NAME,
  type EnsoJudgeBackend,
  type EnsoRiskThresholds,
  type EnsoSecurityConfig,
  type EnsoSecuritySettingsRead,
  incidentPolicyOf,
  localJudgeUrlProblem,
} from '@enso/core'
import { LockIcon, TriangleAlertIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { FieldError } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { cn } from './lib/utils.ts'
import { OptionSelect } from './option-select.tsx'
import { PAGE_BUTTON, PAGE_INPUT, PAGE_OUTLINE_BUTTON, SAVE_BAR, SUB_TITLE } from './page-styles.ts'
import { fetchSecuritySettings, saveJudgeKey, saveSecuritySettings } from './security-connection.ts'

/**
 * Settings › Security (#933): `config.json`'s user-only `security` section — whether an incident
 * halts, the risk thresholds, the command judge — one control per key, each named by its file, key
 * and default and checked when you leave it, with one Save for the file. A save that finds a problem
 * saves nothing and lists what to fix; one that loosens a protection says so plainly first. The
 * judge's key goes to `secrets.env` on its own, and the page only ever learns whether it is set.
 * There is no project form of any of it: a project's `security` is dropped (`session-config.ts`).
 */

const PAGE_NOTE = 'text-sm text-muted-foreground'
const WHOLE_NUMBER = /^\d+$/
const HTTP_URL = /^https?:\/\/\S+$/

type Threshold = keyof EnsoRiskThresholds

/** Each threshold's words: the label, what it changes, its unit, and which way loosens it. */
const THRESHOLDS: ReadonlyArray<{
  readonly key: Threshold
  readonly label: string
  readonly help: string
  readonly unit: string
  /** `fewer`: a smaller number counts less; `more`: a larger one needs more before it acts. */
  readonly looserWhen: 'fewer' | 'more'
}> = [
  {
    key: 'windowCalls',
    label: 'Calls in the risk window',
    help: 'How many recent tool calls the risk score looks back over.',
    unit: 'calls',
    looserWhen: 'fewer',
  },
  {
    key: 'highAtSignals',
    label: 'Signals for high risk',
    help: 'Risk signals in the window that make the thread’s risk high.',
    unit: 'signals',
    looserWhen: 'more',
  },
  {
    key: 'highAtKinds',
    label: 'Kinds of signal for high risk',
    help: 'Different kinds of signal in the window that make the risk high, however few of each.',
    unit: 'kinds',
    looserWhen: 'more',
  },
  {
    key: 'incidentAtSignals',
    label: 'Signals for an incident',
    help: 'Risk signals in the window that open an incident.',
    unit: 'signals',
    looserWhen: 'more',
  },
]

const BACKEND_WORDS: Readonly<Record<EnsoJudgeBackend, string>> = {
  off: 'Off',
  jev: 'Jev (TypeSafe)',
  local: 'Local model server',
}

/** The page's form of the section: every value as typed, `''`/`null` meaning "not in the file". */
interface Draft {
  readonly halt: boolean | null
  readonly thresholds: Readonly<Record<Threshold, string>>
  readonly backend: EnsoJudgeBackend | ''
  readonly baseUrl: string
  readonly model: string
}

type FieldName = 'halt' | Threshold | 'backend' | 'baseUrl' | 'model'

const FIELD_LABELS: Readonly<Record<FieldName, string>> = {
  halt: 'Stop tools when an incident opens',
  windowCalls: 'Calls in the risk window',
  highAtSignals: 'Signals for high risk',
  highAtKinds: 'Kinds of signal for high risk',
  incidentAtSignals: 'Signals for an incident',
  backend: 'Command judge',
  baseUrl: 'Local judge address',
  model: 'Local judge model',
}

const fieldId = (field: FieldName): string => `security-${field}`

function draftOf(security: EnsoSecurityConfig): Draft {
  const incidents = security.incidents ?? {}
  const judge = security.judge ?? {}
  return {
    halt: incidents.halt ?? null,
    thresholds: {
      windowCalls: incidents.windowCalls?.toString() ?? '',
      highAtSignals: incidents.highAtSignals?.toString() ?? '',
      highAtKinds: incidents.highAtKinds?.toString() ?? '',
      incidentAtSignals: incidents.incidentAtSignals?.toString() ?? '',
    },
    backend: judge.backend ?? '',
    baseUrl: judge.local?.baseUrl ?? '',
    model: judge.local?.model ?? '',
  }
}

/** What is wrong with a local judge's address or model as typed; nothing unless the judge is local. */
function localJudgeProblem(draft: Draft, field: 'baseUrl' | 'model'): string | undefined {
  if (draft.backend !== 'local') return undefined
  const value = draft[field].trim()
  const what = field === 'baseUrl' ? 'address' : 'model name'
  if (value === '') return `The local judge needs its ${what}. Fill it in, or set the judge to off.`
  if (field === 'baseUrl' && !HTTP_URL.test(value)) return 'Start the address with http:// or https://.'
  if (field === 'baseUrl' && localJudgeUrlProblem(value) !== undefined) {
    return 'The local judge only talks to this machine: use 127.0.0.1, [::1] or localhost.'
  }
  return undefined
}

/** What is wrong with one field as it stands, or `undefined`. */
function problemOf(draft: Draft, field: FieldName): string | undefined {
  if (field === 'halt' || field === 'backend') return undefined
  if (field === 'baseUrl' || field === 'model') return localJudgeProblem(draft, field)
  const value = draft.thresholds[field].trim()
  if (value === '' || (WHOLE_NUMBER.test(value) && Number(value) >= 1)) return undefined
  return 'Use a whole number, 1 or more — or remove it from the file to use the default.'
}

const ALL_FIELDS: readonly FieldName[] = [
  'halt',
  'windowCalls',
  'highAtSignals',
  'highAtKinds',
  'incidentAtSignals',
  'backend',
  'baseUrl',
  'model',
]

/**
 * The section as the file will hold it. A local judge's address and model are written only while
 * the judge is local: they mean nothing otherwise, and leaving them would surprise the next reader.
 */
function securityOf(draft: Draft): EnsoSecurityConfig {
  const incidents: NonNullable<EnsoSecurityConfig['incidents']> = {
    ...(draft.halt === null ? {} : { halt: draft.halt }),
    ...Object.fromEntries(
      THRESHOLDS.flatMap(({ key }) => {
        const value = draft.thresholds[key].trim()
        return value === '' ? [] : [[key, Number(value)]]
      }),
    ),
  }
  const judge: NonNullable<EnsoSecurityConfig['judge']> = {
    ...(draft.backend === '' ? {} : { backend: draft.backend }),
    ...(draft.backend === 'local' ? { local: { baseUrl: draft.baseUrl.trim(), model: draft.model.trim() } } : {}),
  }
  return {
    ...(Object.keys(incidents).length === 0 ? {} : { incidents }),
    ...(Object.keys(judge).length === 0 ? {} : { judge }),
  }
}

/** The values in force for a section: the incident policy the guard reads, and the judge's backend. */
function effectiveOf(security: EnsoSecurityConfig): {
  halt: boolean
  thresholds: EnsoRiskThresholds
  backend: EnsoJudgeBackend
} {
  return { ...incidentPolicyOf(security), backend: security.judge?.backend ?? 'off' }
}

/** Every way `next` protects less than `saved`, said plainly — what the reader confirms before Save. */
export function looseningsOf(saved: EnsoSecurityConfig, next: EnsoSecurityConfig): readonly string[] {
  const before = effectiveOf(saved)
  const after = effectiveOf(next)
  const said: string[] = []
  if (before.halt && !after.halt) {
    said.push('Halting goes off: an incident will no longer suspend tools — it is only an alert.')
  }
  for (const { key, label, unit, looserWhen } of THRESHOLDS) {
    const was = before.thresholds[key]
    const will = after.thresholds[key]
    const looser = looserWhen === 'fewer' ? will < was : will > was
    if (!looser) continue
    said.push(
      looserWhen === 'fewer'
        ? `${label}: ${was} → ${will} ${unit}. Fewer calls are counted together, so risk is reached less often.`
        : `${label}: ${was} → ${will} ${unit}. More is needed before it acts, so it acts less often.`,
    )
  }
  if (before.backend !== 'off' && after.backend === 'off') {
    said.push('The command judge goes off: commands will no longer get a second opinion.')
  }
  return said
}

/** Said before a save that newly chooses Jev while no key is stored: such a judge judges nothing. */
const JEV_WITHOUT_KEY = 'The judge is Jev, but no TypeSafe key is stored: every command goes unjudged.'

type SaveProblem =
  | { readonly kind: 'fields'; readonly fields: ReadonlyArray<readonly [FieldName, string]> }
  | { readonly kind: 'conflict'; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly detail: string }

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'loaded'; readonly settings: EnsoSecuritySettingsRead }

/** Where a key lives — `file` is its real path, as the server read it — and whether it is set there. */
interface KeySource {
  readonly id: string
  readonly file: string
  readonly keyPath: string
  readonly set: boolean
  readonly defaultText: string
  readonly unsaved: boolean
}

/** Where a key stands in the file: set, or not there and its default is in force. */
function SourceLine({ id, file, keyPath, set, defaultText, unsaved }: KeySource): React.ReactNode {
  return (
    <p id={id} className="text-xs break-words text-muted-foreground">
      <span className="font-mono text-meta text-foreground">{file}</span> ›{' '}
      <span className="font-mono text-meta text-foreground">{keyPath}</span> ·{' '}
      {set ? 'set in the file' : `not in the file — the default is ${defaultText}`}
      {unsaved ? (
        <>
          {' '}
          · <span className="font-semibold text-chart-3">unsaved</span>
        </>
      ) : null}
    </p>
  )
}

/** One key's row: its words and where it lives on the left, its control on the right. */
function SettingRow({
  field,
  help,
  source,
  problem,
  stacked = false,
  labelled,
  children,
}: {
  field: FieldName
  help: string
  source: React.ReactNode
  problem: string | undefined
  stacked?: boolean
  /** A control with no id to point a `<label>` at (the switch) names itself by the label's id. */
  labelled?: boolean
  children: React.ReactNode
}): React.ReactNode {
  const id = fieldId(field)
  return (
    <div
      className={cn(
        'grid items-start gap-x-6 gap-y-2 p-4 [&+&]:border-t',
        stacked ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-setting-row',
      )}
    >
      <div className="grid min-w-0 gap-1">
        {labelled === true ? (
          <span id={`${id}-label`} className="text-sm font-semibold">
            {FIELD_LABELS[field]}
          </span>
        ) : (
          <label id={`${id}-label`} htmlFor={id} className="text-sm font-semibold">
            {FIELD_LABELS[field]}
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

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      {label}
    </button>
  )
}

function HaltSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }): React.ReactNode {
  const id = fieldId('halt')
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-help ${id}-source`}
      onClick={onToggle}
      className="group relative h-6 w-10 shrink-0 rounded-full bg-border-strong transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-checked:bg-primary"
    >
      <span
        aria-hidden="true"
        className="absolute top-0.75 left-0.75 size-4.5 rounded-full bg-foreground transition-transform group-aria-checked:translate-x-4 group-aria-checked:bg-primary-foreground"
      />
    </button>
  )
}

/** The judge's key: whether it is set, and a way to store or remove it. The value never comes back. */
function JudgeKey({
  set,
  secretsPath,
  fetchImpl,
  onSet,
}: {
  set: boolean
  secretsPath: string
  fetchImpl: FetchLike | undefined
  onSet: (set: boolean) => void
}): React.ReactNode {
  const id = useId()
  const [value, setValue] = useState('')
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const store = (next: string | null): void => {
    setWorking(true)
    setProblem(undefined)
    void saveJudgeKey({ value: next }, fetchImpl).then((saved) => {
      setWorking(false)
      if (saved.kind === 'unavailable') {
        setProblem(`Not saved: ${saved.detail}`)
        return
      }
      setValue('')
      onSet(saved.judgeKeySet)
    })
  }
  return (
    <div className="grid grid-cols-1 items-start gap-x-6 gap-y-2 p-4 [&+&]:border-t">
      <div className="grid min-w-0 gap-1">
        <label htmlFor={id} className="text-sm font-semibold">
          TypeSafe API key
        </label>
        <p className="max-w-reading text-detail text-muted-foreground">
          Jev needs it. Stored on its own line in the secrets file — Enso never shows its value, here or anywhere. Read
          at the judge’s next call.
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono text-meta text-foreground">{secretsPath}</span> ›{' '}
          <span className="font-mono text-meta text-foreground">{ENSO_JUDGE_KEY_NAME}</span> ·{' '}
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-px align-middle">
            <LockIcon aria-hidden="true" className="size-3" />
            {set ? 'set' : 'not set'}
          </span>
        </p>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (value.trim() !== '') store(value.trim())
        }}
      >
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={set ? 'a new key replaces the one set' : 'paste the key'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className={cn(PAGE_INPUT, 'max-w-90 flex-1 font-mono')}
        />
        <Button type="submit" className={PAGE_BUTTON} disabled={working || value.trim() === ''}>
          {set ? 'Replace key' : 'Store key'}
        </Button>
        {set ? (
          <Button
            type="button"
            variant="outline"
            className={PAGE_OUTLINE_BUTTON}
            disabled={working}
            onClick={() => store(null)}
          >
            Remove key
          </Button>
        ) : null}
      </form>
      {problem === undefined ? null : <FieldError>{problem}</FieldError>}
    </div>
  )
}

/** The section's read, reloadable. */
function useSecuritySettings(fetchImpl: FetchLike | undefined): {
  load: Load
  reload: () => void
  replace: (settings: EnsoSecuritySettingsRead) => void
} {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const reload = useCallback(() => {
    void fetchSecuritySettings(fetchImpl).then((read) =>
      setLoad(read.kind === 'loaded' ? { kind: 'loaded', settings: read.settings } : read),
    )
  }, [fetchImpl])
  useEffect(reload, [reload])
  return { load, reload, replace: (settings) => setLoad({ kind: 'loaded', settings }) }
}

function focusField(field: FieldName): void {
  const element = document.getElementById(fieldId(field))
  element?.scrollIntoView({ block: 'center' })
  element?.focus()
}

/** The summary a failed save leaves: nothing was saved, and each field to fix, a link to it. */
function SaveProblemNotice({
  problem,
  working,
  onReload,
}: {
  problem: SaveProblem
  working: boolean
  onReload: () => void
}): React.ReactNode {
  if (problem.kind === 'fields') {
    return (
      <div
        role="alert"
        aria-label="nothing was saved"
        className="grid gap-2 rounded-sm border border-refuse bg-card p-4 text-sm"
      >
        <p className="flex items-center gap-2 font-semibold text-refuse">
          <TriangleAlertIcon aria-hidden="true" className="size-4" />
          Nothing was saved —{' '}
          {problem.fields.length === 1 ? 'one setting needs' : `${problem.fields.length} settings need`} fixing
        </p>
        <ul className="grid list-disc gap-1 pl-6">
          {problem.fields.map(([field, words]) => (
            <li key={field}>
              <button type="button" className="underline underline-offset-2" onClick={() => focusField(field)}>
                {FIELD_LABELS[field]}
              </button>
              : {words}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (problem.kind === 'conflict') {
    return (
      <div
        role="alert"
        aria-label="changed on disk"
        className="grid gap-3 rounded-sm border border-chart-3 bg-card p-4 text-sm"
      >
        <p>
          config.json changed on disk since it was read ({problem.detail}). Nothing was written. Reload to see the file
          as it is now; your changes here are dropped.
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
  return <FieldError>Not saved: {problem.detail}</FieldError>
}

/**
 * What a save would loosen, said before it happens: Save anyway, or go back. Shown only when
 * something protects less than what the file holds now.
 */
function LooseningConfirm({
  loosenings,
  working,
  onConfirm,
  onCancel,
}: {
  loosenings: readonly string[]
  working: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <div
      role="alert"
      aria-label="this loosens security"
      className="grid gap-3 rounded-sm border border-refuse bg-card p-4 text-sm"
    >
      <p className="flex items-center gap-2 font-semibold text-refuse">
        <TriangleAlertIcon aria-hidden="true" className="size-4" />
        This save protects less than what is in force now
      </p>
      <ul className="grid list-disc gap-1 pl-6">
        {loosenings.map((said) => (
          <li key={said}>{said}</li>
        ))}
      </ul>
      <span className="flex flex-wrap gap-2">
        <Button variant="destructive" className={PAGE_BUTTON} disabled={working} onClick={onConfirm}>
          Save anyway
        </Button>
        <Button variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={working} onClick={onCancel}>
          Go back
        </Button>
      </span>
    </div>
  )
}

/** The form over a readable file. */
function SecurityForm({
  settings,
  fetchImpl,
  onSaved,
  onReload,
  onKeySet,
}: {
  settings: Extract<EnsoSecuritySettingsRead, { kind: 'ok' }>
  fetchImpl: FetchLike | undefined
  onSaved: (settings: EnsoSecuritySettingsRead) => void
  onReload: () => void
  onKeySet: (set: boolean) => void
}): React.ReactNode {
  const saved = draftOf(settings.security)
  const [draft, setDraft] = useState<Draft>(saved)
  const [checked, setChecked] = useState<ReadonlySet<FieldName>>(new Set())
  const [problem, setProblem] = useState<SaveProblem | undefined>(undefined)
  // What Save anyway writes is the section the reader was shown the loosenings of; an edit closes
  // the confirm, so its list is never stale (#969 review).
  const [confirming, setConfirming] = useState<
    { readonly loosenings: readonly string[]; readonly security: EnsoSecurityConfig } | undefined
  >(undefined)
  const [working, setWorking] = useState(false)
  const next = securityOf(draft)
  const dirty = JSON.stringify(next) !== JSON.stringify(securityOf(saved))
  // A `judge.local` the file keeps while the judge is not local is not in the draft; the next save
  // drops it, so the unsaved list names it.
  const dropsLocal = settings.security.judge?.local !== undefined && next.judge?.local === undefined
  const write = (security: EnsoSecurityConfig): void => {
    setWorking(true)
    void saveSecuritySettings({ security }, settings.etag, fetchImpl).then((outcome) => {
      setWorking(false)
      setConfirming(undefined)
      if (outcome.kind === 'saved') {
        setProblem(undefined)
        onSaved(outcome.settings)
        return
      }
      setProblem(outcome)
    })
  }
  const save = (): void => {
    const fields = ALL_FIELDS.flatMap((field) => {
      const found = problemOf(draft, field)
      return found === undefined ? [] : [[field, found] as const]
    })
    if (fields.length > 0) {
      setChecked(new Set(ALL_FIELDS))
      setProblem({ kind: 'fields', fields })
      return
    }
    setProblem(undefined)
    const jevWithoutKey =
      next.judge?.backend === 'jev' && settings.security.judge?.backend !== 'jev' && !settings.judgeKeySet
    const loosenings = [...looseningsOf(settings.security, next), ...(jevWithoutKey ? [JEV_WITHOUT_KEY] : [])]
    if (loosenings.length > 0) {
      setConfirming({ loosenings, security: next })
      return
    }
    write(next)
  }
  const discard = (): void => {
    setDraft(saved)
    setChecked(new Set())
    setProblem(undefined)
    setConfirming(undefined)
  }
  const unsaved = (field: FieldName): boolean =>
    unsavedField(draft, saved, field) || (dropsLocal && (field === 'baseUrl' || field === 'model'))
  const dirtyKeys = ALL_FIELDS.filter(unsaved)
  const fields: GroupFields = {
    draft,
    setDraft: (changed) => {
      setDraft(changed)
      setConfirming(undefined)
    },
    path: settings.path,
    unsaved,
    shownProblem: (field) => (checked.has(field) ? problemOf(draft, field) : undefined),
    leave: (field) => setChecked((current) => new Set(current).add(field)),
  }
  return (
    <>
      {problem === undefined ? null : <SaveProblemNotice problem={problem} working={working} onReload={onReload} />}
      <IncidentRows {...fields} />
      <JudgeRows {...fields}>
        {draft.backend === 'jev' || settings.judgeKeySet ? (
          <JudgeKey
            set={settings.judgeKeySet}
            secretsPath={settings.secretsPath}
            fetchImpl={fetchImpl}
            onSet={onKeySet}
          />
        ) : null}
      </JudgeRows>
      {confirming === undefined ? null : (
        <LooseningConfirm
          loosenings={confirming.loosenings}
          working={working}
          onConfirm={() => write(confirming.security)}
          onCancel={() => setConfirming(undefined)}
        />
      )}
      <SaveBar
        dirtyKeys={dirty ? dirtyKeys : []}
        path={settings.path}
        disabled={working || confirming !== undefined}
        onDiscard={discard}
        onSave={save}
      />
    </>
  )
}

function unsavedField(draft: Draft, saved: Draft, field: FieldName): boolean {
  if (field === 'halt') return draft.halt !== saved.halt
  if (field === 'backend' || field === 'baseUrl' || field === 'model') return draft[field] !== saved[field]
  return draft.thresholds[field] !== saved.thresholds[field]
}

/** What a group of rows needs from the form: the draft, where it is saved, and each field's state. */
interface GroupFields {
  readonly draft: Draft
  readonly setDraft: (draft: Draft) => void
  readonly path: string
  readonly unsaved: (field: FieldName) => boolean
  readonly shownProblem: (field: FieldName) => string | undefined
  readonly leave: (field: FieldName) => void
}

function IncidentRows({ draft, setDraft, path, unsaved, shownProblem, leave }: GroupFields): React.ReactNode {
  const halt = draft.halt ?? false
  return (
    <div className="grid gap-3">
      <h3 className={SUB_TITLE}>Incidents</h3>
      <p className={PAGE_NOTE}>
        Applies from the next session: a running thread keeps what it started with. The page’s replayed risk uses the
        thresholds from the server’s next start.
      </p>
      <div className="rounded-lg border bg-card">
        <SettingRow
          field="halt"
          labelled
          help="Off, an incident is recorded and shown to you while pi carries on. On, pi’s tools are suspended until you look."
          source={
            <SourceLine
              file={path}
              id={`${fieldId('halt')}-source`}
              keyPath="security.incidents.halt"
              set={draft.halt !== null}
              defaultText="off"
              unsaved={unsaved('halt')}
            />
          }
          problem={undefined}
        >
          <HaltSwitch on={halt} onToggle={() => setDraft({ ...draft, halt: !halt })} />
          {draft.halt === false ? (
            <RemoveButton
              label="Remove from the file — same as the default"
              onClick={() => setDraft({ ...draft, halt: null })}
            />
          ) : null}
        </SettingRow>
        {THRESHOLDS.map(({ key, help, unit }) => {
          const id = fieldId(key)
          const shown = shownProblem(key)
          const value = draft.thresholds[key]
          const setValue = (next: string): void =>
            setDraft({ ...draft, thresholds: { ...draft.thresholds, [key]: next } })
          return (
            <SettingRow
              key={key}
              field={key}
              help={help}
              source={
                <SourceLine
                  file={path}
                  id={`${id}-source`}
                  keyPath={`security.incidents.${key}`}
                  set={value.trim() !== ''}
                  defaultText={String(DEFAULT_RISK_THRESHOLDS[key])}
                  unsaved={unsaved(key)}
                />
              }
              problem={shown}
            >
              <span className="flex items-center gap-2">
                <Input
                  id={id}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-invalid={shown !== undefined}
                  aria-describedby={`${id}-help ${id}-source${shown === undefined ? '' : ` ${id}-error`}`}
                  placeholder={String(DEFAULT_RISK_THRESHOLDS[key])}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  onBlur={() => leave(key)}
                  className={cn(PAGE_INPUT, 'w-30 text-right font-mono')}
                />
                <span className="text-sm whitespace-nowrap text-muted-foreground">{unit}</span>
              </span>
              {value.trim() === '' ? null : (
                <RemoveButton label="Remove from the file — use the default" onClick={() => setValue('')} />
              )}
            </SettingRow>
          )
        })}
      </div>
    </div>
  )
}

function JudgeRows({
  draft,
  setDraft,
  path,
  unsaved,
  shownProblem,
  leave,
  children,
}: GroupFields & { readonly children: React.ReactNode }): React.ReactNode {
  return (
    <div className="grid gap-3">
      <h3 className={SUB_TITLE}>Command judge</h3>
      <p className={PAGE_NOTE}>Applies from the next session. The key is read at the judge’s next call.</p>
      <div className="rounded-lg border bg-card">
        <SettingRow
          field="backend"
          help="A second opinion on commands pi wants to run. Jev is TypeSafe’s hosted judge; local is your own llama.cpp router on this machine. A local judge’s address and model are kept only while the judge is local."
          source={
            <SourceLine
              file={path}
              id={`${fieldId('backend')}-source`}
              keyPath="security.judge.backend"
              set={draft.backend !== ''}
              defaultText="off"
              unsaved={unsaved('backend')}
            />
          }
          problem={undefined}
        >
          <OptionSelect<EnsoJudgeBackend | ''>
            id={fieldId('backend')}
            value={draft.backend}
            options={[
              ['', 'Default — off'],
              ['off', BACKEND_WORDS.off],
              ['jev', BACKEND_WORDS.jev],
              ['local', BACKEND_WORDS.local],
            ]}
            onChange={(backend) => setDraft({ ...draft, backend })}
            className={PAGE_INPUT}
          />
        </SettingRow>
        {draft.backend === 'local'
          ? (['baseUrl', 'model'] as const).map((field) => {
              const id = fieldId(field)
              const shown = shownProblem(field)
              return (
                <SettingRow
                  key={field}
                  field={field}
                  stacked
                  help={
                    field === 'baseUrl' ? 'Where your llama.cpp router listens.' : 'The model name the router serves.'
                  }
                  source={
                    <SourceLine
                      file={path}
                      id={`${id}-source`}
                      keyPath={`security.judge.local.${field}`}
                      set={draft[field].trim() !== ''}
                      defaultText="none — the local judge stays off without it"
                      unsaved={unsaved(field)}
                    />
                  }
                  problem={shown}
                >
                  <Input
                    id={id}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={shown !== undefined}
                    aria-describedby={`${id}-help ${id}-source${shown === undefined ? '' : ` ${id}-error`}`}
                    placeholder={field === 'baseUrl' ? 'http://127.0.0.1:8080' : 'qwen3-8b'}
                    value={draft[field]}
                    onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                    onBlur={() => leave(field)}
                    className={cn(PAGE_INPUT, 'font-mono')}
                  />
                </SettingRow>
              )
            })
          : null}
        {children}
      </div>
    </div>
  )
}

interface SaveBarProps {
  readonly dirtyKeys: readonly FieldName[]
  readonly path: string
  readonly disabled: boolean
  readonly onDiscard: () => void
  readonly onSave: () => void
}

/** Discard and the one Save for the file, and what is unsaved: pinned while there is something to save. */
function SaveBar({ dirtyKeys, path, disabled, onDiscard, onSave }: SaveBarProps): React.ReactNode {
  const dirty = dirtyKeys.length > 0
  return (
    <div
      role="region"
      aria-label="unsaved settings"
      className={dirty ? SAVE_BAR : 'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3'}
    >
      <span className="min-w-50 flex-1 text-sm">
        <strong className="block">
          {dirty ? `${dirtyKeys.length} unsaved ${dirtyKeys.length === 1 ? 'change' : 'changes'}` : 'saved'}
        </strong>
        <span className="font-mono text-meta break-words text-muted-foreground">
          {dirty ? `${dirtyKeys.map((field) => FIELD_LABELS[field]).join(' · ')} → ` : 'Saves to '}
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

/** Settings' Security section. */
export function SecuritySection({ fetch: fetchImpl }: { fetch: FetchLike | undefined }): React.ReactNode {
  const { load, reload, replace } = useSecuritySettings(fetchImpl)
  if (load.kind === 'loading') return <p className={PAGE_NOTE}>reading config.json…</p>
  if (load.kind === 'unavailable') {
    return (
      <Alert variant="destructive" aria-label="security settings unavailable">
        <TriangleAlertIcon />
        <AlertTitle>Security settings could not be read</AlertTitle>
        <AlertDescription>{load.detail}</AlertDescription>
        <Button variant="outline" className={cn(PAGE_OUTLINE_BUTTON, 'mt-2 justify-self-start')} onClick={reload}>
          Try again
        </Button>
      </Alert>
    )
  }
  const { settings } = load
  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-reading text-muted-foreground">
        When Enso counts a run as risky, and who judges a command. These live in your own file only — a project can’t
        change them.
      </p>
      {settings.kind === 'unreadable' ? (
        <Alert variant="destructive" aria-label="unreadable config">
          <TriangleAlertIcon />
          <AlertTitle>config.json cannot be read</AlertTitle>
          <AlertDescription>
            Everything that reads it fails closed: incidents halt with the default thresholds, the judge is off, and the
            server will not start again until it is fixed. {settings.reason}. Fix {settings.path} by hand, then reload.
          </AlertDescription>
          <Button variant="outline" className={cn(PAGE_OUTLINE_BUTTON, 'mt-2 justify-self-start')} onClick={reload}>
            Reload
          </Button>
        </Alert>
      ) : (
        // A new version of the file (a save, a reload after a conflict) is the new baseline: the form
        // starts again from it. Storing the key keeps the version, so an unsaved draft survives it.
        <SecurityForm
          key={settings.etag ?? 'no file'}
          settings={settings}
          fetchImpl={fetchImpl}
          onSaved={replace}
          onReload={reload}
          onKeySet={(judgeKeySet) => replace({ ...settings, judgeKeySet })}
        />
      )}
    </div>
  )
}
