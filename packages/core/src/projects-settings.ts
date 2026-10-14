import { type Static, Type } from 'typebox'
import { EnsoThreadsConfig } from './config.ts'
import { EnsoProjectsConfig } from './project.ts'

/**
 * Settings › Projects & threads' wire (#934): `config.json`'s user-only `projects` (the roots fence)
 * and the user tier of `threads` (a new thread's tree), read and written by the page; and pi's
 * `defaultProjectTrust` in the agent dir's `settings.json` — the trust of a project nobody decided.
 *
 * @module
 */

/**
 * What a project nobody decided gets (pi's `defaultProjectTrust`): asked at its first run, trusted,
 * or not trusted. pi reads an absent key as `ask`.
 *
 * @group Projects settings
 */
export const EnsoDefaultProjectTrust = Type.Union([Type.Literal('ask'), Type.Literal('always'), Type.Literal('never')])
/** @group Projects settings */
export type EnsoDefaultProjectTrust = Static<typeof EnsoDefaultProjectTrust>

/**
 * `GET /api/settings/projects`: the user's `projects` and `threads` as written (absent keys absent —
 * the page shows each default beside its field), with the file's `ETag`; or why the file cannot be
 * read, since every consumer of it fails closed. Either way, pi's settings file and the trust it
 * gives an undecided project.
 *
 * @group Projects settings
 */
export const EnsoProjectsSettingsRead = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('ok'),
      /** The user's `config.json`. */
      path: Type.String(),
      /** Absent when there is no file yet: a save then creates it. */
      etag: Type.Optional(Type.String()),
      projects: Type.Optional(EnsoProjectsConfig),
      threads: EnsoThreadsConfig,
      /** pi's settings file in the agent directory, where `defaultProjectTrust` lives. */
      trustPath: Type.String(),
      defaultProjectTrust: EnsoDefaultProjectTrust,
      /** Why pi's settings file cannot be read, when it cannot: the trust then reads `ask`, and a Set is refused. */
      trustUnreadable: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('unreadable'),
      path: Type.String(),
      etag: Type.Optional(Type.String()),
      reason: Type.String(),
      trustPath: Type.String(),
      defaultProjectTrust: EnsoDefaultProjectTrust,
      trustUnreadable: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
])
/** @group Projects settings */
export type EnsoProjectsSettingsRead = Static<typeof EnsoProjectsSettingsRead>

/**
 * `PUT /api/settings/projects`'s body: `projects` and `threads` whole, as the page wants them (an
 * absent `projects` removes it: no fence). Every other key of `config.json` is kept as it is on disk;
 * the file is validated as a whole before it replaces the one there.
 *
 * @group Projects settings
 */
export const EnsoProjectsSettingsWrite = Type.Object(
  { projects: Type.Optional(EnsoProjectsConfig), threads: EnsoThreadsConfig },
  { additionalProperties: false },
)
/** @group Projects settings */
export type EnsoProjectsSettingsWrite = Static<typeof EnsoProjectsSettingsWrite>

/**
 * `PUT /api/settings/projects/trust`'s body and answer: the trust an undecided project gets.
 *
 * @group Projects settings
 */
export const EnsoDefaultProjectTrustState = Type.Object(
  { defaultProjectTrust: EnsoDefaultProjectTrust },
  { additionalProperties: false },
)
