import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ENSO_PERMISSION_DENIAL_ENTRY,
  type EnsoRiskThresholds,
  type EnsoThreadJudgeCases,
  judgeContextsOfEntries,
} from '../packages/core/src/index.ts'
import { type JudgeStateInputs, judgeStateOf } from '../packages/core/src/judge.ts'
import { readJsonLines } from './server-cli.ts'

/**
 * The user's own agent transcripts as the command judge's replay corpus (#469, and #534's data):
 * Claude Code's (`~/.claude/projects`) and omp's (`~/.omp/agent/sessions`), read from disk, built
 * into cases by core's own selection and state builder — the live guard's.
 *
 * - **omp** writes pi's own session format, so its branch is read as it is. It records no refusal
 *   Enso can read, so it gives only `unreadable` cases.
 * - **Claude Code** is mapped onto pi's shape: a `Bash` call is pi's `bash` call, and a call its
 *   permission system or a hook refused is an `enso-permission-denial` — the refusals that make
 *   `after-refusal` cases.
 * - ⚠ A path with an `ACME` segment is skipped before it is opened: that tree is never read.
 * - ⚠ A transcript with no recorded `cwd` is skipped and counted, never resolved against this
 *   checkout. Scripts are read from that `cwd` as it is now (as `branch-judge-cases.ts` states).
 */

/** The corpora: Claude Code's transcripts and omp's sessions. */
export type JudgeCorpus = 'claude' | 'omp'

/** Where each corpus lives. */
const CORPUS_ROOTS: Readonly<Record<JudgeCorpus, string>> = {
  claude: join(homedir(), '.claude', 'projects'),
  omp: join(homedir(), '.omp', 'agent', 'sessions'),
}

/** How Claude Code words a refused tool call: the user's No, a permission rule, a hook. */
const CLAUDE_DENIAL =
  /doesn't want to proceed|was rejected|permission to use .* (?:has been|was) denied|denied by|blocked by (?:a )?hook/i

type Raw = Record<string, unknown>

function recordOf(raw: unknown): Raw | undefined {
  return typeof raw === 'object' && raw !== null ? (raw as Raw) : undefined
}

function textOf(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}

/** A tool result as pi's — preceded, for a Bash call Claude Code refused, by its permission denial. */
function claudeResultOf(part: Raw & { tool_use_id: string }, command: string | undefined): unknown[] {
  const result = { type: 'message', message: { role: 'toolResult', toolCallId: part.tool_use_id } }
  if (part.is_error !== true || command === undefined || !CLAUDE_DENIAL.test(textOf(part.content))) return [result]
  const data = {
    toolCallId: part.tool_use_id,
    requestId: `claude-${part.tool_use_id}`,
    surface: 'bash',
    value: command,
    resolution: 'user_denied',
  }
  return [{ type: 'custom', customType: ENSO_PERMISSION_DENIAL_ENTRY, data }, result]
}

/** A `tool_use` as pi's call, its Bash command remembered by id. */
function claudeCallOf(part: Raw & { id: string }, commands: Map<string, string>): unknown {
  const name = part.name === 'Bash' ? 'bash' : String(part.name).toLowerCase()
  const input = recordOf(part.input) ?? {}
  if (name === 'bash') commands.set(part.id, typeof input.command === 'string' ? input.command : '')
  return { type: 'toolCall', id: part.id, name, arguments: input }
}

/**
 * One Claude Code message's parts as pi's: each `tool_use` a call, each `tool_result` a result —
 * and, when it refused a Bash call, its denial.
 */
function claudePartsOf(
  content: readonly unknown[],
  commands: Map<string, string>,
): { calls: unknown[]; rest: unknown[] } {
  const parts = content.flatMap((raw) => {
    const part = recordOf(raw)
    return part === undefined ? [] : [part]
  })
  const calls = parts.flatMap((part) =>
    part.type === 'tool_use' && typeof part.id === 'string'
      ? [claudeCallOf(part as Raw & { id: string }, commands)]
      : [],
  )
  const rest = parts.flatMap((part) =>
    part.type === 'tool_result' && typeof part.tool_use_id === 'string'
      ? claudeResultOf(part as Raw & { tool_use_id: string }, commands.get(part.tool_use_id))
      : [],
  )
  return { calls, rest }
}

/**
 * A Claude Code transcript as pi-shaped branch entries, in order: each assistant message's tool
 * calls, then each result — preceded, for a refused Bash call, by its permission denial.
 */
function claudeEntriesAsPi(entries: readonly unknown[]): unknown[] {
  const commands = new Map<string, string>()
  return entries.flatMap((raw) => {
    const content = recordOf(recordOf(raw)?.message)?.content
    if (!Array.isArray(content)) return []
    const { calls, rest } = claudePartsOf(content, commands)
    return calls.length === 0 ? rest : [{ type: 'message', message: { role: 'assistant', content: calls } }, ...rest]
  })
}

/** Where a transcript ran: Claude Code's per-entry `cwd`, omp's `session` entry. */
function cwdOf(entries: readonly unknown[]): string | undefined {
  for (const raw of entries) {
    const cwd = recordOf(raw)?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return undefined
}

/** What reading a corpus found: its cases by transcript, and the transcripts it skipped. */
export interface CorpusRead {
  readonly threads: EnsoThreadJudgeCases[]
  readonly skippedAcme: number
  readonly skippedNoCwd: number
}

/**
 * A corpus's judge cases, one thread per transcript that has any — the redacted state of each,
 * built by `judgeStateOf` exactly as the live guard builds it.
 */
export function corpusThreads(
  corpus: JudgeCorpus,
  inputs: Omit<JudgeStateInputs, 'cwd'> & { readonly thresholds: EnsoRiskThresholds; readonly root?: string },
): CorpusRead {
  const root = inputs.root ?? CORPUS_ROOTS[corpus]
  const threads: EnsoThreadJudgeCases[] = []
  let skippedAcme = 0
  let skippedNoCwd = 0
  for (const relativePath of readdirSync(root, { recursive: true }).map(String).toSorted()) {
    if (!relativePath.endsWith('.jsonl')) continue
    // ⚠ Before the file is opened: the ACME tree is never read.
    if (/acme/i.test(relativePath)) {
      skippedAcme += 1
      continue
    }
    const raw = readJsonLines(join(root, relativePath))
    const cwd = cwdOf(raw)
    if (cwd === undefined) {
      skippedNoCwd += 1
      continue
    }
    const branch = corpus === 'claude' ? claudeEntriesAsPi(raw) : raw
    const cases = judgeContextsOfEntries(branch, inputs.thresholds).map((context) => ({
      toolCallId: context.toolCallId,
      scope: context.reason,
      state: judgeStateOf(context, { ...inputs, cwd }),
    }))
    if (cases.length > 0)
      threads.push({ threadId: `${corpus}:${relativePath.replace(/\.jsonl$/, '')}`, live: false, cases })
  }
  return { threads, skippedAcme, skippedNoCwd }
}
