import type { EnsoProject, EnsoProjectSettings } from '@enso/core'
import { TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { cn } from './lib/utils.ts'
import { type ProjectRequestOutcome, readProjectSettings } from './project-list.ts'

/**
 * What a project is, as the Projects page's cards (#870) and the rail's project switcher (#876)
 * both say it: its folder missing, and whether it is trusted — read from each project's
 * `GET /api/projects/:id/settings`.
 */

/** A project's settings as read: its answer, or the server's reason; absent while the read is out. */
export type SettingsReads = ReadonlyMap<string, ProjectRequestOutcome<EnsoProjectSettings>>

/**
 * Each project's `GET /api/projects/:id/settings`, read when the caller mounts and again when the
 * projects listed change (one added or removed). A read that could not reach the server is said as
 * a refusal with its reason, never as an untrusted project. `fetchImpl` absent is the browser's.
 */
export function useProjectSettings(projectIds: readonly string[], fetchImpl: FetchLike | undefined): SettingsReads {
  const key = projectIds.join('\n')
  const [reads, setReads] = useState<SettingsReads>(new Map())
  useEffect(() => {
    let current = true
    const ids = key === '' ? [] : key.split('\n')
    const readOne = async (projectId: string): Promise<[string, ProjectRequestOutcome<EnsoProjectSettings>]> => {
      try {
        return [projectId, await readProjectSettings(projectId, fetchImpl)]
      } catch (error) {
        return [projectId, { kind: 'refused', reason: error instanceof Error ? error.message : String(error) }]
      }
    }
    void Promise.all(ids.map(readOne)).then((answers) => {
      if (current) setReads(new Map(answers))
    })
    return (): void => {
      current = false
    }
  }, [key, fetchImpl])
  return reads
}

export const BADGE = 'inline-flex items-center gap-1 rounded-full border px-2 font-mono text-xs'

/** A project's trouble, as badges: its folder missing, and not trusted. */
export function ProjectStatusBadges({
  project,
  trusted,
}: {
  project: EnsoProject
  /** Undefined until its settings are read, or when they could not be: no badge is guessed. */
  trusted: boolean | undefined
}): React.ReactNode {
  return (
    <>
      {project.status === 'missing-dir' ? (
        <span className={cn(BADGE, 'border-destructive text-destructive')} title={`${project.path} no longer exists`}>
          <TriangleAlertIcon aria-hidden="true" className="size-3" />
          folder missing
        </span>
      ) : null}
      {trusted === false ? (
        <span className={cn(BADGE, 'border-dashed')} title="Enso doesn’t read this project’s own settings files">
          not trusted
        </span>
      ) : null}
    </>
  )
}
