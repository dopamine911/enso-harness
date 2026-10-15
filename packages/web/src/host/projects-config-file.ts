import { isAbsolute } from 'node:path'
import type {
  EnsoProjectsSettingsRead,
  EnsoProjectsSettingsWrite,
  EnsoThreadsConfig,
  EnsoThreadTreeMode,
} from '@enso/core'
import type { WriteCondition } from './atomic-file.ts'
import { type ConfigSectionWrite, readConfigFile, type SettingsPlaces, writeConfigSections } from './config-file.ts'
import { readDefaultProjectTrust } from './project-trust.ts'

/**
 * Settings › Projects & threads' files (#934): the user's `config.json` `projects` (the roots fence,
 * user-only) and `threads` (the user tier of a new thread's tree), and pi's `defaultProjectTrust`.
 *
 * ⚠ `config.json` IS A POLICY FILE THAT FAILS CLOSED: a save is the whole file, written as
 * `config-file.ts` writes it. One more refusal here: a root that is neither absolute nor `~/` would
 * stop the server at its next start (`createProjectRegistry`), so it is never written.
 *
 * ⚠ A PROJECT'S OWN MODE IS MATCHED BY CANONICAL PATH. The resolver (`readProjectThreadSettings`)
 * applies the first `threads.projects` key whose canonical path is the project's, so `~/code/app`, a
 * trailing slash or a symlink all name it. The read answers each key as that canonical path — the
 * page's project rows are canonical — and a save writes it so; two keys naming one project are
 * refused, since only one of them would apply.
 *
 * `defaultProjectTrust` is pi's key, in pi's file: read and written in `project-trust.ts`.
 */

/**
 * `threads.projects` keyed by canonical path; of two keys naming one project, the first — the
 * resolver's — and the first such pair as written, for a save to name.
 */
function canonicalModes(
  modes: Readonly<Record<string, EnsoThreadTreeMode>>,
  canonical: (key: string) => string,
): { readonly byPath: Record<string, EnsoThreadTreeMode>; readonly clash?: readonly [string, string] } {
  const byPath: Record<string, EnsoThreadTreeMode> = {}
  const keyOf: Record<string, string> = {}
  let clash: readonly [string, string] | undefined
  for (const [key, mode] of Object.entries(modes)) {
    const path = canonical(key)
    const first = keyOf[path]
    if (first === undefined) {
      byPath[path] = mode
      keyOf[path] = key
    } else {
      clash ??= [first, key]
    }
  }
  return clash === undefined ? { byPath } : { byPath, clash }
}

/** The user's `projects` and `threads`, pi's trust default, or why the config cannot be read. */
export function readProjectsSettings({ home, agentDir, canonical }: SettingsPlaces): EnsoProjectsSettingsRead {
  const { parsed, ...file } = readConfigFile(home)
  const common = {
    ...file,
    ...readDefaultProjectTrust(agentDir),
  }
  if (parsed.kind === 'unreadable') return { kind: 'unreadable', ...common, reason: parsed.reason }
  const { projects, threads = {} } = parsed.config
  return {
    kind: 'ok',
    ...common,
    ...(projects === undefined ? {} : { projects }),
    threads:
      threads.projects === undefined
        ? threads
        : { ...threads, projects: canonicalModes(threads.projects, canonical).byPath },
  }
}

/** @group Projects settings */
export type ProjectsSettingsWrite = ConfigSectionWrite<EnsoProjectsSettingsRead>

/** `threads` with its empty lists and record dropped: a page that clears every field leaves no `{}`. */
function prunedThreads(threads: EnsoThreadsConfig): EnsoThreadsConfig | undefined {
  const { tree, projects, setup, copy } = threads
  const next: EnsoThreadsConfig = {
    ...(tree === undefined ? {} : { tree }),
    ...(projects === undefined || Object.keys(projects).length === 0 ? {} : { projects }),
    ...(setup === undefined || setup.length === 0 ? {} : { setup }),
    ...(copy === undefined || copy.length === 0 ? {} : { copy }),
  }
  return Object.keys(next).length === 0 ? undefined : next
}

/** Why the page's values cannot be written, in words the page shows; nothing when they can. */
function problemOf(write: EnsoProjectsSettingsWrite): string | undefined {
  const relative = (path: string): boolean => !isAbsolute(path) && !path.startsWith('~/')
  const relativeRoot = write.projects?.roots.find(relative)
  if (relativeRoot !== undefined) {
    return `project root ${relativeRoot} is neither absolute nor ~/: the server would refuse to start with it`
  }
  const relativeProject = Object.keys(write.threads.projects ?? {}).find(relative)
  if (relativeProject !== undefined) {
    return `a project's own mode is keyed by its absolute or ~/ path, not ${relativeProject}`
  }
  return undefined
}

/**
 * Write `projects` and `threads` into the user's `config.json` under `condition`, every other key
 * kept, each project's own mode under its canonical path. A file that is unreadable now, a root the
 * server would refuse, two modes for one project, or a result `parseEnsoConfig` refuses, writes
 * nothing.
 */
export function writeProjectsSettings(
  places: SettingsPlaces,
  write: EnsoProjectsSettingsWrite,
  condition: WriteCondition,
): ProjectsSettingsWrite {
  const problem = problemOf(write)
  if (problem !== undefined) return { kind: 'refused', reason: `nothing was saved: ${problem}` }
  const { byPath: modes, clash } = canonicalModes(write.threads.projects ?? {}, places.canonical)
  if (clash !== undefined) {
    return {
      kind: 'refused',
      reason: `nothing was saved: ${clash[0]} and ${clash[1]} name the same project, and only one would apply`,
    }
  }
  const roots = write.projects?.roots ?? []
  const threads = prunedThreads({ ...write.threads, projects: modes })
  return writeConfigSections(
    places.home,
    condition,
    ({ projects: _projects, threads: _threads, ...kept }) => ({
      ...kept,
      ...(roots.length === 0 ? {} : { projects: { roots } }),
      ...(threads === undefined ? {} : { threads }),
    }),
    () => readProjectsSettings(places),
  )
}
