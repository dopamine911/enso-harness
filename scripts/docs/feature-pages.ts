import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { FEATURE_SPECS } from './features/index.ts'
import { type FeatureFacts, type FeatureSpec, factsPath, type ShotFacts } from './features/spec.ts'
import { ROOT } from './flow-tags.ts'

/**
 * Builds `docs/features/<id>.md` for every feature spec (#482): BUILD OUTPUT, gitignored, written by
 * `bun run docs:build` and the site build. The words come from the spec (`features/<id>.ts`); the
 * navigation steps, the rung labels and every quoted value come from the facts the last capture
 * wrote beside the screenshots (`bun run docs:screenshots --only <shot>`).
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

function readFacts(spec: FeatureSpec): FeatureFacts | undefined {
  const path = join(ROOT, factsPath(spec.id))
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FeatureFacts) : undefined
}

/** Why a spec's page cannot be built from its facts; empty when it can. */
export function featureProblems(spec: FeatureSpec, facts: FeatureFacts | undefined = readFacts(spec)): string[] {
  const recapture = `recapture with \`bun run docs:screenshots --only ${spec.shots.map((shot) => shot.image).join(',')}\``
  if (facts === undefined) return [`${spec.id}: no ${factsPath(spec.id)}; ${recapture}`]
  const problems: string[] = []
  spec.shots.forEach((shot, shotIndex) => {
    const captured = facts.shots[shotIndex]
    if (captured?.image !== shot.image) {
      problems.push(`${spec.id}: shot ${shot.image} was not captured; ${recapture}`)
      return
    }
    if (captured.shown.length !== shot.marks.length) {
      problems.push(
        `${spec.id}: ${shot.image} has ${shot.marks.length} marks, the capture rang ${captured.shown.length}; ${recapture}`,
      )
    }
    for (const mark of shot.marks) problems.push(...unfilled(spec.id, mark.says, { shown: '', ...captured.measured }))
  })
  if (facts.shots.length !== spec.shots.length)
    problems.push(
      `${spec.id}: the capture took ${facts.shots.length} shots, the spec has ${spec.shots.length}; ${recapture}`,
    )
  const measured = Object.assign({}, ...facts.shots.map((shot) => shot.measured)) as Record<string, string>
  for (const paragraph of spec.lookFor) problems.push(...unfilled(spec.id, paragraph, measured))
  return problems
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
    .filter((name) => name !== 'shown' && (values[name] ?? '') === '')
    .map((name) => `${id}: "{${name}}" is quoted but the capture measured no value for it`)
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

function shotSection(spec: FeatureSpec, shotIndex: number, captured: ShotFacts): string[] {
  const shot = spec.shots[shotIndex]
  if (shot === undefined) return []
  const legend = shot.marks.map(
    (mark, markIndex) =>
      `${markIndex + 1}. ${fill(mark.says, { ...captured.measured, shown: captured.shown[markIndex] ?? '' })}`,
  )
  return [`![${shot.alt}](./images/${shot.image}.png)`, '', ...legend, '']
}

export function renderFeaturePage(spec: FeatureSpec, facts: FeatureFacts): string {
  const measured = Object.assign({}, ...facts.shots.map((shot) => shot.measured)) as Record<string, string>
  const firstSteps = facts.shots[0]?.steps ?? []
  const opens = [
    ...(firstSteps.length > 0 ? [`${capitalized(firstSteps.join(', then '))}.`] : []),
    ...(spec.alsoOpens ?? []),
  ]
  const see = spec.see.map(
    (link) => `- [${link.label}](${linkTo(link.path)})${link.why === undefined ? '' : `: ${link.why}.`}`,
  )
  return [
    `# ${spec.title}`,
    '',
    `<!-- built: scripts/docs/feature-pages.ts, from scripts/docs/features/${spec.id}.ts and ${factsPath(spec.id)}. Gitignored: edit the spec and recapture, not this page. -->`,
    '',
    '## What it shows',
    '',
    ...spec.shows.flatMap((paragraph) => [paragraph, '']),
    '## How to open it',
    '',
    ...opens.map((line) => `- ${line}`),
    '',
    '## What it looks like',
    '',
    ...facts.shots.flatMap((captured, shotIndex) => shotSection(spec, shotIndex, captured)),
    ...(spec.afterShots === undefined ? [] : [spec.afterShots, '']),
    '## What to look for',
    '',
    ...spec.lookFor.flatMap((paragraph) => [fill(paragraph, measured), '']),
    "## What it doesn't do",
    '',
    ...spec.limits.map((line) => `- ${line}`),
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
