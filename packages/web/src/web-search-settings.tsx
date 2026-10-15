import {
  readWebFetchHostInput,
  type TavilyKeyChange,
  type WebSearchBackendChoice,
  type WebSearchDomainList,
  WebSearchSettings,
  type WebSearchSettingsChange,
} from '@enso/core'
import { KeyRoundIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { PAGE_INPUT, PAGE_OUTLINE_BUTTON, PAGE_PRIMARY_BUTTON } from './page-styles.ts'
import {
  RemovableList,
  SettingsUnread,
  TrustedProjects,
  useSettingsAnswer,
  type WebToolsSectionProps,
  WhenItApplies,
} from './web-tools-shared.tsx'

/**
 * Settings › Web tools › Searching (#932): `web_search`'s backend and its Tavily domain lists, in
 * `ENSO_HOME/config.json`, and the `TAVILY_API_KEY` that arms the Tavily fallback, in
 * `ENSO_HOME/secrets.env`. Written through the server (`/api/settings/web-search`), which changes
 * only the touched key; the key is sent once and never shown — the page only learns whether one is set.
 * Each field says where its value comes from, and a trusted project's own `webSearch` is shown, read only.
 */

export const DOMAIN_LISTS: readonly { list: WebSearchDomainList; label: string; says: string; empty: string }[] = [
  {
    list: 'includeDomains',
    label: 'Only these domains',
    says: 'Tavily answers only from these domains.',
    empty: 'None: Tavily searches every domain.',
  },
  {
    list: 'excludeDomains',
    label: 'Never these domains',
    says: 'Tavily leaves these domains out.',
    empty: 'None excluded.',
  },
]

export function WebSearchSettingsEditor({ fetch, stored, onOpenProject }: WebToolsSectionProps): React.ReactNode {
  const { read, writing, writeError, post } = useSettingsAnswer(
    fetch,
    '/api/settings/web-search',
    WebSearchSettings,
    'web search settings',
  )
  const change = (body: WebSearchSettingsChange): Promise<boolean> => post(body)

  if (read.kind !== 'read') return <SettingsUnread read={read} what="the search settings" />
  const { value: settings } = read

  return (
    <div className="grid gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">
        <code className="font-mono">web_search</code> answers through a search backend. When it can't, or answers
        without searching, Tavily answers instead, if a Tavily key is set.
      </p>
      {settings.unreadable === undefined ? null : (
        <p role="alert" className="flex items-start gap-2 text-sm text-refuse">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {settings.path} can't be read ({settings.unreadable}), so web_search refuses every call and nothing is
            written here until it is fixed by hand.
          </span>
        </p>
      )}

      <BackendField
        path={settings.path}
        backend={settings.backend}
        set={settings.backend !== 'model'}
        options={BACKENDS}
        idPrefix="settings"
        busy={writing}
        onChoose={(backend) => void change({ backend })}
      />

      <TavilyKeyField
        secretsPath={settings.secretsPath}
        keySet={settings.tavilyKeySet}
        unreadable={settings.secretsUnreadable}
        busy={writing}
        onChange={(body) => post(body, '/api/settings/web-search/tavily-key')}
      />

      {DOMAIN_LISTS.map((field) => (
        <DomainList
          key={field.list}
          {...field}
          path={settings.path}
          domains={settings[field.list]}
          busy={writing}
          onChange={change}
        />
      ))}

      {writeError === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          Not saved: {writeError}
        </p>
      )}

      <WhenItApplies
        staleThreads={settings.staleThreads}
        stored={stored}
        lead="The backend and the domains apply to sessions started after the change: a thread reads them when its session starts."
        old="the old settings"
      />

      <ProjectSearch projects={settings.projects} onOpenProject={onOpenProject} />
    </div>
  )
}

/** Where a field's value comes from: the file, under the key it is kept as — or, unset there, what applies (`unset`). */
export function FieldSource({
  path,
  configKey,
  set,
  unset = 'the default',
}: {
  path: string
  configKey: string
  set: boolean
  unset?: string | undefined
}): React.ReactNode {
  return (
    <span className="font-mono text-meta font-semibold tracking-wider text-muted-foreground uppercase">
      <span className="normal-case">{set ? `${configKey} · ${path}` : `not set in ${path}: ${unset}`}</span>
    </span>
  )
}

/** A backend to choose, in words: what it is and what choosing it means. */
export type BackendOption = { readonly value: WebSearchBackendChoice; readonly label: string; readonly says: string }

interface BackendFieldProps {
  readonly path: string
  /** The option chosen: `model` while the file sets no backend. */
  readonly backend: WebSearchBackendChoice
  /** Whether the file sets `webSearch.backend`. */
  readonly set: boolean
  /** What applies while it doesn't: Enso's default here, the user's on a project's page (#937). */
  readonly unset?: string
  readonly options: readonly BackendOption[]
  /** The radio group's name prefix: one per page. */
  readonly idPrefix: string
  readonly busy: boolean
  readonly onChoose: (backend: WebSearchBackendChoice) => void
}

const BACKENDS: readonly BackendOption[] = [
  {
    value: 'model',
    label: "The current model's own search",
    says: 'Anthropic, Google and OpenAI models search through their own provider, billed as the conversation is. A model with no search of its own leaves it to Tavily.',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    says: "DeepSeek's search, whatever the model, with DEEPSEEK_API_KEY from the secrets file.",
  },
]

/** `webSearch.backend`: one card per option, the file it comes from above them. */
export function BackendField(props: BackendFieldProps): React.ReactNode {
  const { path, backend, set, unset, options, idPrefix, busy, onChoose } = props
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Backend</legend>
      <FieldSource path={path} configKey="webSearch.backend" set={set} unset={unset} />
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            aria-label={option.label}
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded-sm border bg-card px-3 py-2 text-sm',
              backend === option.value && 'border-primary',
              busy && 'cursor-wait opacity-70',
            )}
          >
            <input
              type="radio"
              name={`${idPrefix}-web-search-backend`}
              className="mt-1 accent-primary"
              value={option.value}
              checked={backend === option.value}
              disabled={busy}
              onChange={() => onChoose(option.value)}
            />
            <span className="grid gap-0.5">
              <span className="font-semibold">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.says}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

interface TavilyKeyFieldProps {
  readonly secretsPath: string
  readonly keySet: boolean
  /** Why the secrets file can't be read: then whether a key is set is unknown, not "no key". */
  readonly unreadable: string | undefined
  readonly busy: boolean
  readonly onChange: (body: TavilyKeyChange) => Promise<boolean>
}

/** The Tavily key: whether one is set, a field to set or replace it, and Remove. The key itself is never shown. */
function TavilyKeyField({ secretsPath, keySet, unreadable, busy, onChange }: TavilyKeyFieldProps): React.ReactNode {
  const [typed, setTyped] = useState('')
  async function setKey(): Promise<void> {
    // Trimmed: a pasted key's stray space would be refused as "no spaces", which points nowhere.
    if (await onChange({ set: typed.trim() })) setTyped('')
  }
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void setKey()
      }}
    >
      <label htmlFor="settings-tavily-key" className="text-sm font-medium">
        Tavily key
      </label>
      <span className="font-mono text-meta font-semibold tracking-wider text-muted-foreground uppercase">
        <span className="normal-case">TAVILY_API_KEY · {secretsPath}</span>
      </span>
      {unreadable === undefined ? (
        <p className="flex items-center gap-2 text-sm" aria-live="polite">
          <KeyRoundIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          {keySet ? 'A key is set: Tavily answers when the backend can’t.' : 'No key: there is no Tavily fallback.'}
        </p>
      ) : (
        <p role="alert" className="flex items-start gap-2 text-sm text-refuse">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {secretsPath} can't be read ({unreadable}), so whether a key is set is unknown, and web_search can't read
            one either until it is fixed by hand.
          </span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          id="settings-tavily-key"
          type="password"
          className={cn(PAGE_INPUT, 'min-w-0 flex-1 font-mono sm:w-auto')}
          placeholder={keySet ? 'A new key replaces the one set' : 'tvly-…'}
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button type="submit" className={PAGE_PRIMARY_BUTTON} disabled={busy || typed.trim() === ''}>
          {keySet ? 'Replace' : 'Set'}
        </Button>
        {keySet ? (
          <Button
            type="button"
            variant="outline"
            className={PAGE_OUTLINE_BUTTON}
            disabled={busy}
            onClick={() => void onChange({ remove: true })}
          >
            Remove
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Kept in the secrets file, never in the config, and never shown again. It is read on every search, so a change
        applies at once.
      </p>
    </form>
  )
}

interface DomainListProps {
  readonly list: WebSearchDomainList
  readonly label: string
  readonly says: string
  readonly empty: string
  readonly path: string
  readonly domains: readonly string[]
  readonly busy: boolean
  readonly onChange: (body: WebSearchSettingsChange) => Promise<boolean>
  /** What applies while the file sets no list: Enso's default here, the user's on a project's page (#937). */
  readonly unset?: string
  /** The add field's id prefix: one per page the list is on. */
  readonly idPrefix?: string
}

/** One Tavily domain list: its domains, each with Remove, and a field to add one. */
export function DomainList(props: DomainListProps): React.ReactNode {
  const { list, label, says, empty, path, domains, busy, onChange, unset, idPrefix = 'settings' } = props
  const [typed, setTyped] = useState('')
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const inputId = `${idPrefix}-web-search-${list}`
  async function addDomain(domain: string): Promise<void> {
    if (await onChange({ list, add: domain })) setTyped('')
  }
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const input = readWebFetchHostInput(typed)
        if (input.kind === 'refused') return setRefused(input.reason)
        if (input.kind === 'from-url') return setRefused(`Type the domain alone: ${input.host}.`)
        void addDomain(input.host)
      }}
    >
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <FieldSource path={path} configKey={`webSearch.tavily.${list}`} set={domains.length > 0} unset={unset} />
      <p className="text-xs text-muted-foreground">{says}</p>
      {domains.length === 0 ? (
        <p className="rounded-sm border border-dashed px-3 py-2 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <RemovableList
          label={label}
          hostNames={domains}
          busy={busy}
          removeLabel={(domain) => `remove ${domain} from ${label.toLowerCase()}`}
          onRemove={(domain) => void onChange({ list, remove: domain })}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          className={cn(PAGE_INPUT, 'min-w-0 flex-1 font-mono sm:w-auto')}
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          aria-invalid={refused === undefined ? undefined : true}
          onChange={(event) => {
            setTyped(event.target.value)
            setRefused(undefined)
          }}
        />
        <Button type="submit" variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={busy || typed.trim() === ''}>
          Add
        </Button>
      </div>
      {refused === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          {refused}
        </p>
      )}
    </form>
  )
}

/** Each trusted project's own `webSearch`, read only: its backend replaces yours there, its domains add to yours. */
function ProjectSearch({
  projects,
  onOpenProject,
}: {
  projects: WebSearchSettings['projects']
  onOpenProject: (projectId: string) => void
}): React.ReactNode {
  return (
    <TrustedProjects
      heading="Set by trusted projects"
      projects={projects}
      label={(project) => `search settings from ${project.title}`}
      onOpenProject={onOpenProject}
      render={(project) => (
        <dl className="grid gap-1 text-xs">
          {project.backend === undefined ? null : (
            <div className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">Backend</dt>
              <dd>DeepSeek, in place of yours</dd>
            </div>
          )}
          {DOMAIN_LISTS.filter(({ list }) => project[list].length > 0).map(({ list, label }) => (
            <div key={list} className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono">{project[list].join(', ')}, added to yours</dd>
            </div>
          ))}
        </dl>
      )}
    />
  )
}
