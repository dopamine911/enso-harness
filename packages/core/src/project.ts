import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { lastCustomEntryData } from './prompt-library.ts'
import type { EnsoTranscriptEntry } from './transcript.ts'

/**
 * Projects (#395): the local directories one Enso server runs threads in.
 *
 * ⚠ THE BROWSER NAMES A PROJECT BY ID, NEVER BY PATH, once it is registered. With no sandbox
 * (#24) the directory a session runs in IS its blast radius, so which directories can be
 * projects is bounded by the INSTALL: the launch directory, and directories strictly under a
 * root the user's config declares (`projects.roots`). Registering one is the only request
 * that carries a path, and the server resolves it (`realpath`) before checking it against
 * the roots.
 */

/**
 * The `projects` section of the user's config (`ENSO_HOME/config.json`): the roots a page may register projects
 * under. Absolute, or `~/`-relative to the home directory of whoever runs the server. Absent
 * (or empty) means the launch directory is the only project.
 *
 * @group Projects
 */
export const EnsoProjectsConfig = Type.Object(
  {
    roots: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
/** @group Projects */
export type EnsoProjectsConfig = Static<typeof EnsoProjectsConfig>

/**
 * A project id: sixteen lowercase hex digits, derived from the project's canonical path by
 * the server — stable across restarts, and the same directory is always the same project.
 */
const ENSO_PROJECT_ID_PATTERN = /^[0-9a-f]{16}$/

/** @group Projects */
export function isEnsoProjectId(value: unknown): value is string {
  return typeof value === 'string' && ENSO_PROJECT_ID_PATTERN.test(value)
}

/**
 * The request header a page names a NEW thread's project with. Read only while the thread has
 * no session on disk: once it has one, the session's own directory decides, whatever a page says.
 *
 * @group Projects
 */
export const ENSO_PROJECT_HEADER = 'x-enso-project'

/**
 * One project, as `GET /api/projects` lists it.
 *
 * @group Projects
 */
export const EnsoProject = Type.Object(
  {
    projectId: Type.String(),
    /** The directory's name unless one was given at registration. */
    title: Type.String(),
    /** The canonical path — shown so a person can tell two projects apart; never sent back. */
    path: Type.String(),
    /** `missing-dir` when the directory is gone: its threads stay readable, and no new one starts there. */
    status: Type.Union([Type.Literal('ok'), Type.Literal('missing-dir')]),
    /** The directory the server was launched in: always first, and it cannot be removed. */
    launch: Type.Boolean(),
  },
  { additionalProperties: false },
)
/** @group Projects */
export type EnsoProject = Static<typeof EnsoProject>

/**
 * `POST /api/projects`: register a directory under a declared root.
 *
 * @group Projects
 */
export const EnsoProjectRegistration = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
/** @group Projects */
export type EnsoProjectRegistration = Static<typeof EnsoProjectRegistration>

/**
 * `.enso/projects.json`: the projects registered from a page, as the server keeps them. The id
 * is not stored — it is the canonical path's (`EnsoProject.projectId`), so it cannot drift.
 *
 * @group Projects
 */
export const EnsoProjectsState = Type.Object(
  {
    projects: Type.Array(
      Type.Object(
        { path: Type.String({ minLength: 1 }), title: Type.Optional(Type.String({ minLength: 1 })) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Projects */
export type EnsoProjectsState = Static<typeof EnsoProjectsState>

/**
 * One directory a page may browse into while adding a project (#395): only directories inside a
 * declared root appear, resolved (a symlink that leads out is left out), never a hidden one.
 *
 * @group Projects
 */
export const EnsoDirectoryEntry = Type.Object(
  {
    name: Type.String(),
    /** Canonical — what a page registers, or browses next. */
    path: Type.String(),
    /** Present when it already is a project. */
    projectId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Projects */
export type EnsoDirectoryEntry = Static<typeof EnsoDirectoryEntry>

/**
 * `GET /api/projects/browse[?path=…]`: the declared roots (no `path`), or one directory inside them
 * and the directories under it.
 *
 * @group Projects
 */
export const EnsoDirectoryListing = Type.Object(
  {
    /** The directory listed; `null` for the list of roots. */
    path: Type.Union([Type.String(), Type.Null()]),
    /** Where "up" goes: the directory above while it is inside a root; `null` at a root (up is the list of roots). */
    parent: Type.Union([Type.String(), Type.Null()]),
    /** This directory may be added — strictly under a root; a root itself is not. */
    registrable: Type.Boolean(),
    directories: Type.Array(EnsoDirectoryEntry),
    /** More directories than a listing holds were there; the first ones by name are listed. */
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
)
/** @group Projects */
export type EnsoDirectoryListing = Static<typeof EnsoDirectoryListing>

/**
 * A thread's own trust in its project (#502): the web's "Trust this thread" answer, recorded on the
 * thread's branch so resuming it is trusted without asking, while a NEW thread in the same project
 * asks again. The project-wide answer ("Trust project") is pi's `trust.json` instead, which terminal
 * pi reads too. A fork copies the branch, and with it this trust.
 *
 * @group Project trust
 */
export const ENSO_PROJECT_TRUST_ENTRY = 'enso-project-trust' as const

const ProjectTrustRecord = Compile(Type.Object({ trusted: Type.Literal(true) }, { additionalProperties: false }))

/**
 * Whether the branch records "Trust this thread". Only the last record counts; one that does not
 * read is no trust (fail closed).
 *
 * @group Project trust
 */
export function threadTrustsProject(branch: readonly EnsoTranscriptEntry[]): boolean {
  return ProjectTrustRecord.Check(lastCustomEntryData(branch, ENSO_PROJECT_TRUST_ENTRY))
}

/**
 * The record "Trust this thread" appends.
 *
 * @group Project trust
 */
export const THREAD_PROJECT_TRUST = { trusted: true } as const

/**
 * The environment variable the web host sets to `1` before its first session (#502): project trust
 * is decided by the host — asked before a run, applied to pi, the session reloaded — so the
 * harness's own `.enso/config.json` question stays out of the way and follows pi's answer. A process
 * flag because the host runs its sessions in-process, the way `PI_CODING_AGENT_DIR` is one.
 *
 * @group Project trust
 */
export const ENSO_PROJECT_TRUST_BY_HOST = 'ENSO_PROJECT_TRUST_BY_HOST'
