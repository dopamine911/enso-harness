import { type Static, Type } from 'typebox'
import { EnsoSecurityConfig } from './session-incident.ts'

/**
 * Settings › Security's wire (#933): `config.json`'s user-only `security` section, read and written
 * by the page, and whether the command judge's key is in the secrets file — never its value.
 *
 * @module
 */

/**
 * `GET /api/settings/security`: the user's `security` as written (absent keys are absent — the page
 * shows each default beside its field), with the file's `ETag`; or why the file cannot be read,
 * since every consumer of it fails closed and the page must say so, not show the defaults. Either
 * way, whether `secrets.env` holds the judge's key — a yes or no, the value is never sent.
 *
 * @group Security settings
 */
export const EnsoSecuritySettingsRead = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('ok'),
      /** The user's `config.json`. */
      path: Type.String(),
      /** Absent when there is no file yet: a save then creates it. */
      etag: Type.Optional(Type.String()),
      security: EnsoSecurityConfig,
      /** The secrets file the judge's key is read from (`ENSO_HOME/secrets.env`). */
      secretsPath: Type.String(),
      judgeKeySet: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('unreadable'),
      path: Type.String(),
      etag: Type.Optional(Type.String()),
      reason: Type.String(),
      secretsPath: Type.String(),
      judgeKeySet: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
])
/** @group Security settings */
export type EnsoSecuritySettingsRead = Static<typeof EnsoSecuritySettingsRead>

/**
 * `PUT /api/settings/security`'s body: the whole `security` section as the page wants it. Every
 * other key of `config.json` is kept as it is on disk; the file is validated as a whole before it
 * replaces the one there.
 *
 * @group Security settings
 */
export const EnsoSecuritySettingsWrite = Type.Object({ security: EnsoSecurityConfig }, { additionalProperties: false })
/** @group Security settings */
export type EnsoSecuritySettingsWrite = Static<typeof EnsoSecuritySettingsWrite>

/**
 * `PUT /api/settings/security/judge-key`'s body: the key to store, or `null` to remove it. The
 * answer says only whether one is set.
 *
 * @group Security settings
 */
export const EnsoJudgeKeyWrite = Type.Object(
  { value: Type.Union([Type.String({ minLength: 1 }), Type.Null()]) },
  { additionalProperties: false },
)
/** @group Security settings */
export type EnsoJudgeKeyWrite = Static<typeof EnsoJudgeKeyWrite>

/** @group Security settings */
export const EnsoJudgeKeyState = Type.Object({ judgeKeySet: Type.Boolean() }, { additionalProperties: false })
