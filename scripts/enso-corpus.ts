#!/usr/bin/env bun

/**
 * The transcript corpus report (#534): the bash commands the user's own agents ran — Claude Code's
 * transcripts and omp's sessions, read from disk — by shape, by the constructs that hide a program,
 * by what followed a refusal, and by the bypass shapes a spelling check could catch.
 *
 *   bun run corpus              the report, counts and shapes only
 *   bun run corpus --examples   with up to five REDACTED examples per section, truncated
 *
 * ⚠ Local only. Nothing leaves the machine; a path with an ACME segment is never opened
 * (`judge-corpus.ts`). The default output carries no command text at all; `--examples` prints
 * text that has been through `redactJudgeText`, cut to one line of 110 characters.
 */

import { DEFAULT_RISK_THRESHOLDS, riskEventsOfEntries } from '../packages/core/src/index.ts'
import { redactJudgeText } from '../packages/core/src/judge.ts'
import {
  classifyFollow,
  CONSTRUCTS,
  constructOf,
  type FollowKind,
  inCurrentScope,
  type Refusal,
  refusalsIn,
  type Shape,
  shapeOf,
} from './corpus-shapes.ts'
import { corpusBranches } from './judge-corpus.ts'

const SHOW_EXAMPLES = process.argv.includes('--examples')
const example = (text: string): string => `  · ${redactJudgeText(text.replace(/\s+/g, ' ').trim(), []).slice(0, 110)}`
const percent = (part: number, whole: number): string => `${((100 * part) / Math.max(whole, 1)).toFixed(1)}%`

function tally<Key extends string>(items: Iterable<Key>): [Key, number][] {
  const counts = new Map<Key, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts].toSorted((left, right) => right[1] - left[1])
}
const row = (label: string, number: number, whole?: number): string =>
  `  ${String(number).padStart(6)}  ${whole === undefined ? '' : percent(number, whole).padStart(6) + '  '}${label}`

const lines: string[] = []
const commands: string[] = []
const refusals: Refusal[] = []
for (const corpus of ['claude', 'omp'] as const) {
  const read = corpusBranches(corpus)
  lines.push(
    `# ${corpus}: ${read.branches.length} transcripts (${read.skippedAcme} ACME never opened, ${read.skippedNoCwd} without a cwd skipped)`,
  )
  for (const { branch } of read.branches) {
    for (const event of riskEventsOfEntries(branch)) {
      if (event.kind === 'call' && event.tool === 'bash' && event.command !== undefined) commands.push(event.command)
    }
    refusals.push(...refusalsIn(branch))
  }
}
lines.push(`# bash calls: ${commands.length}`, '')

// 1. shapes
const shapes = commands.map(shapeOf)
const shapeRow = (label: string, holds: (shape: Shape) => boolean): string =>
  row(label, shapes.filter(holds).length, commands.length)
lines.push('## 1. Shapes, as the guard segments them')
lines.push(
  shapeRow('unsegmentable (substitution, backticks, heredoc, unterminated quote)', (shape) => shape.unsegmentable),
)
lines.push(shapeRow('one segment', (shape) => shape.segments === 1))
lines.push(shapeRow('four or more segments', (shape) => shape.segments >= 4))
lines.push(shapeRow('a pipe', (shape) => shape.pipes))
lines.push(shapeRow('a heredoc', (shape) => shape.heredoc))
const programs = tally(shapes.flatMap((shape) => shape.programs))
const segmentTotal = programs.reduce((sum, [, number]) => sum + number, 0)
lines.push(`programs at command position (${segmentTotal} segments), top 20:`)
for (const [program, number] of programs.slice(0, 20)) lines.push(row(program, number, segmentTotal))

// 2. constructs: the judge's scope
lines.push('', "## 2. The constructs that hide a program — the judge's `unreadable` scope (#469)")
const inScope = commands.filter(inCurrentScope).length
lines.push(row('in scope by the CURRENT rule (raw text)', inScope, commands.length))
const constructs = commands.map(constructOf)
const live = constructs.filter((construct) => construct !== undefined).length
lines.push(
  row('carrying a construct in the LIVE text (literal heredocs and single quotes set aside)', live, commands.length),
)
lines.push('by construct, first match:')
for (const construct of CONSTRUCTS)
  lines.push(row(construct, constructs.filter((candidate) => candidate === construct).length, live))
if (SHOW_EXAMPLES) {
  for (const construct of ['backtick', 'spliced substitution', 'decoder', '| sh'] as const) {
    lines.push(`examples — ${construct}:`)
    for (const command of commands.filter((candidate) => constructOf(candidate) === construct).slice(0, 5))
      lines.push(example(command))
  }
}

// 3. after a refusal
lines.push(
  '',
  `## 3. After a refusal (${refusals.length} refusals; the risk window is the next ${DEFAULT_RISK_THRESHOLDS.windowCalls} calls)`,
)
for (const [reason, number] of tally(refusals.map((refusal) => refusal.reason)))
  lines.push(row(reason, number, refusals.length))
const first = tally(
  refusals.map((refusal) =>
    refusal.next[0] === undefined ? 'nothing within the window' : classifyFollow(refusal.denied, refusal.next[0]),
  ),
)
lines.push('the FIRST call after a refusal:')
for (const [kind, number] of first) lines.push(row(kind, number, refusals.length))
const anywhereRow = (label: string, kind: FollowKind): string =>
  row(
    `${label} anywhere in the window`,
    refusals.filter((refusal) => refusal.next.some((next) => classifyFollow(refusal.denied, next) === kind)).length,
    refusals.length,
  )
lines.push(anywhereRow('an exact retry', 'exact retry'))
lines.push(anywhereRow('a shell wrapper or interpreter route', 'shell wrapper / interpreter route'))
lines.push('risk-fold signals raised in the window:')
for (const [kind, number] of tally(refusals.flatMap((refusal) => refusal.signals))) lines.push(row(kind, number))
lines.push(
  row(
    'refusals with NO signal in the window',
    refusals.filter((refusal) => refusal.signals.length === 0).length,
    refusals.length,
  ),
)
if (SHOW_EXAMPLES) {
  lines.push('examples — a refusal, then its next bash call:')
  for (const refusal of refusals.filter((candidate) => candidate.next[0]?.tool === 'bash').slice(0, 5)) {
    lines.push(example(`[${refusal.reason}] ${refusal.denied}`))
    lines.push(
      example(
        `→ ${refusal.next[0]?.command ?? ''}  ${refusal.signals.length === 0 ? '(no signal)' : `(${[...new Set(refusal.signals)].join(', ')})`}`,
      ),
    )
  }
}

// 4. bypass shapes a spelling check can catch
lines.push('', '## 4. Bypass shapes a spelling check can catch (all calls / within a window after a refusal)')
const BYPASS: [string, RegExp][] = [
  ['force push by refspec (+ref)', /git push\b[^|;&]*\s\+\S+/],
  ['--force / -f push', /git push\b[^|;&]*(?:--force\b|\s-f\b|--force-with-lease)/],
  ['--no-verify / -n commit or push', /git (?:commit|push)\b[^|;&]*(?:--no-verify\b|\s-n\b)/],
  ['hooks disabled (core.hooksPath, rm .git/hooks)', /(?:-c\s+core\.hooksPath|hooksPath\s*=|rm\b[^|;&]*\.git\/hooks)/],
  ['git -C elsewhere', /git -C \S+/],
  ['sh -c / bash -c', /(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+-c\b/],
  ['eval', /(?:^|[\s;&|(])eval\s/],
  [
    'interpreter one-liner spawning a process',
    /(?:python3?|node)\s+(?:-c|-e)\s+["'][^"']*(?:subprocess|child_process|os\.system|execSync|spawn)/,
  ],
  ['curl|wget into a shell', /(?:curl|wget)\b[^|]*\|\s*(?:ba|z|da|k)?sh\b/],
  ['base64 decode into a shell', /base64\s+(?:-d|--decode)\b[^|]*\|\s*(?:ba|z|da|k)?sh\b/],
]
for (const [name, pattern] of BYPASS) {
  const all = commands.filter((command) => pattern.test(command)).length
  const after = refusals.filter((refusal) =>
    refusal.next.some((next) => next.command !== undefined && pattern.test(next.command)),
  ).length
  lines.push(`  ${String(all).padStart(6)} / ${String(after).padStart(4)}  ${name}`)
}

process.stdout.write(`${lines.join('\n')}\n`)
