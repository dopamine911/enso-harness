import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import typescript from 'typescript'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { filesUnder } from '../source-tree.ts'
import { commentsIn, type SourceComment } from './source-comments.ts'

/**
 * What a flow page is built from (#482): tags in source comments and the diagrams tests record.
 * Nothing here is written for the page; each piece sits beside the code or test it describes, so
 * the diff that changes the behaviour is the diff that changes the words.
 *
 *   `@flow <id> <title>` + a paragraph — the flow, stated at the symbol it starts from. Its comment
 *     may add `@contract <path>#<symbol>` (quoted on the page) and `@see <path> <label>`.
 *   `@invariant <flow>/<name> <one sentence>` + the reasoning — a rule the flow keeps, stated at
 *     the symbol that keeps it. `@unpinned <why>` inside it says no test holds it, and why.
 *   `// @pins <flow>/<name> …` on the line above a `test(` — that test holds those invariants.
 *   `toMatchSnapshot('flow <id>: <caption>')` — a diagram a test recorded (`flow-trace.ts`).
 *
 * ⚠ PARSED, NOT MATCHED (PR #488 review): which declaration a tag documents, and which test a pin
 * sits on, come from the TypeScript syntax tree (`source-comments.ts`), and the snapshot files are
 * read by the same parser. Only the tag syntax inside a comment is read as text, the way a reader
 * reads it: a line starting `@name`, running to the next such line or the comment's end. A tag with
 * no declaration to belong to is a PROBLEM, never a guess.
 *
 * Problems are returned, not thrown: `test/flow-pages.test.ts` asserts there are none, and
 * `flow-pages.ts` refuses to write a page while there are any.
 */

export const ROOT = findRepoRoot(import.meta.url)

export interface Anchor {
  /** Repository-relative, `/`-separated. */
  readonly file: string
  /** 1-based line of the declaration the tag belongs to. */
  readonly line: number
  readonly symbol: string
}

export interface FlowDeclaration {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly contracts: readonly { readonly path: string; readonly symbol: string }[]
  readonly sees: readonly { readonly path: string; readonly label: string }[]
  readonly at: Anchor
}

export interface Invariant {
  /** `<flow>/<name>`. */
  readonly id: string
  readonly flow: string
  readonly heading: string
  readonly body: string
  readonly unpinned: string | undefined
  readonly at: Anchor
}

export interface PinnedTest {
  readonly file: string
  /** 1-based line of the `@pins` comment, where a reviewer goes to move or check it. */
  readonly line: number
  readonly title: string
  readonly invariants: readonly string[]
}

export interface RecordedDiagram {
  readonly flow: string
  readonly caption: string
  /** The recording test's file, repository-relative. */
  readonly file: string
  readonly title: string
  readonly diagram: string
}

export interface FlowModel {
  readonly flows: readonly FlowDeclaration[]
  readonly invariants: readonly Invariant[]
  readonly pins: readonly PinnedTest[]
  readonly diagrams: readonly RecordedDiagram[]
  readonly problems: readonly string[]
}

interface Tag {
  readonly name: string
  readonly head: string
  readonly body: string[]
}

/** Every tree that holds owned source or tests: a flow's rules live in launchers and gates as much as in packages. */
const SCAN_ROOTS = ['packages', 'scripts', 'test'] as const
/** The tags a file must mention before it is parsed at all: most of the tree has none. */
const TAG_NAMES = ['@flow', '@invariant', '@pins'] as const
/** The marker a recording test puts in its snapshot hint: `toMatchSnapshot('flow <id>: <caption>')`. */
const FLOW_HINT = ': flow '

/** Words separated by any run of spaces or tabs. */
const wordsOf = (text: string): string[] =>
  text
    .replaceAll('\t', ' ')
    .split(' ')
    .filter((word) => word !== '')

/** A comment line that opens a tag: `@name rest of the line`, the name up to the first space. */
function tagLine(line: string): { name: string; head: string } | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('@')) return undefined
  const [name = '', ...head] = wordsOf(trimmed.slice(1))
  return name === '' ? undefined : { name, head: head.join(' ') }
}

/** A comment's tags, each running to the next tag or the comment's end. */
function tagsOf(comment: SourceComment): Tag[] {
  const tags: Tag[] = []
  for (const line of comment.lines) {
    const opened = tagLine(line)
    if (opened !== undefined) tags.push({ ...opened, body: [] })
    else tags.at(-1)?.body.push(line.trim())
  }
  return tags
}

/** Lines joined into paragraphs: a blank line separates them, and trailing blanks go. */
function prose(lines: readonly string[]): string {
  const paragraphs: string[][] = [[]]
  for (const line of lines) {
    if (line.trim() === '') paragraphs.push([])
    else paragraphs.at(-1)?.push(line.trim())
  }
  return paragraphs
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.join(' '))
    .join('\n\n')
}

interface Collected {
  flows: FlowDeclaration[]
  invariants: Invariant[]
  pins: PinnedTest[]
  problems: string[]
}

function collectFlow(tags: readonly Tag[], tag: Tag, at: Anchor, into: Collected): void {
  const [id = '', ...title] = wordsOf(tag.head)
  const contracts = tags
    .filter((contract) => contract.name === 'contract')
    .map((contract) => {
      const [path = '', symbol = ''] = contract.head.split('#')
      return { path, symbol }
    })
  const sees = tags
    .filter((see) => see.name === 'see')
    .map((see) => {
      const [path = '', ...label] = wordsOf(see.head)
      return { path, label: label.join(' ') }
    })
  into.flows.push({ id, title: title.join(' '), summary: prose(tag.body), contracts, sees, at })
}

function collectInvariant(tags: readonly Tag[], index: number, at: Anchor, into: Collected): void {
  const tag = tags[index] as Tag
  const [id = '', ...heading] = wordsOf(tag.head)
  const next = tags[index + 1]
  into.invariants.push({
    id,
    flow: id.split('/')[0] ?? '',
    heading: heading.join(' '),
    body: prose(tag.body),
    unpinned: next?.name === 'unpinned' ? prose([next.head, ...next.body]) : undefined,
    at,
  })
}

/** One comment's tags: its pins, and its flows and invariants at the declaration it documents. */
function collectComment(file: string, comment: SourceComment, into: Collected): void {
  const tags = tagsOf(comment)
  const pins = tags.filter((tag) => tag.name === 'pins').flatMap((tag) => wordsOf(tag.head))
  if (pins.length > 0 && comment.test === undefined) {
    into.problems.push(`${file}:${comment.line}: @pins is not directly above a test( with a literal title`)
  } else if (pins.length > 0) {
    into.pins.push({ file, line: comment.line, title: comment.test as string, invariants: pins })
  }
  if (!tags.some((tag) => tag.name === 'flow' || tag.name === 'invariant')) return
  if (comment.owner === undefined) {
    into.problems.push(`${file}:${comment.line}: a @flow or @invariant with no declaration to belong to`)
    return
  }
  const at: Anchor = { file, symbol: comment.owner.symbol, line: comment.owner.line }
  tags.forEach((tag, index) => {
    if (tag.name === 'flow') collectFlow(tags, tag, at, into)
    if (tag.name === 'invariant') collectInvariant(tags, index, at, into)
  })
}

function collectFile(root: string, path: string, into: Collected): void {
  const source = readFileSync(path, 'utf8')
  if (!TAG_NAMES.some((tagName) => source.includes(tagName))) return
  const file = relative(root, path).replaceAll('\\', '/')
  for (const comment of commentsIn(path, source)) collectComment(file, comment, into)
}

/** `<title>: flow <id>: <caption> <n>`, the key bun writes for `toMatchSnapshot('flow <id>: <caption>')`. */
function flowKey(key: string): { title: string; flow: string; caption: string } | undefined {
  const hint = key.lastIndexOf(FLOW_HINT)
  if (hint === -1) return undefined
  const rest = key.slice(hint + FLOW_HINT.length)
  const idEnd = rest.indexOf(': ')
  const counter = rest.lastIndexOf(' ')
  if (idEnd === -1 || counter <= idEnd || !Number.isInteger(Number(rest.slice(counter + 1)))) return undefined
  return { title: key.slice(0, hint), flow: rest.slice(0, idEnd), caption: rest.slice(idEnd + 2, counter) }
}

/**
 * Bun's snapshot file as the JavaScript it is (`exports[\`<key>\`] = \`<value>\`;`), read by the
 * TypeScript parser, never evaluated: template literals come back with their escapes decoded.
 */
function snapshotEntries(path: string, source: string): { key: string; value: string }[] {
  const file = typescript.createSourceFile(
    path,
    source,
    typescript.ScriptTarget.Latest,
    false,
    typescript.ScriptKind.JS,
  )
  const literal = (node: typescript.Node): string | undefined =>
    typescript.isNoSubstitutionTemplateLiteral(node) || typescript.isStringLiteral(node) ? node.text : undefined
  return file.statements.flatMap((statement) => {
    if (!typescript.isExpressionStatement(statement) || !typescript.isBinaryExpression(statement.expression)) return []
    const { left, right } = statement.expression
    if (!typescript.isElementAccessExpression(left)) return []
    const key = literal(left.argumentExpression)
    const value = literal(right)
    return key === undefined || value === undefined ? [] : [{ key, value }]
  })
}

/** A string snapshot is stored as `"<value>"`: the quotes bun wraps it in are not the diagram. */
function recordedDiagrams(root: string, problems: string[]): RecordedDiagram[] {
  const diagrams: RecordedDiagram[] = []
  // Every tree's tests, not only `packages/*/src/`: the harness keeps its tests under `extensions/`
  // and `core/`, the launchers under `scripts/__tests__/`.
  const snapshots = [...new Bun.Glob('{packages,scripts,test}/**/__snapshots__/*.snap').scanSync({ cwd: root })]
    .filter((snapshot) => !snapshot.includes('/node_modules/'))
    .sort()
  for (const snapshot of snapshots) {
    const file = join(dirname(dirname(snapshot)), basename(snapshot, '.snap'))
    for (const { key, value: snapshotValue } of snapshotEntries(snapshot, readFileSync(join(root, snapshot), 'utf8'))) {
      const recorded = flowKey(key)
      if (recorded === undefined) continue
      const text = snapshotValue.trim()
      if (!text.startsWith('"sequenceDiagram') || !text.endsWith('"')) {
        problems.push(`${snapshot}: "${key}" is not a recorded sequence diagram`)
        continue
      }
      diagrams.push({ ...recorded, file, diagram: text.slice(1, -1) })
    }
  }
  return diagrams
}

function duplicates(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((tagId, position) => ids.indexOf(tagId) !== position))]
}

/** Every way the tags can disagree with each other, named by what disagrees. */
function coherence(model: Omit<FlowModel, 'problems'>): string[] {
  const flows = new Set(model.flows.map((flow) => flow.id))
  const invariants = new Set(model.invariants.map((invariant) => invariant.id))
  const pinned = new Set(model.pins.flatMap((pin) => pin.invariants))
  const recorded = new Set(model.diagrams.map((diagram) => diagram.flow))
  return [
    ...duplicates(model.flows.map((flow) => flow.id)).map((flowId) => `@flow ${flowId} is declared twice`),
    ...duplicates(model.invariants.map((invariant) => invariant.id)).map(
      (invariantId) => `@invariant ${invariantId} is declared twice`,
    ),
    ...model.invariants
      .filter((invariant) => !flows.has(invariant.flow))
      .map((invariant) => `${invariant.at.file}: @invariant ${invariant.id} names no @flow`),
    ...model.invariants
      .filter((invariant) => !pinned.has(invariant.id) && invariant.unpinned === undefined)
      .map(
        (invariant) => `${invariant.at.file}: @invariant ${invariant.id} is pinned by no test and says no @unpinned`,
      ),
    ...model.pins.flatMap((pin) =>
      pin.invariants
        .filter((invariantId) => !invariants.has(invariantId))
        .map((invariantId) => `${pin.file}: "${pin.title}" pins ${invariantId}, which no @invariant declares`),
    ),
    ...model.flows
      .filter((flow) => !recorded.has(flow.id))
      .map((flow) => `@flow ${flow.id}: no test records its diagram`),
    ...model.diagrams
      .filter((diagram) => !flows.has(diagram.flow))
      .map((diagram) => `${diagram.file}: "${diagram.title}" records flow ${diagram.flow}, which no @flow declares`),
    ...model.flows
      .filter((flow) => flow.title === '' || flow.summary === '')
      .map((flow) => `${flow.at.file}: @flow ${flow.id} needs a title on its line and a paragraph under it`),
  ]
}

/** `root`: the repository, unless a test points the scan at a fixture tree of the same shape. */
export function collectFlows(root: string = ROOT): FlowModel {
  const into: Collected = { flows: [], invariants: [], pins: [], problems: [] }
  const files = SCAN_ROOTS.map((scanRoot) => join(root, scanRoot))
    .filter((directory) => existsSync(directory))
    .flatMap((directory) => filesUnder(directory))
  for (const path of files) collectFile(root, path, into)
  const diagrams = recordedDiagrams(root, into.problems)
  const model = { flows: into.flows, invariants: into.invariants, pins: into.pins, diagrams }
  return { ...model, problems: [...into.problems, ...coherence(model)] }
}
