import { isAbsolute } from 'node:path'
import { type EnsoProjectsSettingsRead, type EnsoProjectsSettingsWrite, type EnsoThreadsConfig } from '@enso/core'
import { type ConfigSectionWrite, readConfigFile, writeConfigSections } from './config-file.ts'
import type { WriteCondition } from './permission-policy-file.ts'
import { readDefaultProjectTrust } from './project-trust.ts'

/**
 * Settings › Projects & threads' files (#934): the user's `config.json` `projects` (the roots fence,
 * user-only) and `threads` (the user tier of a new thread's tree), and pi's `defaultProjectTrust`.
 *
 * ⚠ `config.json` IS A POLICY FILE THAT FAILS CLOSED: a save is the whole file, written as
 * `config-file.ts` writes it. One more refusal here: a root that is neither absolute nor `~/` would
 * stop the server at its next start (`createProjectRegistry`), so it is never written.
 *
 * `defaultProjectTrust` is pi's key, in pi's file: read and written in `project-trust.ts`.
 */

/** The user's `projects` and `threads`, pi's trust default, or why the config cannot be read. */
export function readProjectsSettings(home: string, agentDir: string): EnsoProjectsSettingsRead {
  const { parsed, ...file } = readConfigFile(home)
  const common = {
    ...file,
    ...readDefaultProjectTrust(agentDir),
  }
  if (parsed.kind === 'unreadable') return { kind: 'unreadable', ...common, reason: parsed.reason }
  const { projects, threads } = parsed.config
  return { kind: 'ok', ...common, ...(projects === undefined ? {} : { projects }), threads: threads ?? {} }
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
 * kept. A file that is unreadable now, a root the server would refuse, or a result `parseEnsoConfig`
 * refuses, writes nothing.
 */
export function writeProjectsSettings(
  home: string,
  agentDir: string,
  write: EnsoProjectsSettingsWrite,
  condition: WriteCondition,
): ProjectsSettingsWrite {
  const problem = problemOf(write)
  if (problem !== undefined) return { kind: 'refused', reason: `nothing was saved: ${problem}` }
  const roots = write.projects?.roots ?? []
  const threads = prunedThreads(write.threads)
  return writeConfigSections(
    home,
    condition,
    ({ projects: _projects, threads: _threads, ...kept }) => ({
      ...kept,
      ...(roots.length === 0 ? {} : { projects: { roots } }),
      ...(threads === undefined ? {} : { threads }),
    }),
    () => readProjectsSettings(home, agentDir),
  )
}
