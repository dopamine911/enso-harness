import { readWebFetchHostInput, WebFetchAllowlist, type WebFetchAllowlistChange, WebFetchHostCheck } from '@enso/core'
import { TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { PAGE_INPUT, PAGE_OUTLINE_BUTTON, PAGE_PRIMARY_BUTTON, SUB_TITLE } from './page-styles.ts'
import { describeFailedResponse } from './stored-threads.ts'
import { WebSearchSettingsEditor } from './web-search-settings.tsx'
import {
  postJson,
  RemovableList,
  SettingsUnread,
  TrustedProjects,
  useSettingsAnswer,
  type WebToolsSectionProps,
  WhenItApplies,
} from './web-tools-shared.tsx'

/**
 * Settings › Web tools (#924, #930): what `web_fetch` and `web_search` may reach, for every project.
 * This holds **Fetching pages**, the `web_fetch` allowlist, and beside it **Searching**
 * (`web-search-settings.tsx`, #932). Written through the server (`/api/settings/web-fetch`), which changes only
 * `webFetch.allowedHosts` in `ENSO_HOME/config.json`; a trusted project's own hosts are shown, read only.
 */

/** What the Add field holds after a try: nothing yet, a refusal, or a pasted URL waiting for its reduction to be confirmed. */
type AddState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'confirm-url'; readonly host: string; readonly url: string }

type CheckState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly host: string }
  | { readonly kind: 'checked'; readonly host: string; readonly check: WebFetchHostCheck }
  | { readonly kind: 'failed'; readonly host: string; readonly reason: string }

export function WebToolsSection(props: WebToolsSectionProps): React.ReactNode {
  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-muted-foreground">
        What <code className="font-mono text-sm">web_fetch</code> and{' '}
        <code className="font-mono text-sm">web_search</code> may reach, for every project. A trusted project can add
        hosts of its own on its page.
      </p>
      <section aria-labelledby="settings-web-fetch-label" className="grid gap-3">
        <h3 id="settings-web-fetch-label" className={SUB_TITLE}>
          Fetching pages
        </h3>
        <WebFetchAllowlistEditor {...props} />
      </section>
      <section aria-labelledby="settings-web-search-label" className="grid gap-3">
        <h3 id="settings-web-search-label" className={SUB_TITLE}>
          Searching
        </h3>
        <WebSearchSettingsEditor {...props} />
      </section>
    </div>
  )
}

/** The server's one request to `host`, as the page shows it. */
async function askHostCheck(fetchNow: FetchLike, host: string): Promise<CheckState> {
  try {
    const response = await postJson(fetchNow, '/api/settings/web-fetch/check', { host })
    if (!response.ok) return { kind: 'failed', host, reason: await describeFailedResponse(response) }
    const payload: unknown = await response.json()
    if (!Check(WebFetchHostCheck, payload))
      return { kind: 'failed', host, reason: "the server's answer did not match its schema" }
    return { kind: 'checked', host, check: payload }
  } catch (error: unknown) {
    return { kind: 'failed', host, reason: String(error) }
  }
}

function WebFetchAllowlistEditor({ fetch, stored, onOpenProject }: WebToolsSectionProps): React.ReactNode {
  const answer = useSettingsAnswer(fetch, '/api/settings/web-fetch', WebFetchAllowlist, 'allowlist')
  const { read, writing, writeError, fetchNow } = answer
  const change = (body: WebFetchAllowlistChange): Promise<boolean> => answer.post(body)

  if (read.kind !== 'read') return <SettingsUnread read={read} what="the allowlist" />
  const { value: allowlist } = read

  return (
    <div className="grid gap-4">
      <AllowlistNotes path={allowlist.path} unreadable={allowlist.unreadable} />

      <UserHosts
        path={allowlist.path}
        hosts={allowlist.hosts}
        busy={writing}
        onRemove={(host) => void change({ remove: host })}
      />

      <HostAddForm idPrefix="settings" fetchNow={fetchNow} writing={writing} onAdd={(host) => change({ add: host })} />
      {writeError === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          Not saved: {writeError}
        </p>
      )}

      <WhenItApplies
        staleThreads={allowlist.staleThreads}
        stored={stored}
        lead="Applies to sessions started after the change: a thread reads the list when its session starts."
        old="the old list"
      />

      <ProjectHosts projects={allowlist.projects} onOpenProject={onOpenProject} />
    </div>
  )
}

/**
 * Add a host, with Check (#924): a pasted URL reduced to its host only once confirmed, a refusal in
 * its words, and the server's one request to the host — the user's allowlist's and a project's
 * (#937). `idPrefix` names the field, one per page; `onAdd` answers true once the host is saved.
 */
export function HostAddForm(props: {
  idPrefix: string
  fetchNow: FetchLike
  writing: boolean
  onAdd: (host: string) => Promise<boolean>
}): React.ReactNode {
  const { idPrefix, fetchNow, writing, onAdd } = props
  const [typed, setTyped] = useState('')
  const [add, setAdd] = useState<AddState>({ kind: 'idle' })
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' })
  const inputId = `${idPrefix}-web-fetch-host`
  const refusalId = `${idPrefix}-web-fetch-refusal`

  async function addHost(host: string): Promise<void> {
    if (await onAdd(host)) {
      setTyped('')
      setAdd({ kind: 'idle' })
      setCheck({ kind: 'idle' })
    }
  }

  /** The typed text as a host, or the refusal or the URL confirmation it needs first. */
  function typedHost(): string | undefined {
    const input = readWebFetchHostInput(typed)
    if (input.kind === 'refused') setAdd({ kind: 'refused', reason: input.reason })
    else if (input.kind === 'from-url') setAdd({ kind: 'confirm-url', host: input.host, url: input.url })
    else return input.host
    return undefined
  }

  async function checkHost(host: string): Promise<void> {
    setCheck({ kind: 'checking', host })
    setCheck(await askHostCheck(fetchNow, host))
  }

  const busy = writing || check.kind === 'checking'
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const host = typedHost()
        if (host !== undefined) void addHost(host)
      }}
    >
      <label htmlFor={inputId} className="text-sm font-medium">
        Add a host
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          className={cn(PAGE_INPUT, 'min-w-0 flex-1 font-mono sm:w-auto')}
          placeholder="docs.example.com"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          aria-invalid={add.kind === 'refused' ? true : undefined}
          aria-describedby={add.kind === 'refused' ? refusalId : undefined}
          onChange={(event) => {
            setTyped(event.target.value)
            setAdd({ kind: 'idle' })
          }}
        />
        <Button
          type="button"
          variant="outline"
          className={PAGE_OUTLINE_BUTTON}
          disabled={busy || typed.trim() === ''}
          onClick={() => {
            const input = readWebFetchHostInput(typed)
            if (input.kind === 'refused') setAdd({ kind: 'refused', reason: input.reason })
            else void checkHost(input.host)
          }}
        >
          Check
        </Button>
        <Button type="submit" className={PAGE_PRIMARY_BUTTON} disabled={busy || typed.trim() === ''}>
          Add
        </Button>
      </div>
      {add.kind === 'refused' ? (
        <p id={refusalId} role="alert" className="text-sm text-refuse">
          {add.reason}
        </p>
      ) : null}
      {add.kind === 'confirm-url' ? (
        <UrlReduction
          host={add.host}
          url={add.url}
          busy={busy}
          onAdd={() => void addHost(add.host)}
          onCancel={() => setAdd({ kind: 'idle' })}
        />
      ) : null}
      <CheckResult check={check} busy={busy} onAdd={(host) => void addHost(host)} />
    </form>
  )
}

/** What the list is and what adding to it means, said where it happens; and a file that can't be read. */
function AllowlistNotes({ path, unreadable }: { path: string; unreadable: string | undefined }): React.ReactNode {
  return (
    <>
      <div className="grid gap-1 text-sm text-muted-foreground">
        <p className="max-w-prose">
          <code className="font-mono">web_fetch</code> fetches only the hosts listed here. Adding a host lets agents
          read that site's content; it reaches them labelled as untrusted data, not instructions.
        </p>
        <p className="max-w-prose">
          Hosts match exactly: no wildcards, and <code className="font-mono">example.com</code> does not allow{' '}
          <code className="font-mono">docs.example.com</code>. Redirects are reported, never followed, so allow the host
          that answers. <strong className="font-semibold text-foreground">Check</strong> asks it once, from the server.
        </p>
      </div>
      {unreadable === undefined ? null : (
        <p role="alert" className="flex items-start gap-2 text-sm text-refuse">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {path} can't be read ({unreadable}), so nothing is fetchable and nothing is written here until it is fixed
            by hand.
          </span>
        </p>
      )}
    </>
  )
}

/** The user's own hosts, each with its Remove, under the file they are kept in. */
interface UserHostsProps {
  readonly path: string
  readonly hosts: readonly string[]
  readonly busy: boolean
  readonly onRemove: (host: string) => void
}

function UserHosts(props: UserHostsProps): React.ReactNode {
  const { path, hosts, busy, onRemove } = props
  return (
    <div className="grid gap-2">
      <span className="font-mono text-meta font-semibold tracking-wider text-muted-foreground uppercase">
        Your hosts · <span className="normal-case">{path}</span>
      </span>
      {hosts.length === 0 ? (
        <p className="rounded-sm border border-dashed px-3 py-2 text-sm text-muted-foreground">
          No hosts yet, so <code className="font-mono">web_fetch</code> fetches nothing.
        </p>
      ) : (
        <RemovableList
          label="allowed hosts"
          hostNames={hosts}
          busy={busy}
          removeLabel={(host) => `remove ${host}`}
          onRemove={onRemove}
        />
      )}
    </div>
  )
}

/** A pasted URL's reduction to its host, said before anything is added: the whole host is allowed, not the page. */
interface UrlReductionProps {
  readonly host: string
  readonly url: string
  readonly busy: boolean
  readonly onAdd: () => void
  readonly onCancel: () => void
}

function UrlReduction(props: UrlReductionProps): React.ReactNode {
  const { host, url, busy, onAdd, onCancel } = props
  return (
    <div role="alert" className="grid gap-2 rounded-sm border border-border-strong bg-card p-3 text-sm">
      <p>
        That's a URL. The allowlist holds hosts, so this adds <code className="font-mono font-semibold">{host}</code>,
        which allows the whole host, not just <span className="font-mono break-all text-muted-foreground">{url}</span>.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" className={PAGE_PRIMARY_BUTTON} disabled={busy} onClick={onAdd}>
          Add {host}
        </Button>
        <Button type="button" variant="outline" className={PAGE_OUTLINE_BUTTON} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Each trusted project's own hosts, read only, under the project's name (#421). */
interface ProjectHostsProps {
  readonly projects: WebFetchAllowlist['projects']
  readonly onOpenProject: (projectId: string) => void
}

function ProjectHosts({ projects, onOpenProject }: ProjectHostsProps): React.ReactNode {
  return (
    <TrustedProjects
      heading="Added by trusted projects"
      projects={projects}
      label={(project) => `hosts from ${project.title}`}
      onOpenProject={onOpenProject}
      render={(project) => (
        <ul aria-label={`allowed hosts from ${project.title}`} className="flex flex-wrap gap-1.5">
          {project.hosts.map((host) => (
            <li key={host} className="rounded-full border px-2 py-0.5 font-mono text-xs">
              {host}
            </li>
          ))}
        </ul>
      )}
    />
  )
}

/** What the server's one request to the host found, with "Add … instead?" for a redirect to another host. */
function CheckResult({
  check,
  busy,
  onAdd,
}: {
  check: CheckState
  busy: boolean
  onAdd: (host: string) => void
}): React.ReactNode {
  if (check.kind === 'idle') return null
  if (check.kind === 'checking') return <p className="text-sm text-muted-foreground">Asking https://{check.host}/ …</p>
  if (check.kind === 'failed')
    return (
      <p role="status" className="text-sm text-refuse">
        Check failed: {check.reason}
      </p>
    )
  const { host, check: found } = check
  if (found.kind === 'failed')
    return (
      <p role="status" className="text-sm text-refuse">
        {found.reason}
      </p>
    )
  if (found.kind === 'answered')
    return (
      <p role="status" className="text-sm">
        https://{host}/ answered <strong className="font-semibold">{found.status}</strong>.
        {found.status < 400
          ? ' web_fetch can reach it once it is allowed; it still reads only pages sent as text.'
          : ' The host answers, but not with a page.'}
      </p>
    )
  const suggested = found.suggestedHost
  return (
    <div role="status" className="grid gap-2 rounded-sm border border-border-strong bg-card p-3 text-sm">
      <p>
        https://{host}/ answers <strong className="font-semibold">{found.status}</strong>, a redirect
        {found.target === undefined ? (
          ' with no usable target'
        ) : (
          <>
            {' '}
            to <span className="font-mono break-all">{found.target}</span>
          </>
        )}
        . web_fetch doesn't follow redirects, so allowing {host} fetches nothing there.
      </p>
      {suggested === undefined ? null : (
        <div>
          <Button type="button" className={PAGE_PRIMARY_BUTTON} disabled={busy} onClick={() => onAdd(suggested)}>
            Add {suggested} instead?
          </Button>
        </div>
      )}
    </div>
  )
}
