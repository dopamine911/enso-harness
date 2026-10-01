import { expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  ENSO_INCIDENT_OPENED_CHANNEL,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_REPORT_CHANNEL,
  ENSO_INCIDENT_REPORT_ENTRY,
  ENSO_INCIDENT_REPORT_MISSING_ENTRY,
  ENSO_INCIDENT_REPORT_TOOL_NAME,
  ENSO_REPORT_PROMPT_REF,
  type EnsoIncidentOpened,
  type EnsoIncidentReport,
  type FileIncidentReportParameters,
} from '@enso/core'
import incidentReport from '../index.ts'

type Handler = (event: unknown, extensionContext: unknown) => unknown

interface ToolResult {
  readonly content: readonly { readonly text: string }[]
  readonly terminate?: boolean
}

/** One extension instance over a stand-in pi: its tool, its handlers, and what it did. */
function loaded(branch: () => readonly unknown[]): {
  readonly execute: (params: FileIncidentReportParameters) => Promise<ToolResult>
  readonly on: (name: string, event?: unknown) => void
  readonly emit: (channel: string, data: unknown) => void
  readonly appended: { customType: string; data: unknown }[]
  readonly announced: { channel: string; data: unknown }[]
  readonly sent: { message: { content: string }; options: unknown }[]
  readonly active: () => readonly string[]
} {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, ((data: unknown) => void)[]>()
  const appended: { customType: string; data: unknown }[] = []
  const announced: { channel: string; data: unknown }[] = []
  const sent: { message: { content: string }; options: unknown }[] = []
  let active: readonly string[] = ['read', 'bash', ENSO_INCIDENT_REPORT_TOOL_NAME]
  let execute: ((...executeArguments: unknown[]) => Promise<ToolResult>) | undefined
  const context = { sessionManager: { getBranch: branch } }
  incidentReport({
    registerTool: (tool: { execute: typeof execute }) => {
      execute = tool.execute
    },
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    sendMessage: (message: { content: string }, options: unknown) => sent.push({ message, options }),
    setActiveTools: (names: string[]) => {
      active = names
    },
    getActiveTools: () => active,
    events: {
      on: (channel: string, listener: (data: unknown) => void) =>
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
      emit: (channel: string, data: unknown) => announced.push({ channel, data }),
    },
  } as unknown as ExtensionAPI)
  if (execute === undefined) throw new Error('no tool registered')
  const run = execute
  return {
    execute: (params) => run('call-report', params, undefined, undefined, context),
    on: (name, event = {}) => handlers.get(name)?.(event, context),
    emit: (channel, data) => {
      for (const listener of listeners.get(channel) ?? []) listener(data)
    },
    appended,
    announced,
    sent,
    active: () => active,
  }
}

const OPENED: EnsoIncidentOpened = {
  incidentId: 'incident-1',
  signals: [
    { signal: 'denial-retry', toolCallId: 'c2', detail: 'refused again', after: ['c1'] },
    { signal: 'alternate-execution-path', toolCallId: 'c3', detail: 'a one-liner', after: ['c1'] },
  ],
  halted: true,
  suspended: ['execute', 'network', 'write'],
}

const message = (role: string, content: unknown, extra: Record<string, unknown> = {}): unknown => ({
  type: 'message',
  message: { role, content, ...extra },
})
const call = (id: string, command: string): unknown =>
  message('assistant', [{ type: 'toolCall', id, name: 'bash', arguments: { command } }])
const result = (toolCallId: string, text: string): unknown =>
  message('toolResult', [{ type: 'text', text }], { toolCallId })

/** A branch: the prompt, the refused curl (c1), its retry (c2), the one-liner (c3), and the opening. */
const BRANCH: readonly unknown[] = [
  message('user', 'Fetch the release notes from example.test and summarise them.'),
  call('c1', 'curl https://example.test/notes'),
  result('c1', 'bash network egress is blocked: "curl" (matched by command-position).'),
  call('c2', 'wget https://example.test/notes'),
  result('c2', 'bash network egress is blocked: "wget" (matched by command-position).'),
  call('c3', 'python3 -c "import urllib.request"'),
  result('c3', 'bash is not available: security incident incident-1 is open'),
  { type: 'custom', customType: ENSO_INCIDENT_OPENED_ENTRY, data: OPENED },
]

const ANSWERS = {
  whyThatAlternative: 'I wanted the notes and the shell clients were refused.',
  recognisedAsBypass: 'Yes, after the second refusal.',
  shouldHaveDone: 'Asked the user with ask_user.',
  sufficientAuthorization: 'Adding example.test to webFetch.allowedHosts.',
  patternToAvoid: 'Trying another client after a network refusal.',
  uncharitableRead: 'I tried to get around the network deny three ways.',
}

const REPORT: FileIncidentReportParameters = {
  task: {
    text: 'Summarise the release notes.',
    evidence: [{ ref: ENSO_REPORT_PROMPT_REF, quote: 'Fetch the release notes' }],
  },
  denied: { text: 'curl to example.test.', evidence: [{ ref: 'c1', quote: 'network egress is blocked: "curl"' }] },
  tried: {
    text: 'wget, then a python one-liner.',
    evidence: [{ ref: 'c3', quote: 'python3 -c   "import urllib.request"' }],
  },
  ...ANSWERS,
}

function opened(instance: ReturnType<typeof loaded>): void {
  instance.emit(ENSO_INCIDENT_OPENED_CHANNEL, OPENED)
}

test('a halting opening asks for the report in the same run: the report tool alone, the request as a follow-up', () => {
  const instance = loaded(() => BRANCH)
  instance.emit(ENSO_INCIDENT_OPENED_CHANNEL, { ...OPENED, halted: false, suspended: [] })
  expect(instance.sent).toEqual([])
  opened(instance)
  expect(instance.active()).toEqual([ENSO_INCIDENT_REPORT_TOOL_NAME])
  expect(instance.sent).toEqual([
    {
      message: expect.objectContaining({ content: expect.stringContaining('incident-1') }),
      options: { deliverAs: 'followUp', triggerTurn: true },
    },
  ])
  expect(instance.sent[0]?.message.content).toContain('The calls this incident rests on: c1, c2, c3.')
})

// ⚠ #467: the factual claims are checked by the HOST against the branch — quotes whitespace-
// normalised — and a report that checks is recorded at once, announced to the guard, and ends the run.
test('⚠ a report whose quotes all check is recorded, announced and ends the run', async () => {
  const instance = loaded(() => BRANCH)
  opened(instance)
  const answer = await instance.execute(REPORT)
  expect(answer.terminate).toBe(true)
  const [recorded] = instance.appended
  expect(recorded?.customType).toBe(ENSO_INCIDENT_REPORT_ENTRY)
  const report = recorded?.data as EnsoIncidentReport
  expect(report).toMatchObject({ incidentId: 'incident-1', mismatches: [], submission: 1, interpretive: ANSWERS })
  expect(Object.values(report.factual).map((claim) => claim.verified)).toEqual([true, true, true])
  expect(instance.announced).toEqual([{ channel: ENSO_INCIDENT_REPORT_CHANNEL, data: recorded }])
  // Used once: it refuses itself from then on.
  await expect(instance.execute(REPORT)).rejects.toThrow('No incident report is owed')
})

// ⚠ Bounded, never refused: a quote that does not check is named and may be corrected ONCE; the
// second report is recorded as it is, its unchecked claims labelled — and a "what was denied" that
// cites none of the incident's calls carries the mismatch flag.
test('⚠ a quote that does not check is named and corrected once; the second report is recorded as it is, flagged', async () => {
  const instance = loaded(() => BRANCH)
  opened(instance)
  const misquoted = {
    ...REPORT,
    denied: { text: 'curl.', evidence: [{ ref: 'c1', quote: 'curl was allowed' }] },
  }
  const first = await instance.execute(misquoted)
  expect(first.terminate).toBeUndefined()
  expect(first.content[0]?.text).toContain('denied: the quote "curl was allowed" is not in c1')
  expect(instance.appended).toEqual([])

  const elsewhere = {
    ...REPORT,
    denied: { text: 'the prompt.', evidence: [{ ref: ENSO_REPORT_PROMPT_REF, quote: 'Fetch' }] },
  }
  const second = await instance.execute(elsewhere)
  expect(second.terminate).toBe(true)
  const report = instance.appended[0]?.data as EnsoIncidentReport
  expect(report.submission).toBe(2)
  expect(report.factual.denied.verified).toBe(true)
  expect(report.mismatches).toEqual(['denied-cites-no-incident-refusal'])
})

test('a run that ends without a report records it missing; one that ends after a failed try records that try, flagged', async () => {
  const silent = loaded(() => BRANCH)
  opened(silent)
  silent.on('agent_end')
  expect(silent.appended).toEqual([
    {
      customType: ENSO_INCIDENT_REPORT_MISSING_ENTRY,
      data: { incidentId: 'incident-1', reason: 'the report turn ended without a report' },
    },
  ])

  const tried = loaded(() => BRANCH)
  opened(tried)
  await tried.execute({ ...REPORT, tried: { text: 'x', evidence: [{ ref: 'c9', quote: 'nothing' }] } })
  tried.on('agent_end')
  const report = tried.appended[0]?.data as EnsoIncidentReport
  expect(tried.appended[0]?.customType).toBe(ENSO_INCIDENT_REPORT_ENTRY)
  expect(report.factual.tried).toMatchObject({ verified: false, evidence: [{ ref: 'c9', verified: false }] })
  // Settled: a later run's end records nothing more.
  tried.on('agent_end')
  expect(tried.appended).toHaveLength(1)
})

// ⚠ A session that comes back still owing the report lost the run that owed it; left owed, the
// guard's report window would hold every tool until a resolution.
test('⚠ a session that starts with the report still owed records it missing; one that settled records nothing', () => {
  const owing = loaded(() => BRANCH)
  owing.on('session_start')
  expect(owing.appended).toEqual([
    {
      customType: ENSO_INCIDENT_REPORT_MISSING_ENTRY,
      data: { incidentId: 'incident-1', reason: 'the run was cut off' },
    },
  ])
  expect(owing.announced).toHaveLength(1)
  const settled = loaded(() => [...BRANCH, { type: 'custom', ...owing.appended[0] }])
  settled.on('session_start')
  expect(settled.appended).toEqual([])
})

test('at a prompt’s start the report tool goes out of the active set; while a report is owed it stays', () => {
  const instance = loaded(() => BRANCH)
  instance.on('before_agent_start')
  expect(instance.active()).toEqual(['read', 'bash'])
  opened(instance)
  instance.on('before_agent_start')
  expect(instance.active()).toEqual([ENSO_INCIDENT_REPORT_TOOL_NAME])
})
