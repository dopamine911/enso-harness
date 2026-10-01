import { expect, test } from 'bun:test'
import { ENSO_GUARD_DENIAL_ENTRY } from '../guard.ts'
import {
  checkedIncidentReport,
  ENSO_INCIDENT_REPORT_ENTRY,
  ENSO_INCIDENT_REPORT_MISSING_ENTRY,
  type EnsoIncidentReport,
  type FileIncidentReportParameters,
  incidentReportProblems,
  quoteOccursIn,
} from '../incident-report.ts'
import {
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_TOOL_FAMILIES,
  type EnsoIncidentOpened,
  type EnsoIncidentResolution,
  incidentResolutionRefusal,
  incidentResolvedOf,
  reportOwedOf,
  sessionIncidentsOf,
  toolFamilyOf,
} from '../session-incident.ts'
import { ENSO_INCIDENT_RESOLVED_ENTRY, sessionRiskOfEntries } from '../session-risk.ts'

const opened = (incidentId: string, halted = true): { customType: string; data: EnsoIncidentOpened } => ({
  customType: ENSO_INCIDENT_OPENED_ENTRY,
  data: { incidentId, signals: [], halted, suspended: halted ? [...ENSO_TOOL_FAMILIES] : [] },
})
const resolved = (incidentId: string, resolution: EnsoIncidentResolution): { customType: string; data: unknown } => ({
  customType: ENSO_INCIDENT_RESOLVED_ENTRY,
  data: incidentResolvedOf(incidentId, resolution),
})
const RESUME: EnsoIncidentResolution = { classification: 'false-positive', outcome: 'resume' }

test('every execute, network and write tool has its family; readers and Enso-only tools have none', () => {
  expect(['bash', 'PowerShell', 'write', 'edit', 'web_fetch', 'web_search'].map(toolFamilyOf)).toEqual([
    'execute',
    'execute',
    'write',
    'write',
    'network',
    'network',
  ])
  expect(['read', 'grep', 'find', 'ls', 'ask_user'].map(toolFamilyOf)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
})

// ⚠ The fold is what makes a suspension server-authoritative: only an opening and a resolution of
// the LAST incident move it, a second opening while one is open is not one, and end-thread is final.
test('⚠ a suspension moves only on an opening and a resolution of the last incident; a second opening while open is ignored', () => {
  const open = sessionIncidentsOf([opened('i1'), opened('i2')])
  expect(open.incidents.map((record) => record.opened.incidentId)).toEqual(['i1'])
  expect(open.suspended).toEqual(['execute', 'network', 'write'])

  const restricted = sessionIncidentsOf([
    opened('i1'),
    resolved('i1', { classification: 'agent-error', outcome: 'resume-with-restrictions', restricted: ['write'] }),
    { customType: ENSO_GUARD_DENIAL_ENTRY, data: { toolCallId: 'x', rule: 'secret-read' } },
  ])
  expect(restricted.suspended).toEqual(['write'])

  // A later alert-only incident keeps what the earlier resolution restricted; resolving an earlier
  // incident after it changes nothing.
  const later = sessionIncidentsOf([
    opened('i1'),
    resolved('i1', { classification: 'agent-error', outcome: 'resume-with-restrictions', restricted: ['write'] }),
    opened('i2', false),
    resolved('i1', RESUME),
  ])
  expect(later.suspended).toEqual(['write'])
  expect(later.incidents.map((record) => record.resolutions.length)).toEqual([1, 0])
})

test('⚠ end-thread suspends every family for good: nothing after it opens or lifts anything', () => {
  const ended = sessionIncidentsOf([
    opened('i1'),
    resolved('i1', { classification: 'confirmed-bypass', outcome: 'end-thread' }),
    resolved('i1', RESUME),
    opened('i2'),
  ])
  expect(ended).toEqual(expect.objectContaining({ ended: true, suspended: ['execute', 'network', 'write'] }))
  expect(ended.incidents).toHaveLength(1)
  expect(incidentResolutionRefusal(ended, 'i1', RESUME)).toBe('the thread was ended by an earlier resolution')
})

test('a resolution is refused for an unknown or superseded incident, and restrictions go with resume-with-restrictions only', () => {
  const state = sessionIncidentsOf([opened('i1'), resolved('i1', RESUME), opened('i2')])
  expect(incidentResolutionRefusal(state, 'nope', RESUME)).toBe('no such incident on this thread')
  expect(incidentResolutionRefusal(state, 'i1', RESUME)).toBe('a later incident supersedes this one')
  expect(incidentResolutionRefusal(state, 'i2', RESUME)).toBeUndefined()
  expect(
    incidentResolutionRefusal(state, 'i2', { classification: 'agent-error', outcome: 'resume-with-restrictions' }),
  ).toBe('resume-with-restrictions names the families that stay suspended')
  expect(
    incidentResolutionRefusal(state, 'i2', {
      classification: 'agent-error',
      outcome: 'resume-with-restrictions',
      restricted: [],
    }),
  ).toBe('resume-with-restrictions names the families that stay suspended')
  expect(incidentResolutionRefusal(state, 'i2', { ...RESUME, restricted: ['write'] })).toBe(
    'only resume-with-restrictions takes restricted families, not resume',
  )
})

// ⚠ "Risk resets only on resolution" (#466): a replay through a resolution entry starts over, so
// signals from before it neither count nor pair with a call after it.
test('⚠ a replay resets the risk at a resolution: earlier signals are gone and an earlier refusal pairs with nothing after it', () => {
  const assistant = (id: string, command: string): unknown => ({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }] },
  })
  const denied = (toolCallId: string): unknown => ({
    type: 'custom',
    customType: ENSO_GUARD_DENIAL_ENTRY,
    data: { toolCallId, rule: 'network-egress', via: 'command-position' },
  })
  const before = [
    assistant('c1', 'curl https://x.test'),
    denied('c1'),
    assistant('c2', 'curl https://x.test'),
    denied('c2'),
  ]
  expect(sessionRiskOfEntries(before).level).toBe('medium')
  const resolution = { type: 'custom', ...resolved('i1', RESUME) }
  const after = [...before, resolution, assistant('c3', 'python3 -c "print(1)"')]
  expect(sessionRiskOfEntries(after)).toEqual({ level: 'low', signals: [] })
})

const REPORT_PARAMS: FileIncidentReportParameters = {
  task: { text: 'the task', evidence: [{ ref: 'prompt', quote: 'fix it' }] },
  denied: { text: 'curl', evidence: [{ ref: 'c1', quote: 'blocked' }] },
  tried: { text: 'wget', evidence: [{ ref: 'c2', quote: 'blocked' }] },
  whyThatAlternative: 'w',
  recognisedAsBypass: 'r',
  shouldHaveDone: 's',
  sufficientAuthorization: 'a',
  patternToAvoid: 'p',
  uncharitableRead: 'I tried to get around it.',
}

function reportOf(
  incidentId: string,
  uncharitableRead = REPORT_PARAMS.uncharitableRead,
): { customType: string; data: unknown } {
  return {
    customType: ENSO_INCIDENT_REPORT_ENTRY,
    data: checkedIncidentReport(
      incidentId,
      { ...REPORT_PARAMS, uncharitableRead },
      { refText: (ref) => (ref === 'prompt' ? 'please fix it' : `${ref} was blocked`), incidentCalls: new Set(['c1']) },
      1,
    ),
  }
}

// ⚠ #467's acceptance: the report is the agent's explanation and never changes the record. It
// attaches once — the first wins, a missing record closes it too — and a report, whatever it
// carries, leaves the opening, its signals, the suspension and every resolution as they were.
test('⚠ a report attaches once and changes nothing else: not the opening, its signals, the suspension or a resolution', () => {
  const base = sessionIncidentsOf([opened('i1')])
  expect(reportOwedOf(base)?.opened.incidentId).toBe('i1')
  const reported = sessionIncidentsOf([opened('i1'), reportOf('i1')])
  expect(reportOwedOf(reported)).toBeUndefined()
  expect(reported.suspended).toEqual(base.suspended)
  expect(reported.incidents[0]?.opened).toEqual(base.incidents[0]?.opened)

  // A second report, or one after its absence was recorded, is not one.
  const second = sessionIncidentsOf([opened('i1'), reportOf('i1'), reportOf('i1', 'a different story')])
  expect(second.incidents[0]?.report?.interpretive.uncharitableRead).toBe('I tried to get around it.')
  const missing = {
    customType: ENSO_INCIDENT_REPORT_MISSING_ENTRY,
    data: { incidentId: 'i1', reason: 'the run was cut off' },
  }
  const late = sessionIncidentsOf([opened('i1'), missing, reportOf('i1')])
  expect(late.incidents[0]).toMatchObject({ reportMissing: missing.data })
  expect(late.incidents[0]?.report).toBeUndefined()

  // Shaped as a record it is not — an opening's or a resolution's fields — it is no report at all.
  const disguised = {
    customType: ENSO_INCIDENT_REPORT_ENTRY,
    data: { ...(reportOf('i1').data as object), halted: false, suspended: [], outcome: 'resume' },
  }
  expect(sessionIncidentsOf([opened('i1'), disguised])).toEqual(base)

  // A report after the resolution does not touch it, and resolving never waited for one.
  const resolvedFirst = sessionIncidentsOf([opened('i1'), resolved('i1', RESUME)])
  const reportedAfter = sessionIncidentsOf([opened('i1'), resolved('i1', RESUME), reportOf('i1')])
  expect(reportedAfter.suspended).toEqual(resolvedFirst.suspended)
  expect(reportedAfter.incidents[0]?.resolutions).toEqual(resolvedFirst.incidents[0]?.resolutions)
  // An alert-only incident owes no report.
  expect(reportOwedOf(sessionIncidentsOf([opened('i2', false)]))).toBeUndefined()
})

test('a quote checks whitespace-normalised, and "what was denied" must cite one of the incident’s calls', () => {
  expect(quoteOccursIn('bash network egress is\n  blocked: "curl"', 'egress is blocked:   "curl"')).toBe(true)
  expect(quoteOccursIn('blocked', '   ')).toBe(false)
  const report = reportOf('i1').data as EnsoIncidentReport
  expect(report.mismatches).toEqual([])
  expect(incidentReportProblems(report)).toEqual([])
  const offTarget = checkedIncidentReport(
    'i1',
    { ...REPORT_PARAMS, denied: { text: 'x', evidence: [{ ref: 'c7', quote: 'blocked' }] } },
    { refText: () => 'fix it: blocked', incidentCalls: new Set(['c1']) },
    1,
  )
  expect(offTarget.mismatches).toEqual(['denied-cites-no-incident-refusal'])
  expect(incidentReportProblems(offTarget)).toEqual([
    "denied: no verified quote cites one of this incident's refused calls",
  ])
})
