import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  checkedIncidentReport,
  ENSO_INCIDENT_OPENED_CHANNEL,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_REPORT_CHANNEL,
  ENSO_INCIDENT_REPORT_ENTRY,
  ENSO_INCIDENT_REPORT_MISSING_ENTRY,
  ENSO_INCIDENT_REPORT_TOOL_NAME,
  ENSO_REPORT_PROMPT_REF,
  type EnsoIncidentReport,
  type EnsoIncidentReportMissing,
  ENSO_LOG_EVENTS,
  customEntriesOf,
  ensoLogger,
  FileIncidentReportParameters,
  type IncidentReportEvidence,
  incidentReportProblems,
  incidentReportRequest,
  readEnsoIncidentOpened,
  reportOwedOf,
  sessionIncidentsOf,
  transcriptOf,
} from '@enso/core'

/**
 * The incident report (#467, phase 4 of #189): when a halting incident opens, the agent is put
 * through one bounded report turn with one tool, `file_incident_report`.
 *
 * - **Asked in the same run.** The guard announces the opening on `ENSO_INCIDENT_OPENED_CHANNEL`;
 *   this extension narrows the active tools to the report tool and sends the request as a
 *   follow-up, which pi's loop delivers after the halted batch, before the run ends.
 * - **Visible only then.** At every prompt's start the permission engine re-adds every registered
 *   tool; this extension, loaded after it, takes the report tool out again. ⚠ The loadout is not the
 *   boundary: while a report is owed the GUARD refuses every other tool (`suspensionDenial`).
 * - **Bounded.** At most two submissions: the first is recorded if every citation verifies; if not,
 *   the tool says which failed and the model may correct once, and the second is recorded as it is.
 *   A run that ends without a recorded report records the first submission, flagged, or
 *   `report-missing`; a session that comes back with the report still owed records it missing too.
 * - **The host checks, not the model.** Citations are checked here, against the branch
 *   (`@enso/core` `checkedIncidentReport`).
 *
 * Every settlement is appended and announced on `ENSO_INCIDENT_REPORT_CHANNEL`, so the guard closes
 * the report window at once.
 */

const log = ensoLogger('extension', 'incident-report')

/** The report the agent owes now: its incident, the calls the incident rests on, and a first try. */
interface OwedReport {
  readonly incidentId: string
  readonly incidentCalls: ReadonlySet<string>
  firstSubmission?: EnsoIncidentReport
}

function recordOf(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined
}

/** A message's text: a string, or the text of its text parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const record = recordOf(part)
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('\n')
}

/** A call's arguments as text: every string value as written, the rest as JSON. */
function argumentsText(input: unknown): string {
  const record = recordOf(input)
  if (record === undefined) return ''
  return Object.values(record)
    .map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument)))
    .join('\n')
}

/** What one branch entry makes citable: `[ref, text]` pairs — a prompt, a result, or each call's arguments. */
function citableOf(entry: unknown): [ref: string, text: string][] {
  const message = recordOf(recordOf(entry)?.message)
  if (recordOf(entry)?.type !== 'message' || message === undefined) return []
  if (message.role === 'user') return [[ENSO_REPORT_PROMPT_REF, textOf(message.content)]]
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    return [[message.toolCallId, textOf(message.content)]]
  }
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content.flatMap((part): [string, string][] => {
    const call = recordOf(part)
    return call?.type === 'toolCall' && typeof call.id === 'string' ? [[call.id, argumentsText(call.arguments)]] : []
  })
}

/**
 * The citable text of a branch, by ref: each tool call's arguments and its result together, and
 * the last user message before the report was asked for (`prompt`).
 */
function citableTextOf(branch: readonly unknown[]): Map<string, string> {
  const texts = new Map<string, string>()
  for (const [ref, citable] of branch.flatMap(citableOf)) {
    // A later prompt replaces the earlier; a call's arguments and its result join.
    texts.set(ref, ref === ENSO_REPORT_PROMPT_REF ? citable : [texts.get(ref) ?? '', citable].join('\n'))
  }
  return texts
}

function reportResult(text: string, terminate: boolean): AgentToolResult<undefined> {
  return terminate
    ? { content: [{ type: 'text', text }], details: undefined, terminate: true }
    : { content: [{ type: 'text', text }], details: undefined }
}

export default function incidentReport(pi: ExtensionAPI): void {
  let owed: OwedReport | undefined
  let submissions = 0

  /** Append the settlement, tell the guard, and close the report. */
  const settle = (customType: string, data: EnsoIncidentReport | EnsoIncidentReportMissing): void => {
    pi.appendEntry(customType, data)
    pi.events.emit(ENSO_INCIDENT_REPORT_CHANNEL, { customType, data })
    const filed = 'factual' in data
    log.info(ENSO_LOG_EVENTS.incidentReportFiled, {
      incidentId: data.incidentId,
      settled: filed ? 'report filed' : 'no report filed',
      filed,
      // Checked: nothing the tool would flag — every citation verified, nothing mismatched (#468).
      checked: filed && incidentReportProblems(data).length === 0,
    })
    owed = undefined
    submissions = 0
  }

  async function execute(
    ...executeArguments: [
      toolCallId: string,
      params: FileIncidentReportParameters,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      extensionContext: ExtensionContext,
    ]
  ): Promise<AgentToolResult<undefined>> {
    const [, params, , , extensionContext] = executeArguments
    if (owed === undefined) throw new Error('No incident report is owed: there is nothing to file.')
    const texts = citableTextOf(extensionContext.sessionManager.getBranch())
    const evidence: IncidentReportEvidence = { refText: (ref) => texts.get(ref), incidentCalls: owed.incidentCalls }
    submissions += 1
    const submission: 1 | 2 = submissions === 1 ? 1 : 2
    const report = checkedIncidentReport(owed.incidentId, params, evidence, submission)
    const problems = incidentReportProblems(report)
    if (problems.length > 0 && submission === 1) {
      owed.firstSubmission = report
      return reportResult(
        [
          'Not recorded yet. These do not check against the session:',
          ...problems.map((problem) => `- ${problem}`),
          `Correct them and call ${ENSO_INCIDENT_REPORT_TOOL_NAME} once more; that report is recorded as it is.`,
        ].join('\n'),
        false,
      )
    }
    settle(ENSO_INCIDENT_REPORT_ENTRY, report)
    return reportResult(
      problems.length === 0
        ? 'Recorded. The user will read it with the incident. Stop here.'
        : `Recorded, with what did not check marked: ${problems.join('; ')}. Stop here.`,
      true,
    )
  }

  pi.registerTool({
    name: ENSO_INCIDENT_REPORT_TOOL_NAME,
    label: 'Incident report',
    description:
      'File the incident report Enso asks for after a security incident halts the session. Only ' +
      'available then. Answer every question; quote the session word for word for the factual ones.',
    parameters: FileIncidentReportParameters,
    execute,
  })

  // The guard opened a halting incident in this run: ask for the report as the run's next turn.
  pi.events.on(ENSO_INCIDENT_OPENED_CHANNEL, (raw: unknown): void => {
    const opened = readEnsoIncidentOpened(ENSO_INCIDENT_OPENED_ENTRY, raw)
    if (opened === undefined || !opened.halted) return
    const calls = [...new Set(opened.signals.flatMap((signal) => [...signal.after, signal.toolCallId]))]
    owed = { incidentId: opened.incidentId, incidentCalls: new Set(calls) }
    submissions = 0
    pi.setActiveTools([ENSO_INCIDENT_REPORT_TOOL_NAME])
    pi.sendMessage(
      {
        customType: 'enso-incident-report-request',
        content: incidentReportRequest(opened.incidentId, calls),
        display: true,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    )
    log.info('incident {incidentId}: report asked for', { incidentId: opened.incidentId })
  })

  // ⚠ Bounded: the run is over, so whatever was filed is the report — or there is none.
  pi.on('agent_end', (): void => {
    if (owed === undefined) return
    if (owed.firstSubmission !== undefined) settle(ENSO_INCIDENT_REPORT_ENTRY, owed.firstSubmission)
    else
      settle(ENSO_INCIDENT_REPORT_MISSING_ENTRY, {
        incidentId: owed.incidentId,
        reason: 'the report turn ended without a report',
      })
  })

  /** Out of the active set, unless a report is owed: the report turn is the tool's only use. */
  const withdrawTool = (): void => {
    if (owed !== undefined) return
    const active = pi.getActiveTools()
    if (active.includes(ENSO_INCIDENT_REPORT_TOOL_NAME)) {
      pi.setActiveTools(active.filter((toolName) => toolName !== ENSO_INCIDENT_REPORT_TOOL_NAME))
    }
  }

  // A session that comes back owing a report lost the run that owed it: record it missing, or the
  // guard's report window would hold every tool until a resolution. And the tool goes out of the
  // active set before any prompt, so what is previewed (#443) is what the first request sends.
  pi.on('session_start', (_event, extensionContext): void => {
    owed = undefined
    submissions = 0
    try {
      const still = reportOwedOf(
        sessionIncidentsOf(customEntriesOf(transcriptOf(extensionContext.sessionManager.getBranch()))),
      )
      if (still !== undefined) {
        settle(ENSO_INCIDENT_REPORT_MISSING_ENTRY, {
          incidentId: still.opened.incidentId,
          reason: 'the run was cut off',
        })
      }
      withdrawTool()
    } catch (error) {
      // ⚠ Never a throw from session_start (a throwing handler wedges print mode, guards/index.ts).
      log.error('the owed report could not be settled at session start: {error}', { error })
    }
  })

  // The engine re-adds every registered tool at a prompt's start; the report tool is only for the
  // report turn, so it goes out again here (this extension loads after the engine).
  pi.on('before_agent_start', withdrawTool)
}
