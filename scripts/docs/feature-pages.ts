import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { FEATURE_SPECS } from './features/index.ts'
import { type FeatureFacts, type FeatureSpec, factsPath, type Shot, type ShotFacts } from './features/spec.ts'
import { ROOT } from './flow-tags.ts'

/**
 * Builds `docs/features/<id>.md` for every feature spec (#482): BUILD OUTPUT, gitignored, written by
 * `bun run docs:build` and the site build. The words come from the spec (`features/<id>.ts`); the
 * navigation steps, the rung labels and every quoted value come from the facts the last capture
 * wrote beside the screenshots (`bun run docs:screenshots --only <feature>`).
 *
 * ⚠ A page is refused, not written stale, when its spec and its facts disagree: a shot the capture
 * never took, a legend with more or fewer marks than were rung, or a sentence quoting a value the
 * capture did not measure. The fix is always to recapture, and the refusal says with what.
 */

const PAGE_DIRECTORY = 'docs/features'
/** A piece of a sentence: text as written, or a `{name}` placeholder a capture fills. */
type Piece = { readonly text: string } | { readonly name: string }

/** Every feature page this build writes, repository-relative. */
export function builtFeaturePages(): string[] {
  return FEATURE_SPECS.map((spec) => `${PAGE_DIRECTORY}/${spec.id}.md`)
}

/** A spec's last captured facts; a spec with no shots has nothing to capture, so none are needed. */
function readFacts(spec: FeatureSpec): FeatureFacts | undefined {
  if (spec.shots.length === 0) return { feature: spec.id, shots: [] }
  const path = join(ROOT, factsPath(spec.id))
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FeatureFacts) : undefined
}

/**
 * The command that retakes `shot`, or every shot of `spec`. A shot taken while the session plays
 * is retaken only by the full run: `--only` skips the session's own stops.
 */
function recaptureFor(spec: FeatureSpec, shot?: Shot): string {
  const shots = shot === undefined ? spec.shots : [shot]
  return shots.some((each) => 'during' in each)
    ? 'recapture with `bun run docs:screenshots` (a shot taken during the session needs the full run)'
    : `recapture with \`bun run docs:screenshots --only ${spec.id}\``
}

/** Every sentence of a spec that may quote a measured value, `{steps}` aside. */
function quotingSentences(spec: FeatureSpec): string[] {
  return [
    ...spec.shows,
    ...spec.opens,
    ...(spec.looksLike ?? []),
    ...spec.shots.flatMap((shot) => shot.after ?? []),
    ...spec.lookFor,
    ...spec.limits,
  ]
}

/** Whether `{steps}` in **How to open it** places the first shot's steps. */
const placesSteps = (spec: FeatureSpec): boolean => spec.opens.some((opening) => namesIn(opening).includes('steps'))

function shotProblems(spec: FeatureSpec, shot: Shot, captured: ShotFacts | undefined): string[] {
  if (captured?.image !== shot.image)
    return [`${spec.id}: shot ${shot.image} was not captured; ${recaptureFor(spec, shot)}`]
  const problems: string[] = []
  if (captured.shown.length !== shot.marks.length) {
    problems.push(
      `${spec.id}: ${shot.image} has ${shot.marks.length} marks, the capture rang ${captured.shown.length}; ${recaptureFor(spec, shot)}`,
    )
  }
  for (const mark of shot.marks) problems.push(...unfilled(spec.id, mark.says, { shown: '', ...captured.measured }))
  return problems
}

/** Why a spec's page cannot be built from its facts; empty when it can. */
export function featureProblems(spec: FeatureSpec, facts: FeatureFacts | undefined = readFacts(spec)): string[] {
  if (facts === undefined) return [`${spec.id}: no ${factsPath(spec.id)}; ${recaptureFor(spec)}`]
  const problems = spec.shots.flatMap((shot, shotIndex) => shotProblems(spec, shot, facts.shots[shotIndex]))
  if (facts.shots.length !== spec.shots.length)
    problems.push(
      `${spec.id}: the capture took ${facts.shots.length} shots, the spec has ${spec.shots.length}; ${recaptureFor(spec)}`,
    )
  // One name, one value: two shots measuring the same name would leave the page quoting whichever came last.
  const measuredBy = new Map<string, string>()
  for (const shot of spec.shots) {
    for (const quoted of Object.keys(shot.measure ?? {})) {
      const first = measuredBy.get(quoted)
      if (first !== undefined) problems.push(`${spec.id}: "{${quoted}}" is measured by both ${first} and ${shot.image}`)
      measuredBy.set(quoted, shot.image)
    }
  }
  const first = facts.shots[0]
  if (placesSteps(spec) && (first === undefined || first.steps.length === 0))
    problems.push(`${spec.id}: How to open it places {steps}, but the first shot took no steps`)
  const measured = { ...measuredValues(facts), steps: 'placed' }
  for (const sentence of quotingSentences(spec)) problems.push(...unfilled(spec.id, sentence, measured))
  return problems
}

function measuredValues(facts: FeatureFacts): Record<string, string> {
  return Object.assign({}, ...facts.shots.map((shot) => shot.measured)) as Record<string, string>
}

const isNameCharacter = (character: string | undefined): boolean =>
  character !== undefined &&
  (character === '_' || (character >= '0' && character <= '9') || character.toLowerCase() !== character.toUpperCase())

/** A non-empty run of letters, digits and `_`. */
function isName(text: string): boolean {
  if (text === '') return false
  for (let position = 0; position < text.length; position += 1) if (!isNameCharacter(text[position])) return false
  return true
}

/** A sentence split at its `{name}` placeholders; a brace that opens no name stays text. */
function piecesOf(text: string): Piece[] {
  const pieces: Piece[] = []
  let literal = ''
  for (let position = 0; position < text.length; position += 1) {
    const close = text[position] === '{' ? text.indexOf('}', position) : -1
    const name = close === -1 ? '' : text.slice(position + 1, close)
    if (isName(name)) {
      pieces.push({ text: literal }, { name })
      literal = ''
      position = close
    } else literal += text[position]
  }
  return [...pieces, { text: literal }]
}

const namesIn = (text: string): string[] => piecesOf(text).flatMap((piece) => ('name' in piece ? [piece.name] : []))

function unfilled(id: string, text: string, values: Readonly<Record<string, string>>): string[] {
  return namesIn(text)
    .filter((quoted) => quoted !== 'shown' && (values[quoted] ?? '') === '')
    .map((quoted) => `${id}: "{${quoted}}" is quoted but the capture measured no value for it`)
}

const fill = (text: string, values: Readonly<Record<string, string>>): string =>
  piecesOf(text)
    .map((piece) => ('name' in piece ? (values[piece.name] ?? `{${piece.name}}`) : piece.text))
    .join('')

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

function linkTo(path: string): string {
  const target = relative(join(ROOT, PAGE_DIRECTORY), join(ROOT, path)).replaceAll('\\', '/')
  return target.startsWith('.') ? target : `./${target}`
}

/** A shot's recorded steps as one sentence, capitalised, no final stop. */
const stepsSentence = (steps: readonly string[]): string => capitalized(steps.join(', then '))

/** A list item; its lines after the first indented under it, so a code block stays inside the item. */
function listItem(text: string): string {
  const [first = '', ...rest] = text.split('\n')
  return [`- ${first}`, ...rest.map((line) => (line === '' ? '' : `  ${line}`))].join('\n')
}

/** A shot's image and legend, led by how it was reached unless **How to open it** already says so. */
function shotSection(
  spec: FeatureSpec,
  shotIndex: number,
  captured: ShotFacts,
  measured: Readonly<Record<string, string>>,
): string[] {
  const shot = spec.shots[shotIndex]
  if (shot === undefined) return []
  const legend = shot.marks.map(
    (mark, markIndex) =>
      `${markIndex + 1}. ${fill(mark.says, { ...captured.measured, shown: captured.shown[markIndex] ?? '' })}`,
  )
  const said = shotIndex === 0 && placesSteps(spec)
  const reach = said || captured.steps.length === 0 ? [] : [`To see it: ${captured.steps.join(', then ')}.`, '']
  const after = (shot.after ?? []).flatMap((paragraph) => [fill(paragraph, measured), ''])
  return [...reach, `![${shot.alt}](./images/${shot.image}.png)`, '', ...legend, '', ...after]
}

export function renderFeaturePage(spec: FeatureSpec, facts: FeatureFacts): string {
  const measured = measuredValues(facts)
  const openingValues = { ...measured, steps: stepsSentence(facts.shots[0]?.steps ?? []) }
  const paragraphs = (texts: readonly string[] = []): string[] =>
    texts.flatMap((paragraph) => [fill(paragraph, measured), ''])
  const see = spec.see.map((link) => {
    const also = link.also === undefined ? '' : ` and [${link.also.label}](${linkTo(link.also.path)})`
    return `- [${link.label}](${linkTo(link.path)})${also}${link.why === undefined ? '' : `: ${link.why}`}.`
  })
  return [
    `# ${spec.title}`,
    '',
    `<!-- built: scripts/docs/feature-pages.ts, from scripts/docs/features/${spec.id}.ts and ${factsPath(spec.id)}. Gitignored: edit the spec and recapture, not this page. -->`,
    '',
    '## What it shows',
    '',
    ...paragraphs(spec.shows),
    '## How to open it',
    '',
    ...spec.opens.map((opening) => listItem(fill(opening, openingValues))),
    '',
    '## What it looks like',
    '',
    ...paragraphs(spec.looksLike),
    ...facts.shots.flatMap((captured, shotIndex) => shotSection(spec, shotIndex, captured, measured)),
    '## What to look for',
    '',
    ...paragraphs(spec.lookFor),
    "## What it doesn't do",
    '',
    ...spec.limits.map((line) => listItem(fill(line, measured))),
    '',
    '## Go deeper',
    '',
    ...see,
    '',
  ].join('\n')
}

/** Every feature page, rendered; refuses, writing nothing, while any spec and its facts disagree. */
export function renderedFeaturePages(): { page: string; text: string }[] {
  const problems = FEATURE_SPECS.flatMap((spec) => featureProblems(spec))
  if (problems.length > 0)
    throw new Error(`feature-pages: refused:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  return FEATURE_SPECS.map((spec) => ({
    page: `${PAGE_DIRECTORY}/${spec.id}.md`,
    text: renderFeaturePage(spec, readFacts(spec) as FeatureFacts),
  }))
}

export function writeFeaturePages(): string[] {
  return renderedFeaturePages().map(({ page, text }) => {
    writeFileSync(join(ROOT, page), text)
    return page
  })
}
