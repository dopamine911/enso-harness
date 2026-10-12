import {
  type CommandJudge,
  commandJudgementOf,
  customEntriesOf,
  ENSO_COMMAND_JUDGEMENT_ENTRY,
  ENSO_INCIDENT_OPENED_CHANNEL,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_REPORT_CHANNEL,
  ENSO_INCIDENT_RESOLVED_CHANNEL,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_LOG_EVENTS,
  ENSO_PERMISSION_DENIAL_ENTRY,
  ENSO_PERMISSION_DENIAL_RESOLUTIONS,
  ENSO_SECURITY_SIGNAL_ENTRY,
  ENSO_SESSION_RISK_ENTRY,
  ENSO_TOOL_FAMILIES,
  type EnsoCommandJudgement,
  type EnsoGuardDenial,
  type EnsoIncidentOpened,
  type EnsoIncidentPolicy,
  type EnsoJudgeContext,
  type EnsoJudgeOutcome,
  type EnsoJudgeState,
  type EnsoPermissionDenial,
  type EnsoPermissionDenialResolution,
  type EnsoRiskEvent,
  type EnsoRiskState,
  type EnsoSessionIncidents,
  type EnsoSessionRiskChange,
  type EnsoTranscriptEntry,
  ensoLogger,
  foldSessionRisk,
  INITIAL_SESSION_RISK,
  judgeContextOf,
  NO_SESSION_INCIDENTS,
  openIncidentOf,
  readEnsoIncidentResolved,
  riskCallOf,
  riskEventsOfTranscript,
  sessionIncidentsOf,
  sessionIncidentsStep,
  sessionRiskStep,
} from '@enso/core'
import type { GuardRuntime } from './guard-session.ts'

/**
 * The session's security, beside the guard (#861): the risk and incident folds over every call and
 * refusal, and the command judge's record. Runtime free: it reaches the runtime only through the
 * guard's port, `GuardRuntime`.
 */

const log = ensoLogger('extension', 'guards')

/** The engine's decision payload, when it refuses the agent's own call: its fields, checked. */
function permissionDenialOf(raw: unknown, toolCallId: string | undefined): EnsoPermissionDenial | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const decision = raw as Record<string, unknown>
  if (decision.result !== 'deny') return undefined
  // A forwarded ask is a subagent's, served by this session: the refusal is not this session's agent's.
  if (decision.forwarding !== undefined && decision.forwarding !== null) return undefined
  const { requestId, surface, value, resolution } = decision
  if (typeof requestId !== 'string' || typeof surface !== 'string' || typeof value !== 'string') return undefined
  if (!(ENSO_PERMISSION_DENIAL_RESOLUTIONS as readonly unknown[]).includes(resolution)) return undefined
  const denial = { requestId, surface, value, resolution: resolution as EnsoPermissionDenialResolution }
  return toolCallId === undefined ? denial : { toolCallId, ...denial }
}

/**
 * A tool call as the risk fold meets it: which call, of which tool, with what it was given.
 *
 * @group Guards
 */
export interface SecurityCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

/**
 * The session's security (#464, #466, phases 1 and 3 of #189): every call, every refusal — the
 * guard's and the permission engine's — folded by `@enso/core`'s `sessionRiskStep`, each signal and
 * each level change appended as an entry and logged; and the session's incidents, folded by
 * `sessionIncidentsStep` over the same kind of entries.
 *
 * ⚠ THE RISK FOLD IS OBSERVE ONLY. A throw anywhere in it is logged and swallowed: a bug in risk
 * must not become a refusal, and must not become a pass. What decides a call is the INCIDENT state
 * (`suspension`), which only records change: an opening this observer appends, a resolution the
 * host appends and announces on `ENSO_INCIDENT_RESOLVED_CHANNEL`.
 *
 * ⚠ AN INCIDENT OPENS WHEN THE RISK IS AT `incident` AND NONE IS OPEN — not on the transition
 * alone, so a session that reached `incident` before #466 existed opens one at its next event after
 * a resume. A resolution resets the risk to `low` (it is the only reset), so the same signals never
 * reopen it. With `halt` off (the default) the opening suspends nothing: it is the alert.
 *
 * ⚠ THE ENGINE'S REFUSAL IS ATTRIBUTED HERE. Its decision event names no tool call. This handler
 * is the first `tool_call` participant, and pi prepares a batch's calls one at a time (every
 * handler of a call, the engine's ask included, before the next call is raised), so the call the
 * guard saw last is the call the engine is deciding. The entry the guard writes names it, which is
 * what lets a replay put the refusal back in its place (`riskEventsOfEntries`).
 *
 * @group Guards
 */
export function observeSessionSecurity(
  runtime: GuardRuntime,
  readPolicy: () => EnsoIncidentPolicy,
): {
  resume(transcript: () => readonly EnsoTranscriptEntry[]): void
  call(call: SecurityCall, signal: AbortSignal | undefined, model: string | undefined): void
  /** A permission engine's decision, as its channel carried it (#496): folded when it refuses this agent's call. */
  permissionDecision(raw: unknown): void
  /** Folds the guard's own refusal; true when it opened an incident that halted. */
  guardDenied(denial: EnsoGuardDenial): boolean
  /** The incident state a call is decided against. */
  incidents(): EnsoSessionIncidents
  /** The command judge's context for a call the fold has met, or undefined when out of scope (#469). */
  judgeContext(toolCallId: string): EnsoJudgeContext | undefined
} {
  // ⚠ Read at every `session_start`, AND lazily at the first event if none fired — the floor's
  // reasoning (`verifyPolicyToolNames`): pi's ordering is an assumption, and a policy read as
  // "alert only" until then would fail OPEN through exactly that window.
  let sessionPolicy: EnsoIncidentPolicy | undefined
  const policy = (): EnsoIncidentPolicy => {
    sessionPolicy ??= readPolicy()
    return sessionPolicy
  }
  let risk: EnsoRiskState = INITIAL_SESSION_RISK
  let incidents: EnsoSessionIncidents = NO_SESSION_INCIDENTS
  let currentCall: string | undefined
  let currentSignal: AbortSignal | undefined
  let currentModel: string | undefined

  /** Open an incident when the risk calls for one; true when it halted. */
  const openIfIncident = (): boolean => {
    if (risk.level !== 'incident' || incidents.ended || openIncidentOf(incidents) !== undefined) return false
    const { halt } = policy()
    const opened: EnsoIncidentOpened = {
      incidentId: crypto.randomUUID(),
      signals: [...risk.signals],
      halted: halt,
      suspended: halt ? [...ENSO_TOOL_FAMILIES] : [],
      ...(currentModel === undefined ? {} : { model: currentModel }),
    }
    runtime.append(ENSO_INCIDENT_OPENED_ENTRY, opened)
    incidents = sessionIncidentsStep(incidents, ENSO_INCIDENT_OPENED_ENTRY, opened)
    log.warn(ENSO_LOG_EVENTS.incidentOpened, {
      incidentId: opened.incidentId,
      halted: opened.halted,
      suspended: opened.suspended.join(', ') || 'nothing',
      signals: opened.signals.length,
      model: opened.model ?? '(unknown)',
    })
    // The report extension asks for the report in this same run (#467).
    if (opened.halted) runtime.emit(ENSO_INCIDENT_OPENED_CHANNEL, opened)
    return opened.halted
  }

  const observe = (event: EnsoRiskEvent): boolean => {
    try {
      const step = sessionRiskStep(risk, event, policy().thresholds)
      for (const signal of step.raised) {
        log.warn(ENSO_LOG_EVENTS.securitySignal, { ...signal })
        runtime.append(ENSO_SECURITY_SIGNAL_ENTRY, signal)
      }
      if (step.state.level !== risk.level) {
        const change: EnsoSessionRiskChange = { level: step.state.level, signals: step.state.signals.length }
        log.warn(ENSO_LOG_EVENTS.sessionRiskChanged, { ...change })
        runtime.append(ENSO_SESSION_RISK_ENTRY, change)
      }
      risk = step.state
      return openIfIncident()
    } catch (error) {
      log.error('the session risk fold failed; no call is decided by it: {error}', { error })
      return false
    }
  }

  // The host appended the resolution's record and says so here, so the suspension lifts without a
  // reload — the same step, and the same reset, a replay of that entry makes.
  runtime.on(ENSO_INCIDENT_RESOLVED_CHANNEL, (raw: unknown): void => {
    const resolved = readEnsoIncidentResolved(ENSO_INCIDENT_RESOLVED_ENTRY, raw)
    if (resolved === undefined) {
      log.error('an incident resolution arrived malformed; nothing is lifted: {raw}', { raw })
      return
    }
    incidents = sessionIncidentsStep(incidents, ENSO_INCIDENT_RESOLVED_ENTRY, resolved)
    risk = sessionRiskStep(risk, { kind: 'incident-resolved' }, policy().thresholds).state
    // Debug, not the event: the host's resolve path records the day's one line of it (#468).
    log.debug('security incident {incidentId} resolution applied live', { incidentId: resolved.incidentId })
  })

  // The report extension appended the report, or its absence, and says so here (#467): the report
  // window closes at once, and the suspension stands as before — the same step a replay makes.
  runtime.on(ENSO_INCIDENT_REPORT_CHANNEL, (raw: unknown): void => {
    const { customType, data } = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      customType?: unknown
      data?: unknown
    }
    if (typeof customType !== 'string') return
    incidents = sessionIncidentsStep(incidents, customType, data)
  })

  return {
    // Rebuilt from the branch, never from stored signals: the same folds over the same entries.
    resume(branch: () => readonly EnsoTranscriptEntry[]): void {
      sessionPolicy = readPolicy()
      currentCall = undefined
      currentSignal = undefined
      // ⚠ Never a throw: this runs in `session_start` (the print-mode wedge, `verifyPolicyToolNames`).
      let transcript: readonly EnsoTranscriptEntry[]
      try {
        transcript = branch()
      } catch (error) {
        log.error('the branch could not be read; incidents and risk keep their state: {error}', { error })
        return
      }
      incidents = sessionIncidentsOf(customEntriesOf(transcript))
      try {
        risk = foldSessionRisk(riskEventsOfTranscript(transcript), policy().thresholds)
      } catch (error) {
        risk = INITIAL_SESSION_RISK
        log.error('the session risk could not be rebuilt from the branch; it starts low: {error}', { error })
      }
    },
    call(call: SecurityCall, signal: AbortSignal | undefined, model: string | undefined): void {
      currentCall = call.toolCallId
      currentSignal = signal
      currentModel = model
      observe(riskCallOf(call.toolCallId, call.toolName, call.input))
    },
    permissionDecision(raw: unknown): void {
      // Inside the engine's own gate: a throw here must not reach it (observe only, as above).
      try {
        const denial = permissionDenialOf(raw, currentCall)
        if (denial === undefined) return
        // ⚠ A Stop is not a No (#496 review): the engine reads an unanswered prompt as `user_denied`,
        // and the host settles every open prompt unanswered when the run is aborted — which it does
        // after aborting the run's signal. A person's No under an aborted signal was the Stop's.
        if (denial.resolution === 'user_denied' && currentSignal?.aborted === true) return
        runtime.append(ENSO_PERMISSION_DENIAL_ENTRY, denial)
        observe({ kind: 'permission-denial', ...denial })
      } catch (error) {
        log.error('a permission decision could not be recorded: {error}', { error })
      }
    },
    guardDenied(denial: EnsoGuardDenial): boolean {
      return observe(
        denial.via === undefined
          ? { kind: 'guard-denial', toolCallId: denial.toolCallId, rule: denial.rule }
          : { kind: 'guard-denial', toolCallId: denial.toolCallId, rule: denial.rule, via: denial.via },
      )
    },
    incidents: () => incidents,
    // Off the fold's own state, right after the call's step: what `judgeContextsOfEntries` replays.
    judgeContext: (toolCallId) => judgeContextOf(risk, toolCallId),
  }
}

/** The judgement's log properties: each answer as a number when judged, why not when unjudged. */
function judgementProperties(judgement: EnsoCommandJudgement): Record<string, string | number> {
  const { toolCallId, scope, backend, kind, latencyMs } = judgement
  const base = { toolCallId, scope, backend, kind, latencyMs }
  if (judgement.kind === 'unjudged') return { ...base, reason: judgement.reason }
  const answers = Object.entries(judgement.answers).flatMap(([question, answer]) =>
    answer === undefined ? [] : [[question, answer.value] as const],
  )
  return { ...base, ...Object.fromEntries(answers) }
}

/**
 * Ask the judge about a call and record what it answered (#469 PR1: recorded, nothing more).
 *
 * ⚠ NOT AWAITED: the call runs while the judge thinks, so the judge adds no latency to it — and
 * nothing it answers can change the verdict. A rejection (a backend breaking its never-throws
 * contract) is recorded as `unjudged`, never as clean; a record that cannot be written (the
 * session is gone by the time the answer lands) is logged. Neither reaches the runtime's loop.
 *
 * @group Guards
 */
export function judgeInBackground(
  runtime: GuardRuntime,
  judge: CommandJudge,
  request: {
    readonly context: EnsoJudgeContext
    readonly state: EnsoJudgeState
    readonly signal: AbortSignal | undefined
  },
): void {
  const started = performance.now()
  const record = (outcome: EnsoJudgeOutcome): void => {
    const judgement = commandJudgementOf(request.context, judge.backend, performance.now() - started, outcome)
    runtime.append(ENSO_COMMAND_JUDGEMENT_ENTRY, judgement)
    log.info(ENSO_LOG_EVENTS.commandJudged, judgementProperties(judgement))
  }
  // The executor runs now, so the request leaves now; a synchronous throw becomes a rejection.
  new Promise<EnsoJudgeOutcome>((resolve) => resolve(judge.judge(request.state, request.signal)))
    .then(record, (error: unknown) => record({ kind: 'unjudged', reason: `the judge failed: ${String(error)}` }))
    .catch((error: unknown) => {
      log.error('the judgement of {toolCallId} could not be recorded: {error}', {
        toolCallId: request.context.toolCallId,
        error,
      })
    })
}
