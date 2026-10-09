import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { EnsoJudgeConfig } from './command-judge.ts'
import { ENSO_GUARD_DENIAL_ENTRY } from './guard.ts'
import {
  EnsoIncidentReport,
  EnsoIncidentReportMissing,
  readEnsoIncidentReport,
  readEnsoIncidentReportMissing,
} from './incident-report.ts'
import {
  DEFAULT_RISK_THRESHOLDS,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_PERMISSION_DENIAL_ENTRY,
  ENSO_SECURITY_SIGNAL_ENTRY,
  type EnsoRiskEvent,
  type EnsoRiskThresholds,
  EnsoSecuritySignal,
  INITIAL_SESSION_RISK,
  riskEventsOfTranscript,
  sessionRiskStep,
} from './session-risk.ts'
import { EnsoTranscriptCustom, type EnsoTranscriptEntry } from './transcript.ts'
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
 * and so which families it suspended; the model the run was on (#468: incidents counted per
 * model), absent when the session named none; and, for an inherited one, the thread and incident
 * it came from. The record is never edited: a resolution is another record.
 *
 * @group Session incident
 */
export const EnsoIncidentOpened = Type.Object(
  {
    incidentId: Type.String({ minLength: 1 }),
    signals: Type.Array(EnsoSecuritySignal),
    halted: Type.Boolean(),
    suspended: Families,
    model: Type.Optional(Type.String({ minLength: 1 })),
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
 *   thresholds (`DEFAULT_RISK_THRESHOLDS` when absent);
 * - `judge.backend` — the command judge (#469): `off` (the default) or `jev`.
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
    judge: Type.Optional(EnsoJudgeConfig),
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
    (state, customEntry) => sessionIncidentsStep(state, customEntry.customType, customEntry.data),
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

/**
 * How a replay's opening compares with the branch's record (#468): the guard recorded one on the
 * same call (`same`), the replay opens one the guard did not (`would-open`), or the guard recorded
 * one the replay does not open (`would-miss`).
 *
 * @group Session incident
 */
export const ENSO_INCIDENT_REPLAY_VERDICTS = ['same', 'would-open', 'would-miss'] as const

/** @group Session incident */
export type EnsoIncidentReplayVerdict = (typeof ENSO_INCIDENT_REPLAY_VERDICTS)[number]

/**
 * One opening, replayed or recorded: the call that tipped the risk into `incident` (the last
 * signal's call), the signals it rests on, and the recorded id when the guard recorded one.
 *
 * @group Session incident
 */
export const EnsoIncidentReplayRow = Type.Object(
  {
    verdict: Type.Unsafe<EnsoIncidentReplayVerdict>(
      Type.Union(ENSO_INCIDENT_REPLAY_VERDICTS.map((verdict) => Type.Literal(verdict))),
    ),
    trigger: Type.String({ minLength: 1 }),
    signals: Type.Array(EnsoSecuritySignal),
    incidentId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoIncidentReplayRow = Static<typeof EnsoIncidentReplayRow>

/**
 * One thread's incidents for `bun run incidents` (#468), from `GET /api/threads/:id/incidents`:
 * each incident's record with the custom entries it rests on, as our transcript records them — the
 * stored `data` untouched (`incidentEntriesOf`) — and the branch replayed under `thresholds` — the server's own unless
 * the request named others.
 *
 * @group Session incident
 */
export const EnsoThreadIncidents = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
    live: Type.Boolean(),
    thresholds: Type.Object(
      {
        windowCalls: Type.Integer({ minimum: 1 }),
        highAtSignals: Type.Integer({ minimum: 1 }),
        highAtKinds: Type.Integer({ minimum: 1 }),
        incidentAtSignals: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    incidents: Type.Array(
      Type.Object(
        { record: EnsoIncidentRecord, entries: Type.Array(EnsoTranscriptCustom) },
        { additionalProperties: false },
      ),
    ),
    replay: Type.Array(EnsoIncidentReplayRow),
  },
  { additionalProperties: false },
)
/** @group Session incident */
export type EnsoThreadIncidents = Static<typeof EnsoThreadIncidents>

const threadIncidentsValidator = Compile(EnsoThreadIncidents)

/**
 * The payload as `EnsoThreadIncidents`, or undefined when it is not one — what the CLI reads.
 *
 * @group Session incident
 */
export function readEnsoThreadIncidents(payload: unknown): EnsoThreadIncidents | undefined {
  return threadIncidentsValidator.Check(payload) ? payload : undefined
}

/** The records an incident's calls left: what each was observed as, and each refusal of one. */
const EVIDENCE_ENTRIES: ReadonlySet<string> = new Set([
  ENSO_SECURITY_SIGNAL_ENTRY,
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_PERMISSION_DENIAL_ENTRY,
])

/**
 * The custom entries an incident rests on (#468's export): every entry naming it — the opening,
 * the report or its absence, each resolution — and the signal and refusal records of the calls
 * its signals name. Each is our transcript's record of the stored entry (`transcriptOf`): its
 * `data` untouched, under our `{ kind: 'custom', id, at, customType }` envelope, not the runtime's.
 *
 * @group Session incident
 */
export function incidentEntriesOf(
  entries: readonly EnsoTranscriptEntry[],
  opened: EnsoIncidentOpened,
): EnsoTranscriptCustom[] {
  const calls = new Set(opened.signals.flatMap((signal) => [...signal.after, signal.toolCallId]))
  return entries.filter((transcriptEntry): transcriptEntry is EnsoTranscriptCustom => {
    if (transcriptEntry.kind !== 'custom' || typeof transcriptEntry.data !== 'object' || transcriptEntry.data === null)
      return false
    const { incidentId, toolCallId } = transcriptEntry.data as Record<string, unknown>
    if (incidentId === opened.incidentId) return true
    return EVIDENCE_ENTRIES.has(transcriptEntry.customType) && typeof toolCallId === 'string' && calls.has(toolCallId)
  })
}

/**
 * The call that tipped the risk into `incident`: the last signal's (the step that raised it), or
 * undefined for an opening with no signals — a fork's inherited one. The page places an incident's
 * card after the message holding this call (#588).
 *
 * @group Session incident
 */
export function tippingCallOf(signals: readonly EnsoSecuritySignal[]): string | undefined {
  return signals.at(-1)?.toolCallId
}

/** A replayed opening, before it is compared: its tipping call and the event index it opened at. */
interface ReplayedOpening {
  readonly trigger: string
  readonly signals: readonly EnsoSecuritySignal[]
  readonly at: number
}

/**
 * The openings the risk fold makes over `events` under `thresholds`, by the guard's own rule: one
 * opens when the risk reaches `incident` and none is open; a resolution closes it and resets the
 * risk. `openAt` holds the event indexes where an inherited incident opens (a fork's, #466).
 */
function replayedOpenings(
  events: readonly EnsoRiskEvent[],
  openAt: ReadonlySet<number>,
  thresholds: EnsoRiskThresholds,
): ReplayedOpening[] {
  const openings: ReplayedOpening[] = []
  let risk = INITIAL_SESSION_RISK
  let open = false
  for (const [at, event] of events.entries()) {
    if (openAt.has(at)) open = true
    risk = sessionRiskStep(risk, event, thresholds).state
    if (event.kind === 'incident-resolved') open = false
    else if (risk.level === 'incident' && !open) {
      open = true
      openings.push({ trigger: tippingCallOf(risk.signals) ?? String(at), signals: [...risk.signals], at })
    }
  }
  return openings
}

/**
 * A branch's incident openings replayed under `thresholds`, beside the ones the guard recorded
 * (#468) — what tunes `security.incidents` against real sessions. Rows are in branch order.
 *
 * - With the thresholds the branch ran under, every row is `same`: the replay is the guard's own
 *   fold (`sessionRiskStep`) over the events it met (`riskEventsOfEntries`), and opens by its rule.
 * - An inherited opening (a fork's, written by the host) is not the guard's: it is no row, but it
 *   holds the incident open from where it stands, as it does live.
 * - ⚠ The branch is replayed as it happened. A replay that opens earlier than the guard did still
 *   reads the calls a halt would have stopped, and so may count signals a halted session never had.
 * - An `end-thread` resolution is not modelled: an ended thread takes no further calls.
 *
 * @group Session incident
 */
export function replayIncidents(
  entries: readonly EnsoTranscriptEntry[],
  thresholds: EnsoRiskThresholds = DEFAULT_RISK_THRESHOLDS,
): EnsoIncidentReplayRow[] {
  // The branch splits at each inherited opening, so its event index is known; nothing in a fork
  // after the opening refers to a call before it, so the split rebuilds the same order.
  const events: EnsoRiskEvent[] = []
  const openAt = new Set<number>()
  const recorded: EnsoIncidentOpened[] = []
  let segment: EnsoTranscriptEntry[] = []
  for (const transcriptEntry of [...entries, undefined]) {
    const opened =
      transcriptEntry?.kind === 'custom'
        ? readEnsoIncidentOpened(transcriptEntry.customType, transcriptEntry.data)
        : undefined
    if (transcriptEntry !== undefined && opened?.inheritedFrom === undefined) {
      segment.push(transcriptEntry)
      if (opened !== undefined) recorded.push(opened)
      continue
    }
    events.push(...riskEventsOfTranscript(segment))
    segment = []
    if (opened !== undefined) openAt.add(events.length)
  }
  return compareOpenings(replayedOpenings(events, openAt, thresholds), recorded, events)
}

/** The replayed openings against the recorded ones, matched by tipping call, in branch order. */
function compareOpenings(
  replayed: readonly ReplayedOpening[],
  recorded: readonly EnsoIncidentOpened[],
  events: readonly EnsoRiskEvent[],
): EnsoIncidentReplayRow[] {
  // An opening with no signal is matched by its own id: no replayed opening has it as a trigger.
  const recordedBy = new Map(recorded.map((opened) => [tippingCallOf(opened.signals) ?? opened.incidentId, opened]))
  const rows: (EnsoIncidentReplayRow & { readonly at: number })[] = replayed.map((opening) => {
    const match = recordedBy.get(opening.trigger)
    recordedBy.delete(opening.trigger)
    const row = { trigger: opening.trigger, signals: [...opening.signals], at: opening.at }
    return match === undefined
      ? { verdict: 'would-open', ...row }
      : { verdict: 'same', ...row, incidentId: match.incidentId }
  })
  for (const [trigger, opened] of recordedBy) {
    // A recorded opening the replay misses sits where its tipping call was last met.
    const at = events.findLastIndex((event) => 'toolCallId' in event && event.toolCallId === trigger)
    rows.push({ verdict: 'would-miss', trigger, signals: opened.signals, incidentId: opened.incidentId, at })
  }
  return rows.toSorted((left, right) => left.at - right.at).map(({ at: _at, ...row }) => row)
}
