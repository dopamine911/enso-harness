import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { filesUnder } from '../source-tree.ts'

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
 * ⚠ Read as TEXT, like every generator here: a tag is a line in a comment that starts with `@`,
 * and it runs to the next tag or the comment's end. The symbol a tag belongs to is the
 * declaration after its doc comment, or, for a `//` comment inside a body, the nearest enclosing
 * declaration above it. A tag whose symbol cannot be found is a PROBLEM, never a guess.
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

interface Comment {
  /** 0-based index of the comment's first line. */
  readonly start: number
  /** 0-based index of the comment's last line. */
  readonly end: number
  readonly style: 'block' | 'line'
  /** The text, comment markers removed. */
  readonly lines: readonly string[]
}

interface Tag {
  readonly name: string
  readonly head: string
  readonly body: string[]
}

const SCAN_ROOTS = ['packages'] as const
const TAG_LINE = /^@(\w+)\s*(.*)$/
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var|class|interface|type|enum)\s+(\w+)|(\w+)\s*(?:<[^>]*>)?\s*\()/
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'await', 'typeof', 'void', 'new'])
const SNAPSHOT_KEY = /^(.*): flow ([a-z0-9-]+): (.+) \d+$/s
const QUOTES = `'"\``

function blockText(line: string, first: boolean, last: boolean): string {
  let text = line
  if (first) text = text.replace(/^\s*\/\*\*?\s?/, '')
  if (last) text = text.replace(/\s*\*\/\s*$/, '')
  return first ? text : text.replace(/^\s*\*\s?/, '')
}

/** Every `/** … *\/` block and every run of `//` lines that starts a line, in order. */
function commentsOf(lines: readonly string[]): Comment[] {
  const comments: Comment[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trimStart()
    const start = index
    if (trimmed.startsWith('/*')) {
      while (!(lines[index] ?? '').includes('*/') && index + 1 < lines.length) index += 1
      const body = lines
        .slice(start, index + 1)
        .map((line, at, all) => blockText(line, at === 0, at === all.length - 1))
      comments.push({ start, end: index, style: 'block', lines: body })
    } else if (trimmed.startsWith('//')) {
      while ((lines[index + 1] ?? '').trimStart().startsWith('//')) index += 1
      const body = lines.slice(start, index + 1).map((line) => line.replace(/^\s*\/\/\s?/, ''))
      comments.push({ start, end: index, style: 'line', lines: body })
    }
  }
  return comments
}

function tagsOf(comment: Comment): Tag[] {
  const tags: Tag[] = []
  for (const line of comment.lines) {
    const match = TAG_LINE.exec(line.trim())
    if (match !== null) tags.push({ name: match[1] ?? '', head: (match[2] ?? '').trim(), body: [] })
    else tags.at(-1)?.body.push(line.trim())
  }
  return tags
}

/** Lines joined into paragraphs: a blank line separates them, and trailing blanks go. */
function prose(lines: readonly string[]): string {
  return lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').join(' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n')
}

function declaredName(line: string): string | undefined {
  const match = DECLARATION.exec(line)
  const name = match?.[1] ?? match?.[2] ?? match?.[3]
  return name === undefined || NOT_A_NAME.has(name) ? undefined : name
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** The declaration a comment documents: the next code line, or for a `//` in a body, the enclosing one. */
function ownerOf(file: string, lines: readonly string[], comment: Comment): Anchor | undefined {
  if (comment.style === 'block') {
    let next = comment.end + 1
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1
    const symbol = declaredName(lines[next] ?? '')
    return symbol === undefined ? undefined : { file, line: next + 1, symbol }
  }
  const depth = indentOf(lines[comment.start] ?? '')
  for (let above = comment.start - 1; above >= 0; above -= 1) {
    const line = lines[above] ?? ''
    if (line.trim() === '' || indentOf(line) >= depth) continue
    const symbol = declaredName(line)
    if (symbol !== undefined) return { file, line: above + 1, symbol }
  }
  return undefined
}

/** The title of the `test(` starting on `line`: its first string literal, escapes read. */
function testTitle(lines: readonly string[], line: number): string | undefined {
  const text = lines.slice(line, line + 3).join('\n')
  let index = text.indexOf('test(') + 'test('.length
  while (/\s/.test(text[index] ?? '')) index += 1
  const quote = text[index] ?? ''
  if (!QUOTES.includes(quote) || quote === '') return undefined
  let title = ''
  for (index += 1; index < text.length; index += 1) {
    const character = text[index] ?? ''
    if (character === quote) return title
    if (character === '\\') index += 1
    title += text[index] ?? ''
  }
  return undefined
}

interface Collected {
  flows: FlowDeclaration[]
  invariants: Invariant[]
  pins: PinnedTest[]
  problems: string[]
}

function collectFlow(tags: readonly Tag[], tag: Tag, at: Anchor, into: Collected): void {
  const [id = '', ...title] = tag.head.split(/\s+/)
  const contracts = tags
    .filter((each) => each.name === 'contract')
    .map((each) => {
      const [path = '', symbol = ''] = each.head.split('#')
      return { path, symbol }
    })
  const sees = tags
    .filter((each) => each.name === 'see')
    .map((each) => {
      const [path = '', ...label] = each.head.split(/\s+/)
      return { path, label: label.join(' ') }
    })
  into.flows.push({ id, title: title.join(' '), summary: prose(tag.body), contracts, sees, at })
}

function collectInvariant(tags: readonly Tag[], index: number, at: Anchor, into: Collected): void {
  const tag = tags[index] as Tag
  const [id = '', ...heading] = tag.head.split(/\s+/)
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

function collectPins(file: string, lines: readonly string[], comment: Comment, into: Collected): void {
  const ids = tagsOf(comment)
    .filter((tag) => tag.name === 'pins')
    .flatMap((tag) => tag.head.split(/\s+/))
  if (ids.length === 0) return
  const title = (lines[comment.end + 1] ?? '').trimStart().startsWith('test(')
    ? testTitle(lines, comment.end + 1)
    : undefined
  if (title === undefined) {
    into.problems.push(`${file}:${comment.start + 1}: @pins is not on the line above a test( with a literal title`)
    return
  }
  into.pins.push({ file, title, invariants: ids })
}

function collectFile(path: string, into: Collected): void {
  const source = readFileSync(path, 'utf8')
  if (!/^\s*(?:\*|\/\/)\s*@(?:flow|invariant|pins)\b/m.test(source)) return
  const file = relative(ROOT, path).replaceAll('\\', '/')
  const lines = source.split('\n')
  for (const comment of commentsOf(lines)) {
    collectPins(file, lines, comment, into)
    const tags = tagsOf(comment)
    if (!tags.some((tag) => tag.name === 'flow' || tag.name === 'invariant')) continue
    const at = ownerOf(file, lines, comment)
    if (at === undefined) {
      into.problems.push(`${file}:${comment.start + 1}: a @flow or @invariant with no declaration to belong to`)
      continue
    }
    tags.forEach((tag, index) => {
      if (tag.name === 'flow') collectFlow(tags, tag, at, into)
      if (tag.name === 'invariant') collectInvariant(tags, index, at, into)
    })
  }
}

/** One `exports[\`<key>\`] = \`<value>\`;` entry; both are template literals, escapes intact. */
const SNAPSHOT_ENTRY = /^exports\[`((?:[^`\\]|\\[\s\S])*)`\] = `((?:[^`\\]|\\[\s\S])*)`;$/gm
/** A template literal's body as its value: bun escapes only `` ` ``, `\` and `${` in a snapshot. */
const unescapeTemplate = (text: string): string => text.replaceAll(/\\([\s\S])/g, '$1')

/**
 * Bun's snapshot files, read as TEXT the way bun writes them (`// Bun Snapshot v1`), never
 * evaluated: a string snapshot is stored as `"<value>"` inside a template literal.
 */
function recordedDiagrams(problems: string[]): RecordedDiagram[] {
  const diagrams: RecordedDiagram[] = []
  const snapshots = [...new Bun.Glob('packages/*/src/**/__snapshots__/*.snap').scanSync({ cwd: ROOT })].sort()
  for (const snapshot of snapshots) {
    const source = readFileSync(join(ROOT, snapshot), 'utf8')
    const file = join(dirname(dirname(snapshot)), basename(snapshot, '.snap'))
    for (const [, rawKey = '', rawValue = ''] of source.matchAll(SNAPSHOT_ENTRY)) {
      const key = unescapeTemplate(rawKey)
      const value = unescapeTemplate(rawValue)
      const match = SNAPSHOT_KEY.exec(key)
      if (match === null) continue
      const text = value.trim()
      if (!text.startsWith('"sequenceDiagram') || !text.endsWith('"')) {
        problems.push(`${snapshot}: "${key}" is not a recorded sequence diagram`)
        continue
      }
      diagrams.push({
        flow: match[2] ?? '',
        caption: match[3] ?? '',
        file,
        title: match[1] ?? '',
        diagram: text.slice(1, -1),
      })
    }
  }
  return diagrams
}

function duplicates(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
}

/** Every way the tags can disagree with each other, named by what disagrees. */
function coherence(model: Omit<FlowModel, 'problems'>): string[] {
  const flows = new Set(model.flows.map((flow) => flow.id))
  const invariants = new Set(model.invariants.map((invariant) => invariant.id))
  const pinned = new Set(model.pins.flatMap((pin) => pin.invariants))
  const recorded = new Set(model.diagrams.map((diagram) => diagram.flow))
  return [
    ...duplicates(model.flows.map((flow) => flow.id)).map((id) => `@flow ${id} is declared twice`),
    ...duplicates(model.invariants.map((invariant) => invariant.id)).map((id) => `@invariant ${id} is declared twice`),
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
        .filter((id) => !invariants.has(id))
        .map((id) => `${pin.file}: "${pin.title}" pins ${id}, which no @invariant declares`),
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

export function collectFlows(): FlowModel {
  const into: Collected = { flows: [], invariants: [], pins: [], problems: [] }
  const files = SCAN_ROOTS.flatMap((root) => filesUnder(join(ROOT, root)))
  for (const path of files) collectFile(path, into)
  const diagrams = recordedDiagrams(into.problems)
  const model = { flows: into.flows, invariants: into.invariants, pins: into.pins, diagrams }
  return { ...model, problems: [...into.problems, ...coherence(model)] }
}
