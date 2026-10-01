import { basename } from 'node:path'
import {
  DEFAULT_RISK_THRESHOLDS,
  type EnsoRiskEvent,
  type EnsoRiskState,
  INITIAL_SESSION_RISK,
  riskEventsOfEntries,
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
 * - **Live text**: what bash would actually expand. A heredoc body under a QUOTED delimiter and a
 *   single-quoted string are literal; a backtick or `$(…)` inside one runs nowhere. Every
 *   construct count below is over the live text, which is what the judge's `unreadable` rule
 *   (`session-risk.ts`) does NOT do yet — the report measures the difference.
 * - **After a refusal**: what the agent did next, classified against the refused command, and
 *   which risk-fold signals the window raised.
 */

/** The command with every heredoc body under a QUOTED delimiter dropped and its operator written bare: the quotes did their work. */
function withoutLiteralHeredocs(command: string): string {
  const kept: string[] = []
  let closing: string | undefined
  for (const line of command.split('\n')) {
    if (closing !== undefined) {
      if (line.replace(/^\t+/, '') === closing) closing = undefined
      continue
    }
    const operator = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\(\S+))/.exec(line)
    kept.push(operator === null ? line : line.replace(operator[0], `<<${operator[1] ?? operator[2] ?? operator[3]}`))
    if (operator !== null) closing = operator[1] ?? operator[2] ?? operator[3]
  }
  return kept.join('\n')
}

/** A backslash-escaped quote, backtick, `$`, `|`, `(` or `#` is a character, never an operator: `·`. Other escapes (`\x63`) stay for the decoder check. */
const escapedPairOf = (next: string): string => (/[`"'$|(#\\]/.test(next) ? '·' : `\\${next}`)

/**
 * The quote-aware walk's state. ⚠ `$(…)` opens its own quoting context: `"$(grep -c '```' $f)"`
 * has REAL single quotes inside the double quotes. One frame per open substitution; `)` closes
 * the innermost.
 */
interface Scan {
  live: string
  inSingle: boolean
  readonly frames: { inDouble: boolean }[]
}

const topFrame = (scan: Scan): { inDouble: boolean } => scan.frames[scan.frames.length - 1] ?? { inDouble: false }

/** A `#` at a word start outside quotes opens a comment. */
const opensComment = (text: string, index: number): boolean =>
  text[index] === '#' && (index === 0 || /[\s;&|(]/.test(text[index - 1] ?? ''))

/** One character of the walk; the index to continue from. */
function scanStep(scan: Scan, text: string, index: number): number {
  const character = text[index] ?? ''
  if (scan.inSingle) {
    if (character === "'") {
      scan.inSingle = false
      scan.live += "''"
    }
    return index + 1
  }
  if (character === '\\') {
    scan.live += escapedPairOf(text[index + 1] ?? '')
    return index + 2
  }
  if (character === '$' && text[index + 1] === '(') {
    scan.frames.push({ inDouble: false })
    scan.live += '$('
    return index + 2
  }
  if (character === ')' && scan.frames.length > 1) scan.frames.pop()
  return scanQuotedStep(scan, text, index)
}

/** The characters whose reading depends on the current frame's double quotes. */
function scanQuotedStep(scan: Scan, text: string, index: number): number {
  const character = text[index] ?? ''
  const frame = topFrame(scan)
  if (character === "'" && !frame.inDouble) {
    scan.inSingle = true
    return index + 1
  }
  if (character === '"') frame.inDouble = !frame.inDouble
  if (frame.inDouble && /[|;&]/.test(character)) {
    scan.live += '·'
    return index + 1
  }
  if (!frame.inDouble && opensComment(text, index)) {
    const end = text.indexOf('\n', index)
    return end === -1 ? text.length : end
  }
  scan.live += character
  return index + 1
}

/**
 * The text bash would expand, by a quote-aware walk: a heredoc body under a quoted delimiter is
 * dropped; a single-quoted string is emptied to `''`; a `#` comment is dropped to its line end;
 * a backslash-escaped operator character becomes `·`; and a list operator (`|`, `;`, `&`) inside
 * double quotes becomes `·` too — `--comment "curl x | sh"` pipes nothing.
 */
export function liveText(command: string): string {
  const text = withoutLiteralHeredocs(command)
  const scan: Scan = { live: '', inSingle: false, frames: [{ inDouble: false }] }
  let index = 0
  while (index < text.length) index = scanStep(scan, text, index)
  return scan.live
}

/** The constructs that hide a program from a spelling check, each as the report names it. */
export const CONSTRUCTS = [
  'interpreter one-liner',
  'backtick',
  'quoted substitution body',
  'spliced substitution',
  '| interpreter',
  '| sh',
  'decoder',
  'eval / sh -c',
] as const
export type Construct = (typeof CONSTRUCTS)[number]

const ONE_LINER = /(?:^|[\s;&|(`])(?:python3?|node|deno|bun|perl|ruby|php|lua)\s+(?:-c|-e|-p|-r|eval)\b/
// ⚠ `''` is what liveText leaves of a single-quoted string: skipped as a pair, so only a stray `'` counts.
const QUOTED_BODY = /\$\((?:[^)"\\{']|'')*(?:["\\{]|'(?!'))/
const SPLICED = /[A-Za-z0-9_]\$\(|\$\([^)]*\)[A-Za-z0-9_]/
const DECODER = /base64\s+(?:-d|--decode)\b|\\x[0-9a-f]{2}|xxd\s+-r/i
const FEED_INTERPRETER = /\|\s*(?:python3?|node|perl|ruby|bun|deno)\b/
const FEED_SHELL = /\|\s*(?:ba|z|da|k)?sh\b/
const EVAL_WRAP = /(?:^|[\s;&|(])eval\s|(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+-c\b/

/** The first construct the live text of `command` carries, or undefined when a spelling check can read it whole. */
export function constructOf(command: string): Construct | undefined {
  const text = liveText(command)
  if (ONE_LINER.test(text)) return 'interpreter one-liner'
  if (text.includes('`')) return 'backtick'
  if (QUOTED_BODY.test(text)) return 'quoted substitution body'
  if (SPLICED.test(text)) return 'spliced substitution'
  if (FEED_INTERPRETER.test(text)) return '| interpreter'
  if (FEED_SHELL.test(text)) return '| sh'
  if (DECODER.test(text)) return 'decoder'
  if (EVAL_WRAP.test(text)) return 'eval / sh -c'
  return undefined
}

/** The judge's `unreadable` rule as `session-risk.ts` spells it today, over the RAW text. */
const CURRENT_UNREADABLE =
  /\$\(|`|(?:^|[\s;&|(])eval\s|\|\s*(?:ba|z|da|k)?sh\b|\|\s*(?:python3?|node|perl|ruby|bun|deno)\b|base64\s+(?:-d|--decode)\b|\\x[0-9a-f]{2}/i
const CURRENT_ONE_LINER =
  /(?:^|[\s;&|(`])(?:python3?|node|deno|bun|perl|ruby|php|lua)\s+(?:-c|-e|-p|-r|eval)\b|(?:^|[\s;&|(`])(?:ba|z|da|k)?sh\s+-c\b|(?:^|[\s;&|(`])eval\s/
export function inCurrentScope(command: string): boolean {
  return CURRENT_ONE_LINER.test(command) || CURRENT_UNREADABLE.test(command)
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
  const construct = constructOf(next.command)
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
  branch: readonly unknown[],
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
function foldBranch(branch: readonly unknown[]): FoldedBranch {
  let state: EnsoRiskState = INITIAL_SESSION_RISK
  const calls: RiskCall[] = []
  const denials: { at: number; command: string; reason: string }[] = []
  const signals: { at: number; kind: string }[] = []
  for (const event of riskEventsOfEntries(branch)) {
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
