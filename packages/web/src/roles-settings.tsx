import {
  ENSO_DEFAULT_ROLE,
  type EnsoModelPreset,
  type EnsoModelRole,
  type EnsoModelsConfig,
  type EnsoModelTarget,
  type EnsoProvidersListing,
  type HostCommandOption,
  MODEL_PRESET_NAME_MAX,
  MODEL_ROLE_NAME_SOURCE,
  resolveModelRole,
  SUGGESTED_MODEL_ROLES,
  THINKING_LEVEL_ORDER,
  unavailableReason,
} from '@enso/core'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { roleNamesInOrder } from './model-picker.tsx'
import { type ModelsSettingsStore, type ModelsUpdate, modelsSettings } from './models-settings.ts'
import { OptionSelect } from './option-select.tsx'
import { PAGE_CARD, PAGE_INPUT, PAGE_OUTLINE_BUTTON, PAGE_PRIMARY_BUTTON, SUB_TITLE } from './page-styles.ts'
import { useProvidersListing } from './providers-settings.tsx'
import { useStore } from './store.ts'

/**
 * Settings' Roles (#904): a role is a name for a model and its effort, with fallbacks in order — the
 * first available runs when the model is not; none available, the role is refused, never quietly
 * replaced. `default` is the role new threads start on. Presets save every role and the default
 * effort under a name; switching to one REPLACES the roles in one save, so a role the preset leaves
 * out is cleared, as in OMP. Every change is one `PUT` of the whole section, applied in turn to the
 * section as the last save left it (`ModelsSettingsStore.save`), so quick edits don't drop each other.
 *
 * Models are offered from `GET /api/providers` (no thread is needed to read them): a provider's
 * listed models, those of a logged-in provider being the ones a role can run. The listing says no
 * model's effort levels, so an effort is shown as set; it is clamped when the role is chosen.
 */

const ROLE_NAME = new RegExp(MODEL_ROLE_NAME_SOURCE)

/** The listing's models as `/model` options, the shape a role is resolved against. */
export function modelOptionsOf(listing: EnsoProvidersListing): HostCommandOption[] {
  return listing.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      label: model.name,
      detail: provider.id,
      providerName: provider.name,
      loggedIn: provider.loggedIn,
    })),
  )
}

/** `target` with `effort` set, or without one when it is `''` (the default). */
function withEffort<T extends { readonly effort?: string }>(target: T, effort: string): T {
  const { effort: _old, ...rest } = target
  return (effort === '' ? rest : { ...rest, effort }) as T
}

/** The section with `roles` set, the key dropped when none is left. */
function withRoles(models: EnsoModelsConfig, roles: Readonly<Record<string, EnsoModelRole>>): EnsoModelsConfig {
  const { roles: _old, ...rest } = models
  return Object.keys(roles).length === 0 ? rest : { ...rest, roles: { ...roles } }
}

/** The section with `presets` set, the key dropped when none is left. */
function withPresets(models: EnsoModelsConfig, presets: Readonly<Record<string, EnsoModelPreset>>): EnsoModelsConfig {
  const { presets: _old, ...rest } = models
  return Object.keys(presets).length === 0 ? rest : { ...rest, presets: { ...presets } }
}

/** `entries` without `key` — a role or a preset deleted. */
function withoutKey<T>(entries: Readonly<Record<string, T>> | undefined, key: string): Record<string, T> {
  const { [key]: _deleted, ...kept } = entries ?? {}
  return kept
}

/** A role with `fallbacks` set, the key dropped when none is left. */
function withFallbacks(role: EnsoModelRole, fallbacks: readonly EnsoModelTarget[]): EnsoModelRole {
  const { fallbacks: _old, ...rest } = role
  return fallbacks.length === 0 ? rest : { ...rest, fallbacks: [...fallbacks] }
}

/**
 * The section switched to `preset`: its roles and default effort replace the current ones wholesale
 * (#904) — a role it leaves out is cleared, a default effort it leaves out is none.
 */
export function switchedToPreset(models: EnsoModelsConfig, preset: EnsoModelPreset): EnsoModelsConfig {
  const { roles: _roles, defaultEffort: _effort, ...rest } = models
  return {
    ...rest,
    roles: { ...preset.roles },
    ...(preset.defaultEffort === undefined ? {} : { defaultEffort: preset.defaultEffort }),
  }
}

const EFFORT_OPTIONS: ReadonlyArray<readonly [string, string]> = THINKING_LEVEL_ORDER.map(
  (level) => [level, level] as const,
)

/** What a role's select is called, and what choosing in it does. */
interface RoleSelect {
  readonly label: string
  readonly onChange: (value: string) => void
}

/** A model to choose: every model of a logged-in provider, and the one set when it is not among them. */
function ModelSelect({
  value,
  options,
  ...select
}: RoleSelect & { value: string; options: readonly HostCommandOption[] }): React.ReactNode {
  const offered: Array<readonly [string, string]> = options
    .filter((option) => option.loggedIn !== false)
    .map((option) => [option.id, `${option.providerName ?? option.detail ?? ''} · ${option.label}`] as const)
  if (!offered.some(([id]) => id === value)) offered.unshift([value, `${value} (unavailable)`])
  return <OptionSelect {...select} value={value} options={offered} className={cn(PAGE_INPUT, 'min-w-0')} />
}

/** An effort to choose; `unset` says what no effort means here, in words. */
function EffortSelect({
  value,
  unset,
  ...select
}: RoleSelect & { value: string | undefined; unset: string }): React.ReactNode {
  return (
    <OptionSelect
      {...select}
      value={value ?? ''}
      options={[['', unset], ...EFFORT_OPTIONS]}
      className={cn(PAGE_INPUT, 'w-auto min-w-32')}
    />
  )
}

/** "unavailable: why" beside a model that can't run, once the listing is read. */
function Unavailable({ reason }: { reason: string | undefined }): React.ReactNode {
  if (reason === undefined) return null
  return <span className="text-xs text-refuse">unavailable: {reason}</span>
}

/** The section as a role's card reads it: the saved models, the models on offer, and how to save. */
interface RoleCardProps {
  readonly name: string
  readonly models: EnsoModelsConfig
  readonly options: readonly HostCommandOption[]
  /** Whether the providers listing was read: until it is, nothing is said unavailable. */
  readonly known: boolean
  readonly refusal: string | undefined
  readonly onSave: (update: ModelsUpdate) => void
}

/** One role: what it resolves to now, its model and effort, its fallbacks in order, and Delete. */
function RoleCard(props: RoleCardProps): React.ReactNode {
  const { name, models, options, known, refusal, onSave } = props
  const role = models.roles?.[name]
  if (role === undefined) return null
  const fallbacks = role.fallbacks ?? []
  // Each change applies to the role as the section has it when its save's turn comes, so a change
  // made while an earlier one is still saving keeps it; a role deleted by then stays deleted.
  const changeRole = (change: (current: EnsoModelRole) => EnsoModelRole): void =>
    onSave((current) => {
      const now = current.roles?.[name]
      return now === undefined ? current : withRoles(current, { ...current.roles, [name]: change(now) })
    })
  const changeFallbacks = (change: (current: readonly EnsoModelTarget[]) => readonly EnsoModelTarget[]): void =>
    changeRole((current) => withFallbacks(current, change(current.fallbacks ?? [])))
  const resolution = known ? resolveModelRole(name, models, options) : undefined
  const firstFree = options.find(
    (option) =>
      option.loggedIn !== false && option.id !== role.model && !fallbacks.some((target) => target.model === option.id),
  )
  return (
    <li aria-label={`role ${name}`} className={PAGE_CARD}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="font-mono text-base font-semibold">{name}</h4>
        {name === ENSO_DEFAULT_ROLE ? (
          <span className="text-sm text-muted-foreground">New threads start on this role.</span>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="destructive"
          aria-label={`delete role ${name}`}
          onClick={() => onSave((current) => withRoles(current, withoutKey(current.roles, name)))}
        >
          <Trash2Icon aria-hidden="true" />
          Delete
        </Button>
      </div>
      {resolution?.kind === 'refused' ? <p className="text-sm text-refuse">Unavailable: {resolution.reason}</p> : null}
      {resolution?.kind === 'resolved' && resolution.notice !== undefined ? (
        <p className="text-sm text-chart-3">{resolution.notice}</p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-role-target">
        <ModelSelect
          label={`${name}'s model`}
          value={role.model}
          options={options}
          onChange={(model) => changeRole((current) => ({ ...current, model }))}
        />
        <EffortSelect
          label={`${name}'s effort`}
          value={role.effort}
          unset="default effort"
          onChange={(effort) => changeRole((current) => withEffort(current, effort))}
        />
      </div>
      {known ? <Unavailable reason={unavailableReason(role.model, options)} /> : null}
      <div className="grid gap-2">
        <h5 className="text-sm font-semibold">Fallbacks, in order</h5>
        {fallbacks.length === 0 ? (
          <p className="text-sm text-muted-foreground">None: unavailable means refused.</p>
        ) : null}
        <ol className="grid gap-2">
          {fallbacks.map((target, index) => (
            // react-doctor-disable-next-line no-array-index-as-key -- a fallback is its place in the order
            <li key={index} className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-right font-mono text-meta text-muted-foreground">{index + 1}</span>
                <div className="min-w-48 flex-1">
                  <ModelSelect
                    label={`${name}'s fallback ${index + 1} model`}
                    value={target.model}
                    options={options}
                    onChange={(model) =>
                      changeFallbacks((current) => changedAt(current, index, (now) => ({ ...now, model })))
                    }
                  />
                </div>
                <EffortSelect
                  label={`${name}'s fallback ${index + 1} effort`}
                  value={target.effort}
                  unset="default effort"
                  onChange={(effort) =>
                    changeFallbacks((current) => changedAt(current, index, (now) => withEffort(now, effort)))
                  }
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={`move ${name}'s fallback ${index + 1} up`}
                  onClick={() => changeFallbacks((current) => swapped(current, index, index - 1))}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={index === fallbacks.length - 1}
                  aria-label={`move ${name}'s fallback ${index + 1} down`}
                  onClick={() => changeFallbacks((current) => swapped(current, index, index + 1))}
                >
                  <ArrowDownIcon aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`remove ${name}'s fallback ${index + 1}`}
                  onClick={() => changeFallbacks((current) => current.toSpliced(index, 1))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
              {known ? <Unavailable reason={unavailableReason(target.model, options)} /> : null}
            </li>
          ))}
        </ol>
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={firstFree === undefined}
            aria-label={`add a fallback to ${name}`}
            onClick={() => {
              if (firstFree === undefined) return
              const added = { model: firstFree.id }
              changeFallbacks((current) => [...current, added])
            }}
          >
            <PlusIcon aria-hidden="true" />
            Add a fallback
          </Button>
        </div>
      </div>
      {refusal === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          {refusal}
        </p>
      )}
    </li>
  )
}

/** `list` with the items at `from` and `to` swapped. */
function swapped<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const moving = next[from]
  const other = next[to]
  if (moving === undefined || other === undefined) return next
  next[from] = other
  next[to] = moving
  return next
}

/** `list` with the item at `index` changed, or as it is when there is none there. */
function changedAt<T>(list: readonly T[], index: number, change: (item: T) => T): readonly T[] {
  const item = list[index]
  return item === undefined ? list : list.with(index, change(item))
}

/** Add a role: a valid name not yet taken, starting on the first model that can run. */
function AddRole({
  models,
  options,
  refusal,
  onSave,
}: {
  models: EnsoModelsConfig
  options: readonly HostCommandOption[]
  refusal: string | undefined
  onSave: (update: ModelsUpdate) => void
}): React.ReactNode {
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const roles = models.roles ?? {}
  const suggested = SUGGESTED_MODEL_ROLES.filter((role) => roles[role] === undefined)
  const add = (chosen: string): void => {
    const trimmed = chosen.trim()
    if (!ROLE_NAME.test(trimmed)) {
      setProblem('A name starts with a lower-case letter, then lower-case letters, digits or -, 32 at most.')
      return
    }
    if (roles[trimmed] !== undefined) {
      setProblem(`There is a role named ${trimmed} already.`)
      return
    }
    const first = options.find((option) => option.loggedIn !== false)
    if (first === undefined) {
      setProblem('Log in to a provider first: a role needs a model that can run.')
      return
    }
    setProblem(undefined)
    setName('')
    // A role of that name saved since this render is kept, never replaced by a new one.
    onSave((current) =>
      current.roles?.[trimmed] === undefined
        ? withRoles(current, { ...current.roles, [trimmed]: { model: first.id } })
        : current,
    )
  }
  return (
    <form
      aria-label="add a role"
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        add(name)
      }}
    >
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="new role's name"
          placeholder="Role name, e.g. review"
          value={name}
          aria-invalid={problem !== undefined}
          onChange={(event) => setName(event.target.value)}
          className={cn(PAGE_INPUT, 'w-auto min-w-48 flex-1')}
        />
        <Button type="submit" className={PAGE_PRIMARY_BUTTON}>
          Add role
        </Button>
      </div>
      {suggested.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Start from:</span>
          {suggested.map((role) => (
            <Button key={role} type="button" size="sm" variant="outline" onClick={() => add(role)}>
              {role}
            </Button>
          ))}
          {suggested.includes(ENSO_DEFAULT_ROLE) ? <span>— default is the role new threads start on.</span> : null}
        </div>
      )}
      {(problem ?? refusal) === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          {problem ?? refusal}
        </p>
      )}
    </form>
  )
}

/** Presets: save every role and the default effort under a name, switch to one in one save, delete one. */
function Presets({
  models,
  refusal,
  onSave,
}: {
  models: EnsoModelsConfig
  refusal: string | undefined
  onSave: (update: ModelsUpdate) => void
}): React.ReactNode {
  const [name, setName] = useState('')
  const presets = models.presets ?? {}
  const names = Object.keys(presets).toSorted()
  return (
    <section aria-label="presets" className="grid gap-3">
      <h3 className={SUB_TITLE}>Presets</h3>
      <p className="max-w-prose text-sm text-muted-foreground">
        A preset keeps every role and the default effort. Switching to one replaces them all: a role the preset doesn't
        have is removed. Running threads keep what they run.
      </p>
      {names.length === 0 ? null : (
        <ul className="grid overflow-hidden rounded-sm border bg-card">
          {names.map((preset) => {
            const saved = presets[preset]
            if (saved === undefined) return null
            const roleNames = Object.keys(saved.roles)
            return (
              <li
                key={preset}
                aria-label={`preset ${preset}`}
                className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
              >
                <span className="font-semibold">{preset}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {roleNames.length === 0 ? 'no roles' : roleNames.join(', ')}
                  {saved.defaultEffort === undefined ? '' : ` · effort ${saved.defaultEffort}`}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`switch to preset ${preset}`}
                  onClick={() =>
                    onSave((current) => {
                      const chosen = current.presets?.[preset]
                      return chosen === undefined ? current : switchedToPreset(current, chosen)
                    })
                  }
                >
                  Switch
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`delete preset ${preset}`}
                  onClick={() => onSave((current) => withPresets(current, withoutKey(current.presets, preset)))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      <form
        aria-label="save a preset"
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = name.trim()
          if (trimmed === '' || trimmed.length > MODEL_PRESET_NAME_MAX) return
          setName('')
          // The roles and default effort as saved when this save's turn comes, edits still saving included.
          onSave((current) => {
            const snapshot: EnsoModelPreset = {
              roles: { ...current.roles },
              ...(current.defaultEffort === undefined ? {} : { defaultEffort: current.defaultEffort }),
            }
            return withPresets(current, { ...current.presets, [trimmed]: snapshot })
          })
        }}
      >
        <input
          aria-label="preset name"
          placeholder="Save the current roles as…"
          maxLength={MODEL_PRESET_NAME_MAX}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={cn(PAGE_INPUT, 'w-auto min-w-48 flex-1')}
        />
        <Button type="submit" variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={name.trim() === ''}>
          Save preset
        </Button>
      </form>
      {refusal === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          {refusal}
        </p>
      )}
    </section>
  )
}

export function RolesSection({
  fetch: fetchImpl,
  store = modelsSettings,
}: {
  fetch?: FetchLike | undefined
  /** The page's models section; a test passes its own. */
  store?: ModelsSettingsStore
}): React.ReactNode {
  const { read } = useProvidersListing(fetchImpl)
  const state = useStore(store)
  /** The last save's refusal and where it was asked from: a role's name, `add`, `effort` or `presets`. */
  const [refusal, setRefusal] = useState<{ readonly where: string; readonly reason: string } | undefined>(undefined)
  if (state.kind === 'loading') return <p className="text-sm text-muted-foreground">Reading your models settings…</p>
  if (state.kind === 'failed')
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.detail}
      </p>
    )
  const models = state.settings.models
  const options = read.kind === 'read' ? modelOptionsOf(read.listing) : []
  const known = read.kind === 'read'
  const save =
    (where: string) =>
    (update: ModelsUpdate): void => {
      setRefusal(undefined)
      void store.save(update).then((outcome) => {
        if (outcome.kind === 'refused') setRefusal({ where, reason: outcome.reason })
      })
    }
  const refusedAt = (where: string): string | undefined => (refusal?.where === where ? refusal.reason : undefined)
  // `default` first, the rest by name.
  const roleNames = roleNamesInOrder(models)
  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-muted-foreground">
        A role names a model and its effort, so a thread can be started on it by name. When its model can't run, its
        first available fallback does; with none, the role is refused.
      </p>
      {read.kind === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          The providers could not be read, so no model is offered: {read.reason}
        </p>
      ) : null}
      <div className="grid gap-2">
        <label htmlFor="settings-default-effort" className="text-sm font-semibold">
          Default effort
        </label>
        <p className="text-sm text-muted-foreground">The effort a role runs at when it names none.</p>
        <OptionSelect
          id="settings-default-effort"
          value={models.defaultEffort ?? ''}
          options={[['', "the model's own"], ...EFFORT_OPTIONS]}
          onChange={(effort) => save('effort')((current) => withEffortKey(current, effort))}
          className={cn(PAGE_INPUT, 'w-auto min-w-48')}
        />
        {refusedAt('effort') === undefined ? null : (
          <p role="alert" className="text-sm text-refuse">
            {refusedAt('effort')}
          </p>
        )}
      </div>
      <section aria-label="roles" className="grid gap-3">
        <h3 className={SUB_TITLE}>Roles</h3>
        {roleNames.length === 0 ? (
          <p className="text-sm text-muted-foreground">No role yet. New threads start on pi's default model.</p>
        ) : (
          <ul className="grid gap-3">
            {roleNames.map((roleName) => (
              <RoleCard
                key={roleName}
                name={roleName}
                models={models}
                options={options}
                known={known}
                refusal={refusedAt(roleName)}
                onSave={save(roleName)}
              />
            ))}
          </ul>
        )}
        <AddRole models={models} options={options} refusal={refusedAt('add')} onSave={save('add')} />
      </section>
      <Presets models={models} refusal={refusedAt('presets')} onSave={save('presets')} />
    </div>
  )
}

/** The section with `defaultEffort` set, or without it for `''`. */
function withEffortKey(models: EnsoModelsConfig, effort: string): EnsoModelsConfig {
  const { defaultEffort: _old, ...rest } = models
  return effort === '' ? rest : { ...rest, defaultEffort: effort }
}
