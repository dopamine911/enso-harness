#!/usr/bin/env bun

/**
 * The security incidents (#468, phase 5 of #189), from the running server's
 * `GET /api/threads/:id/incidents`.
 *
 *   bun run incidents [history] [<thread> …]      every incident: model, halt, signals, report, resolution
 *   bun run incidents export <incident> [--out <dir>]
 *                                                  <dir>/incident/<id>/mechanical.json, agent-report.md, resolution.json
 *   bun run incidents replay [<thread> …] [--window-calls N] [--high-at-signals N]
 *                            [--high-at-kinds N] [--incident-at-signals N]
 *                                                  the branches replayed: same, would open, would miss
 *
 * No thread named: every stored thread the server lists. Reads THROUGH THE ROUTE, never the session
 * file, as `bun run eval` does: `agent-host.ts` is the one file that opens pi's sessions. The server
 * address defaults to the dev server's; override with ENSO_SERVER_URL.
 *
 * `mechanical.json` is the incident's custom entries exactly as the session file holds them — the
 * opening, the signal and refusal records of its calls, the report or its absence, each resolution;
 * `agent-report.md` is the agent's report rendered for reading; `resolution.json` the resolutions.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EnsoCheckedClaim,
  type EnsoIncidentRecord,
  type EnsoRiskThresholds,
  type EnsoThreadIncidents,
  FileIncidentReportParameters,
  incidentReportProblems,
  readEnsoThreadIncidents,
} from '../packages/core/src/index.ts'
import { fetchJson, storedThreadIds, UsageError, wholeNumber } from './server-cli.ts'

type ThresholdKey = keyof EnsoRiskThresholds

/** The replay's flags, by the threshold each names. */
const THRESHOLD_FLAGS: Readonly<Record<string, ThresholdKey>> = {
  '--window-calls': 'windowCalls',
  '--high-at-signals': 'highAtSignals',
  '--high-at-kinds': 'highAtKinds',
  '--incident-at-signals': 'incidentAtSignals',
}

export type IncidentsQuery =
  | { readonly command: 'history'; readonly threads: readonly string[] }
  | { readonly command: 'export'; readonly incidentId: string; readonly directory: string }
  | {
      readonly command: 'replay'
      readonly threads: readonly string[]
      readonly thresholds: Partial<Record<ThresholdKey, number>>
    }

export const USAGE = [
  'usage: bun run incidents [history] [<thread> …]',
  '       bun run incidents export <incident> [--out <dir>]',
  '       bun run incidents replay [<thread> …] [--window-calls N] [--high-at-signals N] [--high-at-kinds N] [--incident-at-signals N]',
].join('\n')

function parseReplay(argv: readonly string[]): IncidentsQuery {
  const threads: string[] = []
  const thresholds: Partial<Record<ThresholdKey, number>> = {}
  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex += 1) {
    const argument = argv[argumentIndex] ?? ''
    const key = THRESHOLD_FLAGS[argument]
    if (key !== undefined) {
      argumentIndex += 1
      thresholds[key] = wholeNumber(argument, argv[argumentIndex])
    } else if (argument.startsWith('--')) throw new UsageError(`unknown flag ${argument}`)
    else threads.push(argument)
  }
  return { command: 'replay', threads, thresholds }
}

function parseExport(argv: readonly string[]): IncidentsQuery {
  const named: string[] = []
  let directory = '.'
  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex += 1) {
    const argument = argv[argumentIndex] ?? ''
    if (argument === '--out') {
      argumentIndex += 1
      directory = argv[argumentIndex] ?? ''
      if (directory === '') throw new UsageError('--out takes a directory')
    } else if (argument.startsWith('--')) throw new UsageError(`unknown flag ${argument}`)
    else named.push(argument)
  }
  const [incidentId, ...rest] = named
  if (incidentId === undefined || rest.length > 0) throw new UsageError('export takes one incident id')
  return { command: 'export', incidentId, directory }
}

export function parseArguments(argv: readonly string[]): IncidentsQuery {
  const [first, ...rest] = argv
  if (first === 'export') return parseExport(rest)
  if (first === 'replay') return parseReplay(rest)
  const threads = first === 'history' ? rest : argv
  const flag = threads.find((argument) => argument.startsWith('--'))
  if (flag !== undefined) throw new UsageError(`unknown flag ${flag}`)
  return { command: 'history', threads }
}

/** What became of the report: none asked (an alert), owed, missing, or filed — checked or flagged. */
function reportState(record: EnsoIncidentRecord): string {
  if (record.report !== undefined) {
    return incidentReportProblems(record.report).length === 0 ? 'report checked' : 'report flagged'
  }
  if (record.reportMissing !== undefined) return 'report missing'
  return record.opened.halted ? 'report owed' : 'no report asked'
}

function resolutionState(record: EnsoIncidentRecord): string {
  const last = record.resolutions.at(-1)
  return last === undefined ? 'open' : `${last.classification} → ${last.outcome}`
}

/** One incident, one line: thread, id, model, halt, signals by kind, report, resolution. */
function historyLine(threadId: string, record: EnsoIncidentRecord): string {
  const { opened } = record
  const kinds = [...new Set(opened.signals.map((signal) => signal.signal))].join(', ')
  return [
    threadId,
    opened.incidentId,
    opened.model ?? '(unknown model)',
    opened.halted ? 'halted' : 'alert',
    `${opened.signals.length} signal(s)${kinds === '' ? '' : ` (${kinds})`}`,
    reportState(record),
    resolutionState(record),
    ...(opened.inheritedFrom === undefined ? [] : [`inherited from ${opened.inheritedFrom.threadId}`]),
  ].join('  ·  ')
}

export function renderHistory(threads: readonly EnsoThreadIncidents[]): string {
  const lines = threads.flatMap((thread) => thread.incidents.map(({ record }) => historyLine(thread.threadId, record)))
  return lines.length === 0 ? 'no incident in the threads read' : lines.join('\n')
}

function thresholdsText(thresholds: EnsoRiskThresholds): string {
  return (Object.keys(THRESHOLD_FLAGS) as string[])
    .map((flag) => {
      const key = THRESHOLD_FLAGS[flag] as ThresholdKey
      return `${flag} ${thresholds[key]}`
    })
    .join(' ')
}

/** Every thread's replay rows, and the totals by verdict — what a threshold change would do. */
export function renderReplay(threads: readonly EnsoThreadIncidents[]): string {
  const [first] = threads
  if (first === undefined) return 'no thread read'
  const totals = { same: 0, 'would-open': 0, 'would-miss': 0 }
  const lines = [`replayed under ${thresholdsText(first.thresholds)}`]
  for (const thread of threads) {
    for (const row of thread.replay) {
      totals[row.verdict] += 1
      lines.push(
        `${thread.threadId}  ${row.verdict.padEnd(10)}  at ${row.trigger}  ${row.signals.length} signal(s)${row.incidentId === undefined ? '' : `  ${row.incidentId}`}`,
      )
    }
  }
  lines.push(
    `${threads.length} thread(s): ${totals.same} same · ${totals['would-open']} would open · ${totals['would-miss']} would miss`,
  )
  return lines.join('\n')
}

const FACTUAL = ['task', 'denied', 'tried'] as const
const INTERPRETIVE = [
  'whyThatAlternative',
  'recognisedAsBypass',
  'shouldHaveDone',
  'sufficientAuthorization',
  'patternToAvoid',
  'uncharitableRead',
] as const

/** A question as the tool put it to the agent — the schema's own words, so the two cannot drift. */
function questionOf(field: (typeof FACTUAL)[number] | (typeof INTERPRETIVE)[number]): string {
  const property = FileIncidentReportParameters.properties[field]
  // A factual question's words are on its claim's text; an interpretive one's on the answer itself.
  const schema = 'properties' in property ? property.properties.text : property
  const description = 'description' in schema ? schema.description : undefined
  return typeof description === 'string' ? description : field
}

function claimLines(field: (typeof FACTUAL)[number], claim: EnsoCheckedClaim): string[] {
  return [
    `### ${questionOf(field)}`,
    '',
    claim.text,
    '',
    ...claim.evidence.map(
      (citation) => `- \`${citation.ref}\`: "${citation.quote}" — ${citation.verified ? 'verified' : 'NOT verified'}`,
    ),
    '',
  ]
}

/** The agent's report, for reading: the checked claims with their citations, then the six answers. */
export function renderAgentReport(record: EnsoIncidentRecord): string {
  const { incidentId } = record.opened
  if (record.reportMissing !== undefined)
    return `# Incident ${incidentId}: no report\n\n${record.reportMissing.reason}\n`
  const { report } = record
  if (report === undefined) {
    const why = record.opened.halted ? 'the report is still owed' : 'none was asked: the incident did not halt'
    return `# Incident ${incidentId}: no report\n\n${why}\n`
  }
  const problems = incidentReportProblems(report)
  return [
    `# Incident ${incidentId}: the agent's report`,
    '',
    `Submission ${report.submission}. ${problems.length === 0 ? 'Every citation verified.' : `Flagged: ${problems.join('; ')}.`}`,
    '',
    '## What the record shows',
    '',
    ...FACTUAL.flatMap((field) => claimLines(field, report.factual[field])),
    "## The agent's reading",
    '',
    ...INTERPRETIVE.flatMap((field) => [`### ${questionOf(field)}`, '', report.interpretive[field], '']),
  ].join('\n')
}

/** The export's three files, by name: the entries as stored, the report for reading, the resolutions. */
export function exportFiles(incident: EnsoThreadIncidents['incidents'][number]): Record<string, string> {
  return {
    'mechanical.json': `${JSON.stringify(incident.entries, null, 2)}\n`,
    'agent-report.md': renderAgentReport(incident.record),
    'resolution.json': `${JSON.stringify(incident.record.resolutions, null, 2)}\n`,
  }
}

async function fetchIncidents(
  serverUrl: string,
  threadId: string,
  thresholds: Partial<Record<ThresholdKey, number>>,
): Promise<EnsoThreadIncidents> {
  const url = new URL(`/api/threads/${encodeURIComponent(threadId)}/incidents`, serverUrl)
  for (const [key, threshold] of Object.entries(thresholds)) url.searchParams.set(key, String(threshold))
  const payload = readEnsoThreadIncidents(await fetchJson(url))
  if (payload === undefined) throw new Error(`${url.href}: the payload did not match EnsoThreadIncidents`)
  return payload
}

async function readThreads(
  serverUrl: string,
  named: readonly string[],
  thresholds: Partial<Record<ThresholdKey, number>> = {},
): Promise<EnsoThreadIncidents[]> {
  const threadIds = named.length > 0 ? named : await storedThreadIds(serverUrl)
  return Promise.all(threadIds.map((threadId) => fetchIncidents(serverUrl, threadId, thresholds)))
}

async function exportIncident(serverUrl: string, incidentId: string, into: string): Promise<string> {
  for (const thread of await readThreads(serverUrl, [])) {
    const incident = thread.incidents.find(({ record }) => record.opened.incidentId === incidentId)
    if (incident === undefined) continue
    const directory = join(into, 'incident', incidentId)
    mkdirSync(directory, { recursive: true })
    const written = Object.entries(exportFiles(incident)).map(([fileName, fileText]) => {
      writeFileSync(join(directory, fileName), fileText)
      return join(directory, fileName)
    })
    return `thread ${thread.threadId}: wrote ${written.join(', ')}`
  }
  throw new Error(`no stored thread has incident ${incidentId}`)
}

async function run(query: IncidentsQuery, serverUrl: string): Promise<string> {
  if (query.command === 'export') return exportIncident(serverUrl, query.incidentId, query.directory)
  if (query.command === 'replay') return renderReplay(await readThreads(serverUrl, query.threads, query.thresholds))
  return renderHistory(await readThreads(serverUrl, query.threads))
}

/** One catch for both failures: a usage error exits 2 with the usage, anything else 1. */
async function main(argv: readonly string[]): Promise<void> {
  const serverUrl = process.env.ENSO_SERVER_URL ?? 'http://127.0.0.1:5179'
  try {
    process.stdout.write(`${await run(parseArguments(argv), serverUrl)}\n`)
  } catch (error) {
    const usage = error instanceof UsageError
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(`enso-incidents: ${reason}${usage ? `\n\n${USAGE}` : ''}\n`)
    process.exit(usage ? 2 : 1)
  }
}

if (import.meta.main) await main(process.argv.slice(2))
