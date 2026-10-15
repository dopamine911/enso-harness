import {
  type EnsoStoredThread,
  type ProjectWebTools,
  ProjectWebTools as ProjectWebToolsSchema,
  type ProjectWebToolsChange,
} from '@enso/core'
import { ExternalLinkIcon, LockIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { PAGE_BANNER, SUB_TITLE } from './page-styles.ts'
import { type BackendOption, BackendField, DOMAIN_LISTS, DomainList, FieldSource } from './web-search-settings.tsx'
import { HostAddForm } from './web-tools-settings.tsx'
import { RemovableList, SettingsUnread, useSettingsAnswer, WhenItApplies } from './web-tools-shared.tsx'

/**
 * A project page's Web tools tab (#937): the project's own `webFetch` hosts and `webSearch`
 * settings, in its shared `.enso/config.json` — the one project tier a session merges, so the only
 * one this tab writes (`.enso/config.local.json` is never read for web tools). Its hosts and domains
 * add to yours, its backend replaces yours; each value says the file it comes from, and yours are
 * shown beside it, read only, with the way to Settings › Web tools. Written through the server
 * (`/api/projects/<projectId>/web-tools`), which changes only the touched key.
 *
 * ⚠ An untrusted project's file is never read: the tab is read only, says so, and shows only yours.
 */

/** The project's backend: yours (the key unset), or DeepSeek in place of yours for its threads. */
function projectBackends(yours: BackendOption['value']): readonly BackendOption[] {
  const yoursSays = yours === 'deepseek' ? 'DeepSeek' : "the current model's own search"
  return [
    { value: 'model', label: 'Yours applies', says: `This project's threads search as yours do: ${yoursSays}.` },
    {
      value: 'deepseek',
      label: 'DeepSeek',
      says: "DeepSeek's search for this project's threads, whatever the model, with DEEPSEEK_API_KEY from the secrets file.",
    },
  ]
}

/** The shared file as the project's members know it. */
const SHARED_FILE = '.enso/config.json'
const LOCAL_FILE = '.enso/config.local.json'

export interface ProjectWebToolsTabProps {
  readonly projectId: string
  readonly fetch?: FetchLike | undefined
  /** The stored listing: a thread still on the old settings is named by its title. */
  readonly stored: readonly EnsoStoredThread[]
  /** Open Settings › Web tools, where your own are changed. */
  readonly onOpenSettings: () => void
  /** A change went through: it wrote the project's file and approved it as written (#753). */
  readonly onSaved?: (() => void) | undefined
}

export function ProjectWebToolsTab({
  projectId,
  fetch,
  stored,
  onOpenSettings,
  onSaved,
}: ProjectWebToolsTabProps): React.ReactNode {
  const answer = useSettingsAnswer(
    fetch,
    `/api/projects/${projectId}/web-tools`,
    ProjectWebToolsSchema,
    "project's web tools",
  )
  const { read, writing, writeError, fetchNow } = answer
  const change = async (body: ProjectWebToolsChange): Promise<boolean> => {
    const saved = await answer.post(body)
    if (saved) onSaved?.()
    return saved
  }
  if (read.kind !== 'read') return <SettingsUnread read={read} what="this project's web tools" />
  const { value: tools } = read
  const { own } = tools
  // A file not the version approved is never written here (#753): its controls wait for the approval.
  const busy = writing || tools.pending !== undefined

  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-sm text-muted-foreground">
        Saved in this project's{' '}
        <code className="font-mono break-all" title={tools.path}>
          {SHARED_FILE}
        </code>
        , for everyone who works in it. Only that file is merged into a session: web tools in{' '}
        <code className="font-mono">{LOCAL_FILE}</code> are ignored.
      </p>
      <ReadNotes tools={tools} />
      <ReachableHosts tools={tools} />

      <section aria-labelledby="project-web-fetch-label" className="grid gap-3">
        <h3 id="project-web-fetch-label" className={SUB_TITLE}>
          Fetching pages
        </h3>
        {own === undefined ? null : (
          <div className="grid gap-2">
            <FieldSource
              path={tools.path}
              configKey="webFetch.allowedHosts"
              set={own.hosts.length > 0}
              unset="none — only your hosts apply"
            />
            <p className="text-xs text-muted-foreground">
              Added to your own hosts for threads in this project. Hosts match exactly.
            </p>
            {own.hosts.length === 0 ? null : (
              <RemovableList
                label="this project's hosts"
                hostNames={own.hosts}
                busy={busy}
                removeLabel={(host) => `remove ${host} from this project`}
                onRemove={(host) => void change({ remove: host })}
              />
            )}
            <HostAddForm
              idPrefix="project"
              fetchNow={fetchNow}
              writing={busy}
              onAdd={(host) => change({ add: host })}
            />
          </div>
        )}
        <YoursReadOnly path={tools.yours.path} label="Your hosts" onOpenSettings={onOpenSettings}>
          <span className="font-mono">{tools.yours.hosts.length === 0 ? 'none' : tools.yours.hosts.join(', ')}</span>
        </YoursReadOnly>
      </section>

      <section aria-labelledby="project-web-search-label" className="grid gap-3">
        <h3 id="project-web-search-label" className={SUB_TITLE}>
          Searching
        </h3>
        {own === undefined ? null : (
          <>
            <BackendField
              path={tools.path}
              backend={own.backend ?? 'model'}
              set={own.backend !== undefined}
              unset="yours applies"
              options={projectBackends(tools.yours.backend)}
              idPrefix="project"
              busy={busy}
              onChoose={(backend) => void change({ backend })}
            />
            {DOMAIN_LISTS.map((field) => (
              <DomainList
                key={field.list}
                {...field}
                empty="None of this project's own: yours apply."
                unset="yours applies"
                idPrefix="project"
                path={tools.path}
                domains={own[field.list]}
                busy={busy}
                onChange={change}
              />
            ))}
          </>
        )}
        <YoursReadOnly path={tools.yours.path} label="Your search backend" onOpenSettings={onOpenSettings}>
          <span>{tools.yours.backend === 'deepseek' ? 'DeepSeek' : "The current model's own search"}</span>
          {DOMAIN_LISTS.map(({ list, label }) => (
            <span key={list} className="text-xs text-muted-foreground">
              {label}:{' '}
              <span className="font-mono text-foreground">
                {tools.yours[list].length === 0 ? 'none' : tools.yours[list].join(', ')}
              </span>
            </span>
          ))}
        </YoursReadOnly>
      </section>

      {writeError === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          Not saved: {writeError}
        </p>
      )}
      {own === undefined ? null : (
        <WhenItApplies
          staleThreads={tools.staleThreads}
          stored={stored}
          lead="Applies to this project's sessions started after the change: a thread reads them when its session starts."
          old="the old settings"
        />
      )}
    </div>
  )
}

/** What each pending state is said as: the file as it is against the version approved (#753). */
const PENDING_WORDS: Readonly<Record<NonNullable<ProjectWebTools['pending']>, string>> = {
  changed: 'has changed since you approved it, so the version you approved applies',
  removed: 'is gone since you approved it, so the version you approved applies',
  unapproved: 'has not been approved, so nothing in it applies',
}

/**
 * An untrusted project's tab is read only; a file that is not the version approved is said, and not
 * written until it is approved; an approved version that can't be read is said, never written.
 */
function ReadNotes({ tools }: { tools: ProjectWebTools }): React.ReactNode {
  if (!tools.trusted)
    return (
      <div role="note" className={cn(PAGE_BANNER, 'border-dashed')}>
        <span className="flex items-center gap-2 font-semibold">
          <LockIcon aria-hidden="true" className="size-4" />
          Not read yet
        </span>
        <p className="text-sm text-muted-foreground">
          Enso reads this project's <code className="font-mono">{SHARED_FILE}</code> only once you trust the project, so
          nothing in it is shown or changed here: its threads run under your web tools alone. Trust the project above to
          see and change its own.
        </p>
      </div>
    )
  if (tools.pending !== undefined)
    return (
      <p role="note" className="flex items-start gap-2 text-sm text-muted-foreground">
        <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          {tools.path} {PENDING_WORDS[tools.pending]}. Review and approve it above before changing it here, so nothing
          is approved unseen.
        </span>
      </p>
    )
  if (tools.unreadable === undefined) return null
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-refuse">
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        The version of {tools.path} you approved can't be read ({tools.unreadable}), so nothing in it applies and
        nothing is written here until it is fixed.
      </span>
    </p>
  )
}

/** What web_fetch may reach in this project: your hosts and the project's, each said with the file it comes from. */
function ReachableHosts({ tools }: { tools: ProjectWebTools }): React.ReactNode {
  const yours = new Set(tools.yours.hosts.map((host) => host.toLowerCase()))
  const projectOnly = (tools.own?.hosts ?? []).filter((host) => !yours.has(host.toLowerCase()))
  const rows = [
    ...tools.yours.hosts.map((host) => ({ host, from: 'yours' })),
    ...projectOnly.map((host) => ({ host, from: 'this project' })),
  ]
  return (
    <div className={PAGE_BANNER}>
      <span className="flex items-center gap-2 font-semibold">
        <SearchIcon aria-hidden="true" className="size-4" />
        In this project, <code className="font-mono">web_fetch</code> may reach
      </span>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">no host</p>
      ) : (
        <ul aria-label="hosts web_fetch may reach in this project" className="flex flex-wrap gap-1.5">
          {rows.map(({ host, from }) => (
            <li key={host} className="rounded-full border px-2 py-0.5 text-xs">
              <span className="font-mono">{host}</span> <span className="text-muted-foreground">· {from}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Yours, read only on a project's page, under the file it comes from, with the way to change it. */
function YoursReadOnly({
  path,
  label,
  onOpenSettings,
  children,
}: {
  path: string
  label: string
  onOpenSettings: () => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div
      role="group"
      aria-label={`${label}, read only`}
      className="grid gap-1 rounded-sm border bg-card px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground" title={path}>
          {path}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onOpenSettings}>
          Change in Settings
          <ExternalLinkIcon aria-hidden="true" />
        </Button>
      </div>
      {children}
    </div>
  )
}
