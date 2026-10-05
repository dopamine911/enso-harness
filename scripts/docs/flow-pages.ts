import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { extractDeclarationFromFile } from './extract-declaration.ts'
import {
  type Anchor,
  collectFlows,
  type FlowDeclaration,
  type FlowModel,
  type Invariant,
  type PinnedTest,
  ROOT,
  type RecordedDiagram,
} from './flow-tags.ts'

/**
 * Builds a `docs/flows/<id>.md` page for every `@flow` in source (#482). The pages are BUILD
 * OUTPUT: gitignored, written by `bun run docs:build` (`build-docs.ts`) and by the site build, never edited and
 * never committed, so there is no copy for a change to forget. What review reads is the source:
 * the tags beside the code (`flow-tags.ts`) and the recorded diagrams in the tests' snapshots.
 *
 * ⚠ A page is refused, not written short, while the tags disagree: an invariant nothing pins, a
 * pin that names nothing, a flow no test records. Every problem is named, and none is written.
 *
 * Line numbers appear only here, computed from source on every build, as link targets.
 */

const PAGE_DIRECTORY = 'docs/flows'

/** Where each flow's page is built, repository-relative. Read by the docs gate's link check. */
export function builtFlowPages(model: FlowModel = collectFlows()): string[] {
  return model.flows.map((flow) => `${PAGE_DIRECTORY}/${flow.id}.md`)
}

/** A link from a page in `docs/flows/` to a repository path, with an optional line. */
function linkTo(path: string, line?: number): string {
  const target = relative(join(ROOT, PAGE_DIRECTORY), join(ROOT, path)).replaceAll('\\', '/')
  return line === undefined ? target : `${target}#L${line}`
}

/** `packages/<name>/src/<rest>` shown as `<rest>`; any other path as it is. */
function shortFile(file: string): string {
  const [root, , source, ...rest] = file.split('/')
  return root === 'packages' && source === 'src' && rest.length > 0 ? rest.join('/') : file
}
const baseName = (file: string): string => file.split('/').at(-1) ?? file

function anchorLink(at: Anchor): string {
  return `[\`${at.symbol}\`](${linkTo(at.file, at.line)}) in \`${shortFile(at.file)}\``
}

/**
 * How close a file is to where the flow is stated: its own file, then its directory, then the
 * rest. Sections read outward from the flow's entry point, ties broken by path, so the order is
 * derived rather than kept.
 */
function distance(flow: FlowDeclaration, file: string): number {
  if (file === flow.at.file) return 0
  const directory = flow.at.file.slice(0, flow.at.file.lastIndexOf('/') + 1)
  return file.startsWith(directory) ? 1 : 2
}

function outward<T>(flow: FlowDeclaration, items: readonly T[], fileOf: (item: T) => string): T[] {
  return [...items].toSorted(
    (left, right) =>
      distance(flow, fileOf(left)) - distance(flow, fileOf(right)) || fileOf(left).localeCompare(fileOf(right)),
  )
}
function diagramSection(diagram: RecordedDiagram): string[] {
  const caption = diagram.caption.charAt(0).toUpperCase() + diagram.caption.slice(1)
  return [
    `### ${caption}`,
    '',
    `Recorded by [\`${baseName(diagram.file)}\`](${linkTo(diagram.file)}): *${diagram.title}*. Arrows are what the ` +
      'test drove and what its doubles received; notes are what the code logged at `debug` and above, in the order it logged them.',
    '',
    '```mermaid',
    diagram.diagram,
    '```',
    '',
  ]
}

function pinLines(pins: readonly PinnedTest[]): string[] {
  return pins.flatMap((pin) => [
    `<!-- test: ${pin.file}#${pin.title} -->`,
    `- [\`${baseName(pin.file)}\`](${linkTo(pin.file)}): ${pin.title}`,
  ])
}

function invariantSection(invariant: Invariant, pins: readonly PinnedTest[]): string[] {
  const holding = pins.filter((pin) => pin.invariants.includes(invariant.id))
  const proof =
    holding.length > 0
      ? ['Pinned by:', '', ...pinLines(holding)]
      : [`Not pinned by a test: ${invariant.unpinned ?? ''}`]
  return [
    `### ${invariant.heading}`,
    '',
    invariant.body,
    '',
    `Stated at ${anchorLink(invariant.at)}.`,
    '',
    ...proof,
    '',
  ]
}

function contractSection(flow: FlowDeclaration): string[] {
  if (flow.contracts.length === 0) return []
  const fences = flow.contracts.flatMap(({ path, symbol }) => [
    `<!-- source: ${path}#${symbol} -->`,
    '```ts',
    extractDeclarationFromFile(join(ROOT, path), symbol).text,
    '```',
    '',
  ])
  return ['## The contract', '', ...fences]
}

/** Every symbol the page's words came from, once, with what it states. */
function statedSection(flow: FlowDeclaration, invariants: readonly Invariant[]): string[] {
  const stated = new Map<string, { at: Anchor; what: string[] }>()
  const note = (at: Anchor, what: string): void => {
    const key = `${at.file}#${at.line}`
    const entry = stated.get(key) ?? { at, what: [] }
    entry.what.push(what)
    stated.set(key, entry)
  }
  note(flow.at, 'the flow')
  for (const invariant of invariants) note(invariant.at, invariant.id.split('/')[1] ?? invariant.id)
  const symbols = [...stated.values()].map((statement) => `- ${anchorLink(statement.at)}: ${statement.what.join(', ')}`)
  const sees = flow.sees.map((see) => `- [${see.label}](${linkTo(see.path)})`)
  return ['## Where it is stated', '', ...symbols, ...sees, '']
}

export function renderFlowPage(flow: FlowDeclaration, model: FlowModel): string {
  const invariants = outward(
    flow,
    model.invariants.filter((invariant) => invariant.flow === flow.id),
    (invariant) => invariant.at.file,
  )
  const diagrams = outward(
    flow,
    model.diagrams.filter((diagram) => diagram.flow === flow.id),
    (diagram) => diagram.file,
  )
  const pins = model.pins.filter((pin) => pin.invariants.some((invariantId) => invariantId.startsWith(`${flow.id}/`)))
  return [
    `# Flow: ${flow.title}`,
    '',
    `<!-- built: scripts/docs/flow-pages.ts, from the @flow, @invariant and @pins tags in source and the diagrams tests record. Gitignored: edit the source, not this page. -->`,
    '',
    flow.summary,
    '',
    '## The sequence',
    '',
    ...diagrams.flatMap(diagramSection),
    '## The invariants it shows',
    '',
    ...invariants.flatMap((invariant) => invariantSection(invariant, pins)),
    ...contractSection(flow),
    ...statedSection(flow, invariants),
  ].join('\n')
}

/** Write every flow page; refuses, writing nothing, while the tags disagree. Returns the pages written. */
export function writeFlowPages(model: FlowModel = collectFlows()): string[] {
  if (model.problems.length > 0) {
    throw new Error(
      `flow-pages: refused, the tags disagree:\n${model.problems.map((problem) => `  ${problem}`).join('\n')}`,
    )
  }
  for (const flow of model.flows) {
    writeFileSync(join(ROOT, PAGE_DIRECTORY, `${flow.id}.md`), renderFlowPage(flow, model))
  }
  return builtFlowPages(model)
}
