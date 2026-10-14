import type { EnsoStoredThread, WebToolsProject } from '@enso/core'
import { ExternalLinkIcon, LockIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { describeFailedResponse } from './stored-threads.ts'

/**
 * What Settings › Web tools' two groups share (#924, #932): the section's props, the read-and-write
 * of one settings answer from the server, the line saying when a change applies, and the card a
 * trusted project's own settings are shown in, read only.
 */

/** What the section reads of a stored thread: its id, and the title it is named by. */
type StoredTitle = Pick<EnsoStoredThread, 'threadId' | 'title'>

export interface WebToolsSectionProps {
  readonly fetch?: FetchLike | undefined
  /** The stored listing: a thread still on the old settings is named by its title. */
  readonly stored: readonly StoredTitle[]
  /** Open a project's page, from the settings it adds. */
  readonly onOpenProject: (projectId: string) => void
}

/** The page's `fetch`, called as a function (a browser's refuses any `this` but the window). */
const pageFetch: FetchLike = (input, init) => fetch(input, init)

export async function postJson(fetchNow: FetchLike, url: string, body: unknown): Promise<Response> {
  return fetchNow(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export type SettingsRead<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string }

/** A settings answer read and checked against `schema`, or why not. */
async function settingsOf<Schema extends TSchema>(
  response: Response,
  schema: Schema,
  what: string,
): Promise<SettingsRead<Static<Schema>>> {
  if (!response.ok) return { kind: 'failed', reason: await describeFailedResponse(response) }
  const payload: unknown = await response.json()
  if (!Check(schema, payload)) return { kind: 'failed', reason: `the server's ${what} did not match its schema` }
  return { kind: 'read', value: payload }
}

/**
 * One settings answer, read from `url` when the section mounts; each change posted, and the answer
 * — the settings as they now stand — shown in its place, or why it was not saved.
 */
export function useSettingsAnswer<Schema extends TSchema>(
  fetchProp: FetchLike | undefined,
  url: string,
  schema: Schema,
  what: string,
): {
  readonly read: SettingsRead<Static<Schema>>
  readonly writing: boolean
  readonly writeError: string | undefined
  /** The page's `fetch`, or the test's. */
  readonly fetchNow: FetchLike
  /** A change posted to `postUrl` — `url` itself when not given. */
  readonly post: (body: unknown, postUrl?: string) => Promise<boolean>
} {
  const fetchNow = fetchProp ?? pageFetch
  const [read, setRead] = useState<SettingsRead<Static<Schema>>>({ kind: 'loading' })
  const [writeError, setWriteError] = useState<string | undefined>(undefined)
  const [writing, setWriting] = useState(false)
  useEffect(() => {
    let current = true
    void fetchNow(url)
      .then((response) => settingsOf(response, schema, what))
      .catch((error: unknown) => ({ kind: 'failed', reason: String(error) }) as const)
      .then((next) => {
        if (current) setRead(next)
      })
    return (): void => {
      current = false
    }
  }, [fetchNow, url, schema, what])

  async function post(body: unknown, postUrl = url): Promise<boolean> {
    setWriting(true)
    setWriteError(undefined)
    try {
      const next = await settingsOf(await postJson(fetchNow, postUrl, body), schema, what)
      if (next.kind === 'failed') {
        setWriteError(next.reason)
        return false
      }
      setRead(next)
      return true
    } catch (error: unknown) {
      setWriteError(String(error))
      return false
    } finally {
      setWriting(false)
    }
  }
  return { read, writing, writeError, fetchNow, post }
}

/** When a change applies — read at session start — and the live threads still on the old settings, by title. */
export function WhenItApplies({
  staleThreads,
  stored,
  lead,
  old,
}: {
  readonly staleThreads: readonly string[]
  readonly stored: readonly StoredTitle[]
  /** What applies when, said first. */
  readonly lead: string
  /** What the stale threads still run on: "the old list". */
  readonly old: string
}): React.ReactNode {
  const names = staleThreads.map((threadId) => {
    const title = stored.find((row) => row.threadId === threadId)?.title?.trim() ?? ''
    return title === '' ? `new thread ${threadId.slice(0, 8)}` : title
  })
  return (
    <p className="text-sm text-muted-foreground">
      {lead}
      {names.length === 0 ? null : (
        <>
          {' '}
          Still running on {old}: <span className="text-foreground">{names.join(', ')}</span>.
        </>
      )}
    </p>
  )
}

/** A settings answer's place while it is read, or why it could not be. */
export function SettingsUnread({
  read,
  what,
}: {
  readonly read: Exclude<SettingsRead<unknown>, { readonly kind: 'read' }>
  /** "the allowlist" */
  readonly what: string
}): React.ReactNode {
  if (read.kind === 'loading') return <p className="text-sm text-muted-foreground">Reading {what}…</p>
  return (
    <p role="alert" className="text-sm text-refuse">
      {what.charAt(0).toUpperCase()}
      {what.slice(1)} could not be read: {read.reason}
    </p>
  )
}

/** Host names, each one removable, under `label`: the allowlist's hosts, a Tavily domain list. */
export function RemovableList({
  label,
  hostNames,
  busy,
  removeLabel,
  onRemove,
}: {
  readonly label: string
  readonly hostNames: readonly string[]
  readonly busy: boolean
  /** The Remove button's accessible name for `hostName`. */
  readonly removeLabel: (hostName: string) => string
  readonly onRemove: (hostName: string) => void
}): React.ReactNode {
  return (
    <ul aria-label={label} className="overflow-hidden rounded-sm border bg-card">
      {hostNames.map((hostName) => (
        <li key={hostName} className="flex items-center gap-3 border-b px-3 py-1.5 text-sm last:border-b-0">
          <span className="min-w-0 flex-1 truncate font-mono">{hostName}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={removeLabel(hostName)}
            onClick={() => onRemove(hostName)}
          >
            <XIcon aria-hidden="true" />
            Remove
          </Button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Each trusted project's own settings, read only, under `heading` (#421): a card per project with
 * its name, its file and the way to its page, and what it sets (`render`). Nothing when none does.
 */
interface TrustedProjectsProps<Project extends WebToolsProject> {
  readonly heading: string
  readonly projects: readonly Project[]
  /** The card's accessible name for `project`. */
  readonly label: (project: Project) => string
  readonly onOpenProject: (projectId: string) => void
  readonly render: (project: Project) => React.ReactNode
}

export function TrustedProjects<Project extends WebToolsProject>(
  props: TrustedProjectsProps<Project>,
): React.ReactNode {
  const { heading, projects, label, onOpenProject, render } = props
  if (projects.length === 0) return null
  return (
    <div className="grid gap-2">
      <span className="font-mono text-meta font-semibold tracking-wider text-muted-foreground uppercase">
        {heading}
      </span>
      {projects.map((project) => (
        <TrustedProjectCard
          key={project.projectId}
          project={project}
          label={label(project)}
          onOpenProject={onOpenProject}
        >
          {render(project)}
        </TrustedProjectCard>
      ))}
    </div>
  )
}

function TrustedProjectCard({
  project,
  label,
  onOpenProject,
  children,
}: {
  readonly project: WebToolsProject
  readonly label: string
  readonly onOpenProject: (projectId: string) => void
  readonly children: React.ReactNode
}): React.ReactNode {
  return (
    <div role="group" aria-label={label} className="grid gap-1 rounded-sm border bg-card px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <LockIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="font-semibold">{project.title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground" title={project.path}>
          {project.path}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenProject(project.projectId)}>
          Open project
          <ExternalLinkIcon aria-hidden="true" />
        </Button>
      </div>
      {children}
      <p className="text-xs text-muted-foreground">
        Read only here: for that project's threads only, from its own file.
      </p>
    </div>
  )
}
