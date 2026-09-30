import { expect, test } from 'bun:test'
import { ENSO_GUARD_DENIAL_ENTRY } from '../guard.ts'
import {
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_TOOL_FAMILIES,
  type EnsoIncidentOpened,
  type EnsoIncidentResolution,
  incidentResolutionRefusal,
  incidentResolvedOf,
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
