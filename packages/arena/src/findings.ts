import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/**
 * The verified gaps of a run (#556 "verified gaps", #624): what the reviewer judged, read from the
 * `findings.json` the review brief asks for. The judgement is the reviewer's — a defect, something
 * that could not be found, the agent's own mistake, or something not needed. The report's part is
 * the check the agent's account never got (#556: "the retrospective is not proof").
 *
 * ⚠ EVERY CITATION IS CHECKED AGAINST THE RUN. A gap stands as verified only when it cites something
 * and every citation resolves: a second inside the run, a screenshot the run kept, a thread the run
 * was in. One that does not is shown with what failed to resolve, so a person reads it as the
 * reviewer's claim, not the evidence's.
 */

const ARENA_GAP_CLASSES = ['defect', 'undiscoverable', 'agent-mistake', 'not-needed'] as const
export type ArenaGapClass = (typeof ARENA_GAP_CLASSES)[number]

/**
 * A gap's text, as the review brief asks for it: always `title`, `reproduction`, `impact` and
 * `observed` (what the evidence shows); when there is one, `inferred` (the cause the reviewer
 * believes, kept apart from what was observed), `workaround`, and `issue` (the issue that covers it,
 * existing or filed: `#123`, `owner/repo#123`, a URL). One list each: the parser checks a gap against
 * them and the type is made of them, so the two cannot disagree.
 */
const GAP_TEXT = ['title', 'reproduction', 'impact', 'observed'] as const
const GAP_OPTIONAL_TEXT = ['inferred', 'workaround', 'issue'] as const

/**
 * One piece of evidence a gap rests on: a second of the run, a screenshot (relative to the run
 * directory, or a path from the manifest's index), a thread. Any of the three.
 */
export type ArenaCitation = Partial<Readonly<Record<'screenshot' | 'threadId', string> & { elapsedMs: number }>>

export type ArenaGap = Readonly<Record<(typeof GAP_TEXT)[number], string>> &
  Partial<Readonly<Record<(typeof GAP_OPTIONAL_TEXT)[number], string>>> & {
    readonly classification: ArenaGapClass
    readonly evidence: readonly ArenaCitation[]
  }

/** A gap with what its check found: each citation that did not resolve, and whether a defect lacks an issue. */
export type ArenaCheckedGap = ArenaGap & {
  readonly unresolved: readonly string[]
  readonly verified: boolean
  readonly unmapped: boolean
}

export type ArenaFindings =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'read'; readonly gaps: readonly ArenaCheckedGap[] }

/** What a citation is checked against: the run's length, its directory, and the threads it was in. */
export interface ArenaRunExtent {
  readonly runDirectory: string
  readonly runMs: number
  readonly threadIds: ReadonlySet<string>
}

export function readFindings(text: string | undefined, extent: ArenaRunExtent): ArenaFindings {
  if (text === undefined) return { status: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { status: 'invalid', reason: `not JSON: ${String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || !('gaps' in parsed) || !Array.isArray(parsed.gaps)) {
    return { status: 'invalid', reason: 'no `gaps` list' }
  }
  const gaps: ArenaCheckedGap[] = []
  for (const [gapIndex, candidate] of parsed.gaps.entries()) {
    const gap = gapOf(candidate)
    if (typeof gap === 'string') return { status: 'invalid', reason: `gap ${gapIndex + 1}: ${gap}` }
    gaps.push(checkGap(gap, extent))
  }
  return { status: 'read', gaps }
}

/** A text field of an unvalidated record, or undefined when it is absent or not text. */
function textField(record: object, field: string): string | undefined {
  const value: unknown = Reflect.get(record, field)
  return typeof value === 'string' ? value : undefined
}

/** A gap as written, or what is wrong with it. */
function gapOf(candidate: unknown): ArenaGap | string {
  if (typeof candidate !== 'object' || candidate === null) return 'not an object'
  const missing = [...GAP_TEXT, 'classification' as const].find((field) => textField(candidate, field) === undefined)
  if (missing !== undefined) return `\`${missing}\` is missing or not text`
  const classification = ARENA_GAP_CLASSES.find((gapClass) => gapClass === textField(candidate, 'classification'))
  if (classification === undefined) return `\`classification\` is not one of ${ARENA_GAP_CLASSES.join(', ')}`
  const evidence = 'evidence' in candidate ? candidate.evidence : undefined
  if (!Array.isArray(evidence)) return '`evidence` is not a list'
  const citations = evidence.map(citationOf)
  const malformed = citations.findIndex((citation) => citation === undefined)
  if (malformed !== -1) return `evidence ${malformed + 1} is not an object of elapsedMs, screenshot, threadId`
  return {
    title: textField(candidate, 'title') ?? '',
    classification,
    reproduction: textField(candidate, 'reproduction') ?? '',
    impact: textField(candidate, 'impact') ?? '',
    observed: textField(candidate, 'observed') ?? '',
    ...Object.fromEntries(
      GAP_OPTIONAL_TEXT.flatMap((field) => {
        const value = textField(candidate, field)
        return value === undefined ? [] : [[field, value]]
      }),
    ),
    evidence: citations.filter((citation): citation is ArenaCitation => citation !== undefined),
  }
}

function citationOf(candidate: unknown): ArenaCitation | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const elapsedMs =
    'elapsedMs' in candidate && typeof candidate.elapsedMs === 'number' ? candidate.elapsedMs : undefined
  const screenshot = textField(candidate, 'screenshot')
  const threadId = textField(candidate, 'threadId')
  return {
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(screenshot === undefined ? {} : { screenshot }),
    ...(threadId === undefined ? {} : { threadId }),
  }
}

function checkGap(gap: ArenaGap, extent: ArenaRunExtent): ArenaCheckedGap {
  const unresolved = gap.evidence.flatMap((citation, index) =>
    citationProblems(citation, extent).map((problem) => `evidence ${index + 1}: ${problem}`),
  )
  if (gap.evidence.length === 0) unresolved.push('cites nothing')
  return {
    ...gap,
    unresolved,
    verified: unresolved.length === 0,
    unmapped: gap.classification === 'defect' && gap.issue === undefined,
  }
}

function citationProblems(citation: ArenaCitation, extent: ArenaRunExtent): string[] {
  const problems: string[] = []
  if (citation.elapsedMs === undefined && citation.screenshot === undefined && citation.threadId === undefined) {
    problems.push('names no second, screenshot or thread')
  }
  if (citation.elapsedMs !== undefined && (citation.elapsedMs < 0 || citation.elapsedMs > extent.runMs)) {
    problems.push(`${citation.elapsedMs} ms is outside the run (0–${extent.runMs} ms)`)
  }
  if (citation.screenshot !== undefined) {
    const path = resolve(extent.runDirectory, citation.screenshot)
    const inside =
      !relative(extent.runDirectory, path).startsWith('..') && !isAbsolute(relative(extent.runDirectory, path))
    if (!inside || !existsSync(path)) problems.push(`no screenshot ${citation.screenshot} in the run`)
  }
  if (citation.threadId !== undefined && !extent.threadIds.has(citation.threadId)) {
    problems.push(`thread ${citation.threadId} is not one the run was in`)
  }
  return problems
}

/** Where the reviewer writes the gaps: beside `review.md`. */
export const findingsPath = (runDirectory: string): string => join(runDirectory, 'findings.json')
