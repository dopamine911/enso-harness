import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { closedObject, NonEmptyString } from './closed-schema.ts'
import { lastCustomEntryData } from './prompt-library.ts'
import type { HostCommandOption } from './thread-runtime.ts'
import type { EnsoTranscriptEntry } from './transcript.ts'

/**
 * Models as the person sets them up (#904): favorite models, providers hidden from the picker,
 * ROLES — a name for a model and an effort, with fallbacks in order — and PRESETS, a named snapshot
 * of every role and the default effort. OMP's `modelRoles` and model presets are the reference
 * (`models.md`, § "Model roles", "Model presets"); pi has no roles, so these are Enso's own.
 *
 * ⚠ USER-ONLY (#904 decision 1). The section lives in the user's `ENSO_HOME/config.json`, read and
 * written by the server from that file alone: a project's own `.enso/config.json` is never read for
 * it, so a checkout cannot change which model a role resolves to.
 *
 * ⚠ FAVORITES ARE ENSO'S OWN LIST (decision 2), not pi's `enabledModels`: pi's model cycling in
 * the terminal is untouched.
 *
 * A model is named by its option id, `provider/id` (`modelOptionId`), joined and never split.
 */

/**
 * The name a role is called by: lower-case letters, digits and `-`, a letter first — what can be
 * typed and said (`review`, `quick`, `deep-2`).
 *
 * @group Model roles
 */
export const MODEL_ROLE_NAME_SOURCE = '^[a-z][a-z0-9-]{0,31}$'

/**
 * The role new threads start on (#904): the launch panel preselects it, in place of pi's own
 * `defaultModel` and `defaultThinkingLevel`, when it is set.
 *
 * @group Model roles
 */
export const ENSO_DEFAULT_ROLE = 'default'

/**
 * The roles Settings offers to start from: `default`, and two suggestions. None is required.
 *
 * @group Model roles
 */
export const SUGGESTED_MODEL_ROLES: readonly string[] = [ENSO_DEFAULT_ROLE, 'quick', 'deep']

/** A model's option id and, optionally, its effort: a role's own, and each fallback's. */
const modelTarget = { model: NonEmptyString, effort: Type.Optional(NonEmptyString) }

/**
 * One model a role may run: the model's option id and, optionally, its effort. An effort the model
 * does not offer is clamped to one it does (`clampEffort`), and shown clamped.
 *
 * @group Model roles
 */
export const EnsoModelTarget = closedObject(modelTarget)
/** @group Model roles */
export type EnsoModelTarget = Static<typeof EnsoModelTarget>

/**
 * A role: its model and effort, then fallbacks in order — the first available one runs when the
 * model is not (logged out, gone from the catalogue). None available, the role is refused.
 *
 * @group Model roles
 */
export const EnsoModelRole = closedObject({ ...modelTarget, fallbacks: Type.Optional(Type.Array(EnsoModelTarget)) })
/** @group Model roles */
export type EnsoModelRole = Static<typeof EnsoModelRole>

/**
 * Every role, by name.
 *
 * @group Model roles
 */
export const EnsoModelRoles = Type.Record(Type.String({ pattern: MODEL_ROLE_NAME_SOURCE }), EnsoModelRole, {
  additionalProperties: false,
})

/**
 * A preset (#904 decision 4): every role and the default effort, saved under a name and switched in
 * one step. Switching REPLACES the roles: one the preset leaves out is cleared, as in OMP.
 *
 * @group Model roles
 */
export const EnsoModelPreset = closedObject({ roles: EnsoModelRoles, defaultEffort: Type.Optional(NonEmptyString) })
/** @group Model roles */
export type EnsoModelPreset = Static<typeof EnsoModelPreset>

/**
 * The `models` section of the user's config (#904). Every key optional; absent is none.
 *
 * - `favorites`: model option ids, in the person's order — the picker's Favorites group.
 * - `hiddenProviders`: provider ids kept out of the picker, still logged in.
 * - `roles`: by name.
 * - `defaultEffort`: the effort a role runs at when it names none (else the model's own default).
 * - `presets`: by name.
 *
 * @group Model roles
 */
export const EnsoModelsConfig = closedObject({
  favorites: Type.Optional(Type.Array(NonEmptyString)),
  hiddenProviders: Type.Optional(Type.Array(NonEmptyString)),
  roles: Type.Optional(EnsoModelRoles),
  defaultEffort: Type.Optional(NonEmptyString),
  presets: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 64 }), EnsoModelPreset)),
})
/** @group Model roles */
export type EnsoModelsConfig = Static<typeof EnsoModelsConfig>

const modelsConfigValidator = Compile(EnsoModelsConfig)

/**
 * A `models` section as written, or `undefined` when it does not read as one.
 *
 * @group Model roles
 */
export function readEnsoModelsConfig(data: unknown): EnsoModelsConfig | undefined {
  return modelsConfigValidator.Check(data) ? data : undefined
}

/**
 * `GET` and `PUT /api/models/settings` (#904): the section, and the file it is kept in. A `PUT`
 * body is an `EnsoModelsConfig`, the whole section; the answer is this, as written.
 *
 * @group Model roles
 */
export const EnsoModelsSettings = closedObject({ path: NonEmptyString, models: EnsoModelsConfig })
/** @group Model roles */
export type EnsoModelsSettings = Static<typeof EnsoModelsSettings>

/**
 * pi's thinking levels, lowest first (`EXTENDED_THINKING_LEVELS`, pi-ai `models.js`): the order an
 * effort is clamped along.
 *
 * @group Model roles
 */
export const THINKING_LEVEL_ORDER: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * An effort clamped to the levels a model offers, by pi's own rule (`clampThinkingLevel`): the level
 * itself when offered; else the next one up that is; else the next one down; else the model's
 * first. A model that names no levels takes the effort as asked.
 *
 * @group Model roles
 */
export function clampEffort(requested: string, levels: readonly string[]): string {
  if (levels.length === 0 || levels.includes(requested)) return requested
  const at = THINKING_LEVEL_ORDER.indexOf(requested)
  if (at === -1) return levels[0] ?? requested
  const up = THINKING_LEVEL_ORDER.slice(at + 1).find((level) => levels.includes(level))
  if (up !== undefined) return up
  const down = THINKING_LEVEL_ORDER.slice(0, at)
    .toReversed()
    .find((level) => levels.includes(level))
  return down ?? levels[0] ?? requested
}

/**
 * What a role resolves to now (#904), against the models on offer:
 *
 * - `resolved`: the model to run (`model`, an option id) and its effort — `requestedEffort` what the
 *   role asked, `effort` what runs, `clamped` when the two differ. `fallback` when the role's own
 *   model is not available: `notice` says which was skipped and why.
 * - `refused`: no model of the role is available; `reason` says each one's reason. Never a silent
 *   substitute.
 *
 * @group Model roles
 */
export type EnsoRoleResolution =
  | {
      readonly kind: 'resolved'
      readonly role: string
      readonly model: string
      readonly modelName: string
      readonly effort: string | undefined
      readonly requestedEffort: string | undefined
      readonly clamped: boolean
      readonly fallback: boolean
      readonly notice: string | undefined
    }
  | { readonly kind: 'refused'; readonly role: string; readonly reason: string }

/** Why a model is not available, or `undefined` when it is. */
function unavailableReason(model: string, options: readonly HostCommandOption[]): string | undefined {
  const option = options.find((candidate) => candidate.id === model)
  if (option === undefined) return 'not in the catalogue'
  if (option.loggedIn === false) return `${option.providerName ?? option.detail ?? 'its provider'} is not logged in`
  return undefined
}

/**
 * Resolve the role called `name` in `models` against the `/model` options on offer (#904): its
 * model, else its first available fallback, with the effort clamped to that model's levels; or why
 * not. The effort is the target's own, else `defaultEffort`, else the level the model runs at once
 * chosen (`defaultThinkingLevel`, pi's settings).
 *
 * @group Model roles
 */
export function resolveModelRole(
  name: string,
  models: EnsoModelsConfig,
  options: readonly HostCommandOption[],
): EnsoRoleResolution {
  const role = models.roles?.[name]
  if (role === undefined) return { kind: 'refused', role: name, reason: `no role is named ${name}` }
  const targets: EnsoModelTarget[] = [
    { model: role.model, ...(role.effort === undefined ? {} : { effort: role.effort }) },
    ...(role.fallbacks ?? []),
  ]
  const skipped: string[] = []
  for (const target of targets) {
    const reason = unavailableReason(target.model, options)
    if (reason !== undefined) {
      skipped.push(`${target.model} (${reason})`)
      continue
    }
    const option = options.find((candidate) => candidate.id === target.model)
    const requestedEffort = target.effort ?? models.defaultEffort ?? option?.defaultThinkingLevel
    const effort =
      requestedEffort === undefined ? undefined : clampEffort(requestedEffort, option?.thinkingLevels ?? [])
    const fallback = skipped.length > 0
    return {
      kind: 'resolved',
      role: name,
      model: target.model,
      modelName: option?.label ?? target.model,
      effort,
      requestedEffort,
      clamped: effort !== requestedEffort,
      fallback,
      notice: fallback ? `${skipped.join(', ')} unavailable; using the fallback ${target.model}` : undefined,
    }
  }
  return { kind: 'refused', role: name, reason: `role ${name} has no model available: ${skipped.join(', ')}` }
}

/**
 * The `customType` a thread's role is recorded under in pi's log (#904 decision 5).
 *
 * @group Model roles
 */
export const ENSO_MODEL_ROLE_ENTRY = 'enso-model-role' as const

/**
 * What a thread started with a role RECORDS (#904 decision 5): the role's name and the model and
 * effort it resolved to then — so a reload and a fork say what the thread ran with, and a role
 * edited later rewrites nothing. `fallback` when the role's own model was unavailable. A record of
 * `null` ends it: the model or effort was changed by hand since.
 *
 * @group Model roles
 */
export const EnsoThreadModelRole = closedObject({
  role: Type.String({ pattern: MODEL_ROLE_NAME_SOURCE }),
  provider: NonEmptyString,
  modelId: NonEmptyString,
  thinkingLevel: Type.Optional(NonEmptyString),
  fallback: Type.Optional(Type.Boolean()),
})
/** @group Model roles */
export type EnsoThreadModelRole = Static<typeof EnsoThreadModelRole>

const threadModelRoleValidator = Compile(EnsoThreadModelRole)

/**
 * One `enso-model-role` entry's data as a view shows it: the record, or `null` — none, ended, or
 * not readable as one.
 *
 * @group Model roles
 */
export function threadModelRoleOf(data: unknown): EnsoThreadModelRole | null {
  return threadModelRoleValidator.Check(data) ? data : null
}

/**
 * The role the branch runs under (#904): its last `enso-model-role` entry's, root to leaf, or
 * `null`. A fork's branch carries its source's records, so a fork says it too.
 *
 * @group Model roles
 */
export function threadModelRole(branch: readonly EnsoTranscriptEntry[]): EnsoThreadModelRole | null {
  return threadModelRoleOf(lastCustomEntryData(branch, ENSO_MODEL_ROLE_ENTRY))
}
