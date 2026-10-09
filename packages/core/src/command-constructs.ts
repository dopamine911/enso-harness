/**
 * The command judge's `unreadable` scope (#469, #544): the constructs that hide a program from the
 * guards' spelling checks, read off a command's LIVE text — what bash would actually expand.
 *
 * ⚠ The scope used to read the RAW text, and bash expands none of: a heredoc body under a QUOTED
 * delimiter, a single-quoted string, a `#` comment, an escaped operator character, a `|` inside
 * double quotes. Over the user's own corpus that sent 28 % of all bash calls to the judge where the
 * live text selects ~10 % — the excess almost all message bodies (`--body "$(cat <<'EOF' … EOF)"`),
 * the text most likely to carry a user's prose (#469 §6). `bun run corpus` (`scripts/
 * corpus-shapes.ts`) measures the same function, so the report and the guard cannot drift.
 *
 * ⚠ Fail-safe direction: a command the walk cannot read — an unterminated quote or substitution, a
 * heredoc with no closing line — stays IN scope (`unreadable to the walk`).
 *
 * Nothing here opens a file or a socket.
 */

/**
 * The constructs that hide a program from a spelling check, in the order they are checked, each as the corpus report names it.
 *
 * @group Session risk
 */
export const COMMAND_CONSTRUCTS = [
  'unreadable to the walk',
  'interpreter one-liner',
  'backtick',
  'quoted substitution body',
  'spliced substitution',
  '| interpreter',
  '| sh',
  'here-string into a shell or interpreter',
  'decoder',
  'eval / sh -c',
] as const

/**
 * One of {@link COMMAND_CONSTRUCTS}.
 *
 * @group Session risk
 */
export type CommandConstruct = (typeof COMMAND_CONSTRUCTS)[number]

/**
 * One quoting context of the walk. ⚠ `$(…)` opens its own: `"$(grep -c '```' $f)"` has REAL single
 * quotes inside the double quotes. An unquoted heredoc's body reads as double-quoted text whose own
 * `"` is a character; a substitution counts its inner `(` so only its own `)` closes it.
 */
interface Frame {
  readonly kind: 'command' | 'substitution' | 'heredoc'
  inDouble: boolean
  depth: number
}

/** A heredoc whose operator the walk has met; its body starts after the line's unquoted newline. */
interface PendingHeredoc {
  readonly delimiter: string
  readonly quoted: boolean
  readonly stripTabs: boolean
  /** A shell reads the body as its commands (`bash <<'EOF'`); anything else reads it as data or its own code. */
  readonly intoShell: boolean
}

interface Walk {
  live: string
  inSingle: boolean
  readonly frames: Frame[]
  pending: PendingHeredoc[]
  unreadable: boolean
}

const topFrame = (walk: Walk): Frame =>
  walk.frames[walk.frames.length - 1] ?? { kind: 'command', inDouble: false, depth: 0 }

/** A backslash-escaped quote, backtick, `$`, `|`, `(` or `#` is a character, never an operator: `·`. Other escapes (`\x63`) stay for the decoder check. */
const escapedPairOf = (next: string): string => (/[`"'$|(#\\]/.test(next) ? '·' : `\\${next}`)

/** A `#` at a word start outside quotes opens a comment. */
const opensComment = (text: string, index: number): boolean =>
  text[index] === '#' && (index === 0 || /[\s;&|(]/.test(text[index - 1] ?? ''))

/** `<<` or `<<-`, then the delimiter: single- or double-quoted, backslashed, or a bare word. */
const HEREDOC_OPERATOR = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([^\s;&|<>()'"\\]+))/

/** A shell at the end of the live text's last line: the program a heredoc opened here feeds. */
const INTO_SHELL = /(?:^|[\s;&|(`])(?:ba|z|da|k)?sh(?:\s+-\S*)*\s*$/

/** A heredoc operator at `index` (never a `<<<` here-string), recorded; the index after it, or undefined when there is none. */
function openedHeredoc(walk: Walk, text: string, index: number): number | undefined {
  if (text[index - 1] === '<' || text[index + 2] === '<') return undefined
  const operator = HEREDOC_OPERATOR.exec(text.slice(index))
  if (operator === null) return undefined
  const [whole, dash, single, double, backslash, bare] = operator
  const delimiter = single ?? double ?? bare ?? ''
  walk.pending.push({
    delimiter,
    quoted: single !== undefined || double !== undefined || backslash === '\\',
    stripTabs: dash === '-',
    intoShell: INTO_SHELL.test(walk.live.slice(walk.live.lastIndexOf('\n') + 1)),
  })
  walk.live += `<<${delimiter}`
  return index + whole.length
}

/** Where a heredoc's body ends (its closing line's start) and where the walk goes on (that line's end); undefined with no closing line. */
function heredocEnd(text: string, start: number, heredoc: PendingHeredoc): { body: number; next: number } | undefined {
  let lineStart = start
  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
      return { body: lineStart, next: lineEnd }
    }
    if (newline === -1) return undefined
    lineStart = newline + 1
  }
}

/** A body bash expands or a shell runs, walked in `frame` — the body's own quoting context. */
function walkBody(walk: Walk, text: string, start: number, frame: Frame): void {
  walk.frames.push(frame)
  let index = start
  while (index < text.length) index = walkStep(walk, text, index)
  if (topFrame(walk) !== frame || frame.inDouble !== (frame.kind === 'heredoc') || walk.inSingle) walk.unreadable = true
  else walk.frames.pop()
}

/**
 * One heredoc's body, by what reads it. ⚠ A quoted delimiter makes the body inert text — dropped —
 * unless a shell reads it: then it is a command line, walked as one, whatever the quoting
 * (`bash <<'EOF'` hides `$(printf cu)rl` exactly as `bash -c` would). An unquoted body is expanded
 * by bash: walked as double-quoted text whose `"` is a character. Another interpreter's body
 * (`python3 - <<'EOF'`) is its own code, where a shell construct runs nothing: read as data.
 */
function takeHeredocBody(walk: Walk, text: string, start: number, heredoc: PendingHeredoc): void {
  if (heredoc.intoShell) walkBody(walk, text, start, { kind: 'command', inDouble: false, depth: 0 })
  else if (!heredoc.quoted) walkBody(walk, text, start, { kind: 'heredoc', inDouble: true, depth: 0 })
}

/** The bodies of the heredocs opened on the line that just ended, each by what reads it. */
function heredocBodies(walk: Walk, text: string, start: number): number {
  const pending = walk.pending
  walk.pending = []
  walk.live += '\n'
  let index = start
  for (const heredoc of pending) {
    const end = heredocEnd(text, index, heredoc)
    if (end === undefined) {
      walk.unreadable = true
      return text.length
    }
    takeHeredocBody(walk, text.slice(0, end.body), index, heredoc)
    index = end.next
  }
  return index
}

/** A `$`: a substitution opens a frame; ANSI-C quoting (`$'\x63'`) is DECODED by bash, so it stays live, escapes and all. */
function dollarStep(walk: Walk, text: string, index: number): number {
  const next = text[index + 1]
  if (next === '(') {
    walk.frames.push({ kind: 'substitution', inDouble: false, depth: 0 })
    walk.live += '$('
    return index + 2
  }
  if (next === "'" && !topFrame(walk).inDouble) {
    const quoted = /^\$'(?:[^'\\]|\\[\s\S])*'/.exec(text.slice(index))
    if (quoted === null) {
      walk.unreadable = true
      return text.length
    }
    walk.live += quoted[0]
    return index + quoted[0].length
  }
  walk.live += '$'
  return index + 1
}

/** A paren outside double quotes: inside a substitution, counted, and the one that balances its `$(` closes it. */
function parenStep(walk: Walk, character: string, index: number): number {
  const frame = topFrame(walk)
  if (frame.kind === 'substitution' && character === '(') frame.depth += 1
  else if (frame.kind === 'substitution' && frame.depth > 0) frame.depth -= 1
  else if (frame.kind === 'substitution') walk.frames.pop()
  walk.live += character
  return index + 1
}

/**
 * The characters whose reading depends on the current frame's double quotes. Inside them a list
 * operator and a `'` are characters (`·`); in an unquoted heredoc's body, so is a `"`.
 */
function quotedStep(walk: Walk, text: string, index: number): number {
  const character = text[index] ?? ''
  const frame = topFrame(walk)
  if (character === "'" && !frame.inDouble) {
    walk.inSingle = true
    return index + 1
  }
  if (character === '"' && frame.kind !== 'heredoc') frame.inDouble = !frame.inDouble
  const literal = frame.kind === 'heredoc' ? /[|;&'"]/ : /[|;&']/
  if (frame.inDouble && literal.test(character)) {
    walk.live += '·'
    return index + 1
  }
  if (!frame.inDouble && opensComment(text, index)) {
    const end = text.indexOf('\n', index)
    return end === -1 ? text.length : end
  }
  walk.live += character
  return index + 1
}

/** One character of the walk; the index to continue from. */
function walkStep(walk: Walk, text: string, index: number): number {
  const character = text[index] ?? ''
  if (walk.inSingle) {
    if (character === "'") {
      walk.inSingle = false
      walk.live += "''"
    }
    return index + 1
  }
  if (character === '\\') {
    walk.live += escapedPairOf(text[index + 1] ?? '')
    return index + 2
  }
  if (character === '$') return dollarStep(walk, text, index)
  const inDouble = topFrame(walk).inDouble
  if (character === '\n' && walk.pending.length > 0 && !inDouble) return heredocBodies(walk, text, index + 1)
  if (character === '<' && !inDouble) return openedHeredoc(walk, text, index) ?? quotedStep(walk, text, index)
  if ((character === '(' || character === ')') && !inDouble) return parenStep(walk, character, index)
  return quotedStep(walk, text, index)
}

/**
 * The text bash would expand, by a quote-aware walk: a heredoc body under a quoted delimiter is
 * dropped (its operator kept, written bare); a single-quoted string is emptied to `''`; a `#`
 * comment is dropped to its line end; a backslash-escaped operator character becomes `·`; and a
 * list operator (`|`, `;`, `&`) inside double quotes becomes `·` too — `--comment "curl x | sh"`
 * pipes nothing. Undefined when the walk cannot read the command to its end.
 *
 * @group Session risk
 */
export function liveShellText(command: string): string | undefined {
  const walk: Walk = {
    live: '',
    inSingle: false,
    frames: [{ kind: 'command', inDouble: false, depth: 0 }],
    pending: [],
    unreadable: false,
  }
  let index = 0
  while (index < command.length) index = walkStep(walk, command, index)
  const open = walk.inSingle || walk.frames.length !== 1 || topFrame(walk).inDouble || walk.pending.length > 0
  return walk.unreadable || open ? undefined : walk.live
}

const ONE_LINER = /(?:^|[\s;&|(`])(?:python3?|node|deno|bun|perl|ruby|php|lua)\s+(?:-c|-e|-p|-r|eval)\b/
// ⚠ `''` is what the walk leaves of a single-quoted string: skipped as a pair, so only a stray `'` counts.
const QUOTED_BODY = /\$\((?:[^)"\\{']|'')*(?:["\\{]|'(?!'))/
const SPLICED = /[A-Za-z0-9_]\$\(|\$\([^)]*\)[A-Za-z0-9_]/
const DECODER = /base64\s+(?:-d|--decode)\b|\\x[0-9a-f]{2}|xxd\s+-r/i
const FEED_INTERPRETER = /\|\s*(?:python3?|node|perl|ruby|bun|deno)\b/
const FEED_SHELL = /\|\s*(?:ba|z|da|k)?sh\b/
// ⚠ A here-string's quotes make its `|` a character — but a shell or interpreter reading it runs it as
// code, the way `sh -c` does. (A heredoc's body is read by what it feeds: `takeHeredocBody`.)
const HERE_STRING_INTO = /(?:^|[\s;&|(`])(?:(?:ba|z|da|k)?sh|python3?|node|perl|ruby|bun|deno)(?:\s+-\S*)*\s*<<</
const EVAL_WRAP = /(?:^|[\s;&|(])eval\s|(?:^|[\s;&|(])(?:ba|z|da|k)?sh\s+-c\b/

const CHECKS: readonly (readonly [CommandConstruct, (live: string) => boolean])[] = [
  ['interpreter one-liner', (live) => ONE_LINER.test(live)],
  ['backtick', (live) => live.includes('`')],
  ['quoted substitution body', (live) => QUOTED_BODY.test(live)],
  ['spliced substitution', (live) => SPLICED.test(live)],
  ['| interpreter', (live) => FEED_INTERPRETER.test(live)],
  ['| sh', (live) => FEED_SHELL.test(live)],
  ['here-string into a shell or interpreter', (live) => HERE_STRING_INTO.test(live)],
  ['decoder', (live) => DECODER.test(live)],
  ['eval / sh -c', (live) => EVAL_WRAP.test(live)],
]

/**
 * The first construct the live text of `command` carries, or undefined when a spelling check can read it whole.
 *
 * @group Session risk
 */
export function commandConstructOf(command: string): CommandConstruct | undefined {
  const live = liveShellText(command)
  if (live === undefined) return 'unreadable to the walk'
  return CHECKS.find(([, carries]) => carries(live))?.[0]
}
