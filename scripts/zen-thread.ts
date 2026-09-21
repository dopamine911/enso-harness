#!/usr/bin/env bun

/**
 * Inspect the live web server's threads from a shell — the agent's half of #86.
 *
 * Every readout the web surface shows is derived from the event stream. When one is
 * questioned, the human opens the debug drawer (`?debug`); an agent runs this. Both read
 * the same two endpoints, which report what pi's session ACTUALLY contains — the in-memory
 * branch, which is what pi acts on. The session file is a lagging copy: pi flushes it only
 * after the first assistant message, so a thread that has only run slash commands has
 * `sessionFile: null` and this is the only way to see its state at all.
 *
 * Read-only. Talks to the loopback dev server only.
 *
 * Usage:  bun scripts/zen-thread.ts                 # every live thread, one line each
 *         bun scripts/zen-thread.ts <threadId>      # one thread: summary, then the branch
 *         bun scripts/zen-thread.ts <threadId> --events  # the event tails (#97): what the
 *                                                          # host emitted, with provenance,
 *                                                          # then what the server sent
 *         bun scripts/zen-thread.ts <threadId> --json   # the raw payload, for piping
 *
 * The server address defaults to the dev server's; override with ZEN_SERVER_URL.
 */

import type {
  ZenThreadEvent,
  ZenThreadEvents,
  ZenThreadInspection,
  ZenThreadSummary,
} from '../packages/core/src/index.ts'
// The row formats are core's, shared with the drawer: one definition, so the two views cannot drift.
import { describeTranscriptEntry, threadEventColumns } from '../packages/core/src/index.ts'

const serverUrl: string = process.env.ZEN_SERVER_URL ?? 'http://127.0.0.1:5179'
const [threadId, ...flags] = process.argv.slice(2)
const wantsJson = flags.includes('--json')
const wantsEvents = flags.includes('--events')

/** One GET against the running server, or an exit naming what went wrong. */
async function fetchJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${serverUrl}${path}`)
  } catch (error) {
    process.stderr.write(`zen-thread: cannot reach ${serverUrl} — is \`bun run dev\` up? (${String(error)})\n`)
    process.exit(1)
  }
  if (!response.ok) {
    process.stderr.write(`zen-thread: ${response.status} ${await response.text()}\n`)
    process.exit(1)
  }
  return (await response.json()) as T
}

if (threadId === undefined) {
  const threads = await fetchJson<ZenThreadSummary[]>('/api/threads')
  if (threads.length === 0) {
    process.stdout.write('no live threads — nothing has run since the server started, or every session idled out\n')
  }
  for (const thread of threads) {
    const state = thread.busy ? 'busy' : 'idle'
    const file = thread.sessionFile ?? '(in memory, not flushed yet)'
    process.stdout.write(
      `${thread.threadId}  mode=${thread.mode}  ${state}  run=#${thread.generation}  last=${thread.lastActivityAt}  ${file}\n`,
    )
  }
  process.exit(0)
}

/** The drawer's row, as a table: the provenance column padded so `held`/`dropped` line up down the page. */
function describeThreadEvent(event: ZenThreadEvent): string {
  const columns = threadEventColumns(event)
  return `${columns.when}  ${columns.provenance.padEnd(12)} ${columns.subject}`
}

if (wantsEvents) {
  const events = await fetchJson<ZenThreadEvents>(`/api/threads/${encodeURIComponent(threadId)}/events`)
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(events, null, 2)}\n`)
    process.exit(0)
  }
  process.stdout.write(`thread ${events.threadId}\n`)
  process.stdout.write(`the host emitted (${events.emitted.length} events, oldest first):\n`)
  for (const event of events.emitted) process.stdout.write(`  ${describeThreadEvent(event)}\n`)
  process.stdout.write(`the server sent (${events.sent.length} chunks, oldest first):\n`)
  for (const event of events.sent) process.stdout.write(`  ${describeThreadEvent(event)}\n`)
  process.exit(0)
}

const inspection: ZenThreadInspection = await fetchJson<ZenThreadInspection>(
  `/api/threads/${encodeURIComponent(threadId)}`,
)
if (wantsJson) {
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`)
  process.exit(0)
}

process.stdout.write(`thread      ${inspection.threadId}\n`)
process.stdout.write(`session     ${inspection.sessionId}\n`)
process.stdout.write(`cwd         ${inspection.cwd}\n`)
process.stdout.write(`session dir ${inspection.sessionDir}\n`)
process.stdout.write(
  `file        ${inspection.sessionFile ?? '(in memory, not flushed yet — pi writes after the first assistant message)'}\n`,
)
process.stdout.write(
  `mode        ${inspection.permissionMode.mode}  (may switch to: ${inspection.permissionMode.available.join(', ')})\n`,
)
process.stdout.write(
  `state       ${inspection.busy ? 'busy' : 'idle'}, run #${inspection.generation}, last activity ${inspection.lastActivityAt}\n`,
)
process.stdout.write(`commands    ${inspection.commands.map((commandName) => `/${commandName}`).join(' ')}\n`)
process.stdout.write(`branch      ${inspection.entries.length} entries, root to leaf:\n`)
for (const branchEntry of inspection.entries) process.stdout.write(`  ${describeTranscriptEntry(branchEntry)}\n`)
