import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import {
  EnsoIncidentReport,
  EnsoIncidentReportMissing,
  readEnsoIncidentReport,
  readEnsoIncidentReportMissing,
} from './incident-report.ts'
import {
  DEFAULT_RISK_THRESHOLDS,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  type EnsoRiskThresholds,
  EnsoSecuritySignal,
} from './session-risk.ts'
import { WEB_FETCH_TOOL_NAME } from './web-fetch.ts'
import { WEB_SEARCH_TOOL_NAME } from './web-search.ts'

/**
 * A session's security incidents (#466, phase 3 of #189): what reaching `incident` opens, what it
 * suspends, and a human's resolution of it. Everything here is a record in the session file, and
 * the state is a fold over those records: the guard folds it live and rebuilds it on
 * `session_start`, the server folds it for the thread's snapshot and the resolve route's checks,
 * and the page folds the same entries as they arrive.
 *
 * ⚠ SERVER-AUTHORITATIVE. A suspension is lifted only by a resolution entry, and only the host's
 * resolve route appends one — no tool, host command or browser toggle writes it. A restart or a
 * resume rebuilds the same suspension from the same entries.
 *
 * ⚠ THE RECORDS ARE NOT TAMPER-PROOF. The guards are the whole boundary (#24, #397 closed): before
 * an incident and after a resume, `bash` can edit the session file. `protected-records` refuses a
 * shell command naming it, which makes an edit harder and visible as a signal, not impossible. The
 * hash chain that would make an edit to one file evident is deferred (#526).
 *
 * @group Session incident
 */

/**
 * The tool families an incident suspends (#466): everything but reading. A read, a search or a
 * listing stays available so the session can still be diagnosed.
 *
 * @group Session incident
 */
export const ENSO_TOOL_FAMILIES = ['execute', 'network', 'write'] as const

/** @group Session incident */
export type EnsoToolFamily = (typeof ENSO_TOOL_FAMILIES)[number]

/**
 * Each family's tools, by pi's lower-case name. A tool in none of them is never suspended.
 *
 * @group Session incident
 */
export const ENSO_FAMILY_TOOLS: Readonly<Record<EnsoToolFamily, readonly string[]>> = {
  execute: ['bash', 'powershell'],
  network: [WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME],
  write: ['write', 'edit'],
}

/**
 * The family a tool belongs to, by its name in any case; undefined for a reader or a tool of none.
 *
 * @group Session incident
 */
export function toolFamilyOf(toolName: string): EnsoToolFamily | undefined {
  const name = toolName.toLowerCase()
  return ENSO_TOOL_FAMILIES.find((family) => ENSO_FAMILY_TOOLS[family].includes(name))
}

const ToolFamily = Type.Unsafe<EnsoToolFamily>(Type.Union(ENSO_TOOL_FAMILIES.map((family) => Type.Literal(family))))
const Families = Type.Array(ToolFamily, { uniqueItems: true })

/**
 * The `customType` of an incident's opening, appended by the guards extension when the session's
 * risk reaches `incident` (or by the host, when a fork or continue inherits an open one).
 *
 * @group Session incident
 */
export const ENSO_INCIDENT_OPENED_ENTRY = 'enso-incident-opened' as const

/**
 * An incident's opening: its id; the signals the risk rests on, as recorded (each names its call
 * and the calls before it, by id); whether it halted — `security.incidents.halt`, off by default —
 * and so which families it suspended; and, for an inherited one, the thread and incident it came
 * from. The record is never edited: a resolution is another record.
 *
 * @group Session incident
 */
export const EnsoIncidentOpened = Type.Object(
  {
    incidentId: Type.String({ minLength: 1 }),
    signals: Type.Array(EnsoSecuritySignal),
    halted: Type.Boolean(),
    suspended: Families,
    inheritedFrom: Type.Optional(
      Type.Object(
        { threadId: Type.String({ minLength: 1 }), incidentId: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoIncidentOpened = Static<typeof EnsoIncidentOpened>

/**
 * What the human judged the incident to be.
 *
 * @group Session incident
 */
export const ENSO_INCIDENT_CLASSIFICATIONS = [
  'false-positive',
  'agent-error',
  'policy-ambiguity',
  'probable-bypass',
  'confirmed-bypass',
] as const

/** @group Session incident */
export type EnsoIncidentClassification = (typeof ENSO_INCIDENT_CLASSIFICATIONS)[number]

/**
 * What happens next: every family back, some kept suspended, or the thread ended — every family
 * suspended for good and no prompt admitted.
 *
 * @group Session incident
 */
export const ENSO_INCIDENT_OUTCOMES = ['resume', 'resume-with-restrictions', 'end-thread'] as const

/** @group Session incident */
export type EnsoIncidentOutcome = (typeof ENSO_INCIDENT_OUTCOMES)[number]

const Classification = Type.Unsafe<EnsoIncidentClassification>(
  Type.Union(ENSO_INCIDENT_CLASSIFICATIONS.map((classification) => Type.Literal(classification))),
)
const Outcome = Type.Unsafe<EnsoIncidentOutcome>(
  Type.Union(ENSO_INCIDENT_OUTCOMES.map((outcome) => Type.Literal(outcome))),
)

/**
 * The resolve route's body: the classification, the outcome, and — for `resume-with-restrictions`
 * only — the families that stay suspended.
 *
 * @group Session incident
 */
export const EnsoIncidentResolution = Type.Object(
  { classification: Classification, outcome: Outcome, restricted: Type.Optional(Families) },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoIncidentResolution = Static<typeof EnsoIncidentResolution>

/**
 * A resolution's record: the incident, the human's judgement and choice, and the families that
 * stay suspended after it — none on `resume`, the restricted ones, or all three on `end-thread`.
 *
 * @group Session incident
 */
export const EnsoIncidentResolved = Type.Object(
  { incidentId: Type.String({ minLength: 1 }), classification: Classification, outcome: Outcome, suspended: Families },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoIncidentResolved = Static<typeof EnsoIncidentResolved>

const openedValidator = Compile(EnsoIncidentOpened)
const resolvedValidator = Compile(EnsoIncidentResolved)

/**
 * The opening a custom entry records, or undefined when it is another's or malformed.
 *
 * @group Session incident
 */
export function readEnsoIncidentOpened(customType: string, data: unknown): EnsoIncidentOpened | undefined {
  return customType === ENSO_INCIDENT_OPENED_ENTRY && openedValidator.Check(data) ? data : undefined
}

/**
 * The resolution a custom entry records, or undefined when it is another's or malformed.
 *
 * @group Session incident
 */
export function readEnsoIncidentResolved(customType: string, data: unknown): EnsoIncidentResolved | undefined {
  return customType === ENSO_INCIDENT_RESOLVED_ENTRY && resolvedValidator.Check(data) ? data : undefined
}

/**
 * One incident as the thread shows it: its opening, every resolution of it in order (the last one
 * stands; a resumed-with-restrictions incident can be resolved again to lift them), and the
 * agent's report — or that none was filed (#467). The report sits beside the record, never in it.
 *
 * @group Session incident
 */
export const EnsoIncidentRecord = Type.Object(
  {
    opened: EnsoIncidentOpened,
    resolutions: Type.Array(EnsoIncidentResolved),
    report: Type.Optional(EnsoIncidentReport),
    reportMissing: Type.Optional(EnsoIncidentReportMissing),
  },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoIncidentRecord = Static<typeof EnsoIncidentRecord>

/**
 * `config.json`'s `security` section (#466). **User-only**: a trusted project's `security` is
 * dropped with a notice (`session-config.ts`), so a checkout cannot switch halting off or raise
 * the thresholds its own session is measured against.
 *
 * - `incidents.halt` — whether an incident suspends tools (default `false`: it only alerts, until
 *   the thresholds are tuned on real sessions, #468);
 * - `incidents.windowCalls`, `highAtSignals`, `highAtKinds`, `incidentAtSignals` — the risk fold's
 *   thresholds (`DEFAULT_RISK_THRESHOLDS` when absent).
 *
 * @group Session incident
 */
export const EnsoSecurityConfig = Type.Object(
  {
    incidents: Type.Optional(
      Type.Object(
        {
          halt: Type.Optional(Type.Boolean()),
          windowCalls: Type.Optional(Type.Integer({ minimum: 1 })),
          highAtSignals: Type.Optional(Type.Integer({ minimum: 1 })),
          highAtKinds: Type.Optional(Type.Integer({ minimum: 1 })),
          incidentAtSignals: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoSecurityConfig = Static<typeof EnsoSecurityConfig>

/**
 * What the config asks of incidents: whether they halt, and the risk thresholds — the one reading
 * the guard and the server both use, so the live level and the replayed one agree.
 *
 * @group Session incident
 */
export interface EnsoIncidentPolicy {
  readonly halt: boolean
  readonly thresholds: EnsoRiskThresholds
}

/** @group Session incident */
export function incidentPolicyOf(security: EnsoSecurityConfig | undefined): EnsoIncidentPolicy {
  const incidents = security?.incidents
  return {
    halt: incidents?.halt ?? false,
    thresholds: {
      windowCalls: incidents?.windowCalls ?? DEFAULT_RISK_THRESHOLDS.windowCalls,
      highAtSignals: incidents?.highAtSignals ?? DEFAULT_RISK_THRESHOLDS.highAtSignals,
      highAtKinds: incidents?.highAtKinds ?? DEFAULT_RISK_THRESHOLDS.highAtKinds,
      incidentAtSignals: incidents?.incidentAtSignals ?? DEFAULT_RISK_THRESHOLDS.incidentAtSignals,
    },
  }
}

/**
 * The session event-bus channel the host emits a resolution on, right after appending its record,
 * so the live guard lifts the suspension without a reload. The payload is the
 * `EnsoIncidentResolved` record; the guard applies it with `sessionIncidentsStep`, as it would the
 * entry on replay.
 *
 * @group Session incident
 */
export const ENSO_INCIDENT_RESOLVED_CHANNEL = 'enso:incident-resolved' as const

/**
 * A session's incidents, folded: every incident in order, the families suspended now, and whether
 * a resolution ended the thread. What the snapshot carries and the page and the guard hold.
 *
 * @group Session incident
 */
export const EnsoSessionIncidents = Type.Object(
  { incidents: Type.Array(EnsoIncidentRecord), suspended: Families, ended: Type.Boolean() },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoSessionIncidents = Static<typeof EnsoSessionIncidents>

/** @group Session incident */
export const NO_SESSION_INCIDENTS: EnsoSessionIncidents = { incidents: [], suspended: [], ended: false }

/**
 * The open incident — the last one, while nothing has resolved it — or undefined.
 *
 * @group Session incident
 */
export function openIncidentOf(state: EnsoSessionIncidents): EnsoIncidentRecord | undefined {
  const last = state.incidents.at(-1)
  return last !== undefined && last.resolutions.length === 0 ? last : undefined
}

/**
 * The incident whose report the agent owes now (#467): open, halted, and neither filed nor
 * recorded missing. While there is one, the guard lets only the report tool through.
 *
 * @group Session incident
 */
export function reportOwedOf(state: EnsoSessionIncidents): EnsoIncidentRecord | undefined {
  const open = openIncidentOf(state)
  return open?.opened.halted === true && open.report === undefined && open.reportMissing === undefined
    ? open
    : undefined
}

/**
 * The record with its report — or its absence — attached, once: the first wins, and a report for
 * an incident that already has either is not one (#467: the report cannot change the record).
 */
function withReport(state: EnsoSessionIncidents, customType: string, data: unknown): EnsoSessionIncidents | undefined {
  const report = readEnsoIncidentReport(customType, data)
  const missing = report === undefined ? readEnsoIncidentReportMissing(customType, data) : undefined
  const incidentId = report?.incidentId ?? missing?.incidentId
  if (incidentId === undefined) return undefined
  const index = state.incidents.findIndex((record) => record.opened.incidentId === incidentId)
  const record = state.incidents[index]
  if (record === undefined || record.report !== undefined || record.reportMissing !== undefined) return state
  let attached: EnsoIncidentRecord = record
  if (report !== undefined) attached = { ...record, report }
  else if (missing !== undefined) attached = { ...record, reportMissing: missing }
  return { ...state, incidents: state.incidents.map((each, at) => (at === index ? attached : each)) }
}

/** The families in either list, in `ENSO_TOOL_FAMILIES` order. */
function unionOf(left: readonly EnsoToolFamily[], right: readonly EnsoToolFamily[]): EnsoToolFamily[] {
  return ENSO_TOOL_FAMILIES.filter((family) => left.includes(family) || right.includes(family))
}

/**
 * One step of the fold: the state after a custom entry. Any entry but an opening or a resolution
 * leaves it as it was.
 *
 * - An opening adds its families to whatever an earlier resolution kept suspended. After an ended
 *   thread, or while one is open, a second opening is not one: the guard never writes it, and a
 *   hand-edited file does not get two.
 * - A resolution of the LAST incident sets the suspension to what it keeps. A resolution of an
 *   earlier one, or after the thread ended, changes nothing.
 *
 * @group Session incident
 */
export function sessionIncidentsStep(
  state: EnsoSessionIncidents,
  customType: string,
  data: unknown,
): EnsoSessionIncidents {
  if (state.ended) return state
  const reported = withReport(state, customType, data)
  if (reported !== undefined) return reported
  const opened = readEnsoIncidentOpened(customType, data)
  if (opened !== undefined) {
    if (openIncidentOf(state) !== undefined) return state
    return {
      incidents: [...state.incidents, { opened, resolutions: [] }],
      suspended: unionOf(state.suspended, opened.suspended),
      ended: false,
    }
  }
  const resolved = readEnsoIncidentResolved(customType, data)
  const last = state.incidents.at(-1)
  if (resolved === undefined || last === undefined || last.opened.incidentId !== resolved.incidentId) return state
  return {
    incidents: [...state.incidents.slice(0, -1), { ...last, resolutions: [...last.resolutions, resolved] }],
    suspended: resolved.outcome === 'end-thread' ? [...ENSO_TOOL_FAMILIES] : unionOf([], resolved.suspended),
    ended: resolved.outcome === 'end-thread',
  }
}

/**
 * The fold over a branch's custom entries, `{ customType, data }` in order — pi's raw entries and
 * Enso's transcript both reduce to that.
 *
 * @group Session incident
 */
export function sessionIncidentsOf(
  entries: readonly { readonly customType: string; readonly data: unknown }[],
): EnsoSessionIncidents {
  return entries.reduce(
    (state, entry) => sessionIncidentsStep(state, entry.customType, entry.data),
    NO_SESSION_INCIDENTS,
  )
}

/**
 * Why a resolution cannot be recorded, or undefined when it can — the resolve route's one check, so
 * the page's form and the server refuse the same things.
 *
 * - The incident must be the thread's last one, and the thread not already ended.
 * - An open incident takes any outcome; a resolved one can be resolved again only to change what
 *   stays suspended (it was resumed with restrictions, or resumed), never to reopen it.
 * - `restricted` names at least one family for `resume-with-restrictions`, and is absent otherwise.
 *
 * @group Session incident
 */
export function incidentResolutionRefusal(
  state: EnsoSessionIncidents,
  incidentId: string,
  resolution: EnsoIncidentResolution,
): string | undefined {
  if (state.ended) return 'the thread was ended by an earlier resolution'
  const last = state.incidents.at(-1)
  if (last === undefined || last.opened.incidentId !== incidentId) {
    return state.incidents.some((record) => record.opened.incidentId === incidentId)
      ? 'a later incident supersedes this one'
      : 'no such incident on this thread'
  }
  if (resolution.outcome === 'resume-with-restrictions') {
    if (resolution.restricted === undefined || resolution.restricted.length === 0) {
      return 'resume-with-restrictions names the families that stay suspended'
    }
  } else if (resolution.restricted !== undefined) {
    return `only resume-with-restrictions takes restricted families, not ${resolution.outcome}`
  }
  return undefined
}

/**
 * The record a valid resolution appends.
 *
 * @group Session incident
 */
export function incidentResolvedOf(incidentId: string, resolution: EnsoIncidentResolution): EnsoIncidentResolved {
  const { classification, outcome } = resolution
  return { incidentId, classification, outcome, suspended: suspendedAfter(resolution) }
}

/** What stays suspended after a resolution: all three families, none, or the restricted ones. */
function suspendedAfter(resolution: EnsoIncidentResolution): EnsoToolFamily[] {
  if (resolution.outcome === 'end-thread') return [...ENSO_TOOL_FAMILIES]
  if (resolution.outcome === 'resume') return []
  return unionOf([], resolution.restricted ?? [])
}
