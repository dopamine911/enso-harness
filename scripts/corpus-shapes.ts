import { basename } from 'node:path'
import { commandConstructOf } from '../packages/core/src/command-constructs.ts'
import {
  DEFAULT_RISK_THRESHOLDS,
  type EnsoRiskEvent,
  type EnsoRiskState,
  type EnsoTranscriptEntry,
  INITIAL_SESSION_RISK,
  judgeContextOf,
  riskEventsOfTranscript,
  sessionRiskStep,
} from '../packages/core/src/index.ts'
import {
  extractFlatShellCommandSegments,
  literalShellWord,
  shellWordsOf,
  withoutLeadingEnvironmentAssignments,
} from '../packages/harness/core/shell-segments.ts'
import { canonicalToolName } from '../packages/harness/core/tool-identity.ts'

/**
 * The corpus report's measurements (#534), as pure functions over bash commands and branches, so
 * `bun run corpus` prints them and a test holds the constructs they name to the bypass shapes the
 * guards know. Nothing here opens a file or a socket.
 *
 * - **Shapes**: how a command is composed, and the program at each command position, read by the
 *   guard's own segmenter — so a shape here is a shape the guard sees.
 * - **The judge's scope**: the constructs that hide a program, read off the LIVE text — what bash
 *   would actually expand — by core's own `commandConstructOf` (`command-constructs.ts`, #544), the
 *   function the judge's `unreadable` rule calls. `inCurrentScope` asks the rule itself, through the
 *   risk fold and `judgeContextOf`, so the report shows the two agreeing rather than assuming it.
 * - **After a refusal**: what the agent did next, classified against the refused command, and
 *   which risk-fold signals the window raised.
 */

/**
 * Whether the judge's rule selects `command` as `unreadable`: the call met by the risk fold with no
 * refusal before it, then `judgeContextOf` — the guard's own selection, not a copy of its rule.
 */
export function inCurrentScope(command: string): boolean {
  const call: EnsoRiskEvent = { kind: 'call', toolCallId: 'corpus', tool: 'bash', command }
  const { state } = sessionRiskStep(INITIAL_SESSION_RISK, call, DEFAULT_RISK_THRESHOLDS)
  return judgeContextOf(state, 'corpus')?.reason === 'unreadable'
}

/** The program at a segment's command position, basename'd and case-folded; `?` when it is not a literal word. */
function programOf(segmentText: string): string {
  const rest = (withoutLeadingEnvironmentAssignments(segmentText.trim()) ?? segmentText).trim()
  const first = shellWordsOf(rest)?.[0] ?? rest.split(/\s/, 1)[0] ?? ''
  const literal = literalShellWord(first)
  if (literal.kind !== 'literal' || literal.value.length === 0) return '?'
  return canonicalToolName(basename(literal.value))
}

export interface Shape {
  readonly segments: number
  readonly programs: readonly string[]
  readonly pipes: boolean
  readonly substitution: boolean
  readonly backticks: boolean
  readonly heredoc: boolean
  /** The segmenter declined: a substitution, backticks, a heredoc or an unterminated quote. */
  readonly unsegmentable: boolean
}

export function shapeOf(command: string): Shape {
  const segments = extractFlatShellCommandSegments(command)
  return {
    segments: segments.length,
    programs: segments.map((segment) => programOf(segment.text)),
    pipes: segments.some((segment) => segment.pipedStdin),
    substitution: command.includes('$('),
    backticks: command.includes('`'),
    heredoc: /<<(?!<)/.test(command),
    unsegmentable: segments.length === 0,
  }
}

/** One call after a refusal, classified against the refused command. */
export type FollowKind =
  | 'exact retry'
  | 'reworded (same program, similar args)'
  | 'same program, different args'
  | 'shell wrapper / interpreter route'
  | 'another tool'
  | 'different command'

const tokensOf = (command: string): Set<string> =>
  new Set(
    command
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((token) => token.length > 2),
  )

/** The share of the larger token set the two commands share. */
function tokenOverlap(left: string, right: string): number {
  const leftTokens = tokensOf(left)
  const rightTokens = tokensOf(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  return shared / Math.max(leftTokens.size, rightTokens.size)
}

export function classifyFollow(denied: string, next: RiskCall): FollowKind {
  if (next.tool !== 'bash' || next.command === undefined) return 'another tool'
  if (next.command.trim() === denied.trim()) return 'exact retry'
  const construct = commandConstructOf(next.command)
  if (construct === 'eval / sh -c' || construct === 'interpreter one-liner') return 'shell wrapper / interpreter route'
  if (programOf(next.command) !== programOf(denied)) return 'different command'
  return tokenOverlap(denied, next.command) >= 0.5
    ? 'reworded (same program, similar args)'
    : 'same program, different args'
}

/** A tool call as the fold keeps it: the tool, and the command or path it was given. */
export interface RiskCall {
  readonly tool: string
  readonly command?: string
  readonly path?: string
}

/** A refusal in a branch, the calls in the risk window after it, and the signals that window raised. */
export interface Refusal {
  readonly denied: string
  readonly reason: string
  readonly next: readonly RiskCall[]
  readonly signals: readonly string[]
}

/** Every refusal in a branch, with what followed — folded by the guard's own risk step. */
export function refusalsIn(
  branch: readonly EnsoTranscriptEntry[],
  window: number = DEFAULT_RISK_THRESHOLDS.windowCalls,
): Refusal[] {
  const { calls, denials, signals } = foldBranch(branch)
  return denials.map((denial) => ({
    denied: denial.command,
    reason: denial.reason,
    next: calls.slice(denial.at, denial.at + window),
    // A signal is recorded at the index of the call that raised it, and the window's first call sits AT `denial.at`.
    signals: signals
      .filter((signal) => signal.at >= denial.at && signal.at < denial.at + window)
      .map((signal) => signal.kind),
  }))
}

interface FoldedBranch {
  readonly calls: readonly RiskCall[]
  readonly denials: readonly { readonly at: number; readonly command: string; readonly reason: string }[]
  readonly signals: readonly { readonly at: number; readonly kind: string }[]
}

/** One pass of the guard's risk step over a branch: its calls, the refusals (each at the index of the call that follows), and the signals raised. */
function foldBranch(branch: readonly EnsoTranscriptEntry[]): FoldedBranch {
  let state: EnsoRiskState = INITIAL_SESSION_RISK
  const calls: RiskCall[] = []
  const denials: { at: number; command: string; reason: string }[] = []
  const signals: { at: number; kind: string }[] = []
  for (const event of riskEventsOfTranscript(branch)) {
    const step = sessionRiskStep(state, event, DEFAULT_RISK_THRESHOLDS)
    for (const signal of step.raised) signals.push({ at: calls.length, kind: signal.signal })
    state = step.state
    if (event.kind === 'call') calls.push(riskCallOf(event))
    else if (event.kind === 'guard-denial' || event.kind === 'permission-denial') {
      const last = calls.at(-1)
      denials.push({
        at: calls.length,
        command: last?.command ?? last?.path ?? last?.tool ?? '?',
        reason: event.kind === 'guard-denial' ? `guard:${event.rule}` : `engine:${event.resolution}`,
      })
    }
  }
  return { calls, denials, signals }
}

function riskCallOf(event: Extract<EnsoRiskEvent, { kind: 'call' }>): RiskCall {
  return {
    tool: event.tool,
    ...(event.command === undefined ? {} : { command: event.command }),
    ...(event.path === undefined ? {} : { path: event.path }),
  }
}
