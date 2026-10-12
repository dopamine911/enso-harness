import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { codeOffenders, hasWordSequence, isCommentLine, REPOSITORY_ROOT, sourceFiles, wordsOf } from './gate-support.ts'

/**
 * The glossary's Retired table, applied to the source tree (#165, `docs/glossary.md` → Retired).
 *
 * ⚠ Enforcement, not a unit test — the shape of `vendor-gate.test.ts`. A word the glossary
 * retired may not come back as an identifier, a string, or a file name outside the two roots
 * where the vendor's own names are legitimate. Comment lines are skipped: prose may say what
 * a thing used to be called. It reads WORDS (`gate-support.ts`), so `HostedSession`,
 * `hosted_session` and `hosted-session` are one mention and `sessionId` is not one — the
 * three log-locating fields are the glossary's stated exception, and `session` alone is the
 * runtime's log, which the glossary reserves rather than retires.
 *
 * The allowlist has TWO entries: this file, which has to spell the words it refuses, and one
 * contract test that reads the vendor's module by design (both below). It had four. The other two
 * held leak L2 — the runtime's event and persistence shapes carried above the host in
 * `packages/web/src/rpc/map-events.ts` and `branch-to-messages.ts` — and they left WITH the leak,
 * not instead of it: `184641d` closed the event side ("the thread-runtime seam delivers
 * observations; the runtime's event shape never leaves the host") and `c75f567` the persistence
 * side ("the host produces a transcript of ours"), each deleting its own row. Reading the stale
 * header, you could not tell a fixed leak from a lost one (#257). A third entry now would be the
 * first regression; an entry needs the reason it is not one, the way the vendor gate's entries do.
 *
 * What it cannot catch: a retired MEANING under a fresh word (`conversation` for a thread).
 * That is a review question; this file holds the words that were decided.
 *
 * The second test reads the table's OTHER column. #241: two rows named replacements that were
 * in no source file (`describeRuntimeEvent` for what is `describeObservation`, `describeEntry`
 * for `describeTranscriptEntry`) — the table claims to be the rename authority, and half of it
 * was unverified prose, so a session applying it would have coined the wrong name beside the
 * right one. Bold + backticks in the Replacement column is the decided code name; it must
 * exist. Prose replacements (**threads**, **prompts**, **kept**, **none**) carry no backticks
 * and are not claims about identifiers.
 * A decided name must be DECLARED, not contained (PR #287 review): the matcher reads whole
 * tokens, for the reason on `spelledNames`.
 */

const SEARCHED_ROOTS = ['packages/core/src', 'packages/web/src', 'packages/harness', 'scripts', 'test'] as const
/** Where the runtime's own names may stay — the vendor gate's two roots. */
const VENDOR_ROOTS = ['packages/web/src/host', 'packages/harness/extensions'] as const

/** The Retired table's identifiers, as word sequences: what a code line may not spell. */
const RETIRED_WORD_SEQUENCES = [
  ['pi', 'session'],
  ['hosted', 'session'],
  ['stored', 'session'],
  ['custom', 'session', 'entry'],
  ['describe', 'session', 'entry'],
  ['pi', 'rpc'],
  ['recorded', 'custom', 'chunk'],
  ['tool', 'step'],
  ['turns'],
] as const
/**
 * The L1 class, not its instances (PR #166 review): a `Pi`-prefixed identifier — `PiCommand`,
 * `PiPromptRequest`, `isPiCommand`, and whatever is coined next — is the vendor's name on a
 * shape of ours. This is the third test `vendor-gate.test.ts`'s header anticipated. Token
 * start only: `mapPiEvent` names what it maps, `PI_CODING_AGENT_DIR` is the runtime's own
 * variable, and neither is a shape.
 */
const VENDOR_PREFIXED_IDENTIFIER = /\bPi[A-Z][A-Za-z0-9]*|\bisPi[A-Z]/
/**
 * …and the retired FILE names, matched against a path only. `session inspection` and `enso
 * session` are too common as adjacent prose words (`session: ${inspection.sessionId}`) to
 * refuse on a line; as a file name each is exact.
 */
const RETIRED_PATH_SEQUENCES = [...RETIRED_WORD_SEQUENCES, ['session', 'inspection'], ['enso', 'session']] as const

const RETIRED_ALLOWED: readonly string[] = [
  // The gate itself: it names the retired words in order to refuse them.
  'test/glossary-gate.test.ts',
  // `PiPathsModule`: a contract test that imports the runtime's own `utils/paths.js` to keep
  // the guard's replica honest. The type IS the vendor's module, in the one test written to
  // read it; the name says so. Stays as long as the replica does.
  'packages/harness/core/__tests__/paths.test.ts',
]

function namesRetired(line: string): boolean {
  const words = wordsOf(line)
  return (
    VENDOR_PREFIXED_IDENTIFIER.test(line) || RETIRED_WORD_SEQUENCES.some((sequence) => hasWordSequence(words, sequence))
  )
}

function pathNamesRetired(repositoryRelative: string): boolean {
  const words = wordsOf(repositoryRelative)
  return RETIRED_PATH_SEQUENCES.some((sequence) => hasWordSequence(words, sequence))
}

test('⚠ a retired word does not come back — as an identifier, a string, or a file name (#165)', () => {
  expect(
    codeOffenders({
      roots: SEARCHED_ROOTS,
      includeTests: true,
      exemptRoots: VENDOR_ROOTS,
      allowed: RETIRED_ALLOWED,
      pathMatches: pathNamesRetired,
      lineMatches: namesRetired,
    }),
  ).toEqual([])
})

/** The Retired table's rows: the section runs to the next `## ` heading. */
function retiredTableRows(): string[] {
  const glossary = readFileSync(join(REPOSITORY_ROOT, 'docs/glossary.md'), 'utf8')
  const section = glossary.slice(glossary.indexOf('\n## Retired')).split('\n## ').slice(0, 2).join('')
  return section
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| Retired |'))
}

/** Every decided replacement name: bold + backticks, in the Replacement column only. */
function decidedReplacements(rows: readonly string[]): string[] {
  const names: string[] = []
  for (const row of rows) {
    const replacement = row.split('|')[3] ?? ''
    for (const bolded of replacement.matchAll(/\*\*`([^`]+)`\*\*/g)) names.push(bolded[1] ?? '')
  }
  return names
}

/**
 * Every whole name a file's code spells: tokens, split on what cannot be part of a name.
 *
 * ⚠ Tokens — not substrings, and NOT the sibling gate's word sequences (PR #287 review). The
 * two matchers answer opposite questions. Refusing a retired word wants breadth, so
 * `hasWordSequence` matches a longer name's prefix on purpose: `hosted_session` and
 * `HostedSession` are one mention. Asking whether a decided name EXISTS wants the opposite —
 * `describe | observation` are the first two words of `describeObservationList`, and
 * `includes()` finds the name inside it, so either matcher would vouch for a name nothing
 * declares, which is the hole #241 found by hand. A hyphen is part of a name here: a status
 * attribute is one token, not three words.
 */
function spelledNames(code: string): Set<string> {
  return new Set(code.split(/[^\w$-]+/))
}

interface SpelledFile {
  /** The file's base name — what a replacement that names a MODULE has to equal. */
  readonly name: string
  /** Every whole name its non-comment code spells. */
  readonly spelled: ReadonlySet<string>
}

/** A type's member: the one dotted shape that is not a file name (`HostedThread.runtime`). */
const TYPE_MEMBER = /^[A-Z][A-Za-z0-9]*\.[A-Za-z_$][\w$]*$/

/**
 * Whether the tree declares `replacement` — by SHAPE, and fail-closed on a shape it does not
 * know (PR #287 review).
 *
 * An undotted name is an identifier and must be spelled as a whole token. A dotted name is a
 * FILE and must equal a base name: the table sends a reader to a module, which an identifier
 * sharing the module's stem does not satisfy. The one exception is a type's member, checked
 * per part — no single line has to spell the access, and whether the field is on that type is
 * the type checker's job at every call site.
 *
 * ⚠ No extension list. Naming the extensions a file may end in (`ts|tsx|mjs`) meant a future
 * `.js`, `.json` or `.css` row fell through to the per-part check and was satisfied by its own
 * stem — the stem match this test exists to refuse, re-admitted by the row that grows the
 * table. An unrecognised dotted shape is now REPORTED rather than guessed at: a false red that
 * names the row, not a silent green.
 */
function declares(files: readonly SpelledFile[], replacement: string): boolean {
  if (!replacement.includes('.')) return files.some((file) => file.spelled.has(replacement))
  if (files.some((file) => file.name === replacement)) return true
  if (!TYPE_MEMBER.test(replacement)) return false
  return replacement.split('.').every((part) => files.some((file) => file.spelled.has(part)))
}

test('⚠ every replacement the Retired table decided is a name that exists (#241)', () => {
  const rows = retiredTableRows()
  // The table is the subject: an empty parse would pass every assertion below.
  expect(rows.length).toBe(21)
  const sources = SEARCHED_ROOTS.flatMap((root) => sourceFiles(join(REPOSITORY_ROOT, root), true))
  // ⚠ CODE lines, not the file's text: this gate's own header names `describeRuntimeEvent` to
  // explain #241, and scanning text let that comment vouch for the name — the first probe
  // passed when it had to fail. Prose may say what a thing is NOT called; only code declares.
  const files = sources.map((path) => ({
    name: basename(path),
    spelled: spelledNames(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !isCommentLine(line))
        .join('\n'),
    ),
  }))
  const missing = decidedReplacements(rows).filter((replacement) => !declares(files, replacement))
  expect(missing).toEqual([])
})

test('the matcher sees a retired name however it is spelled, and leaves the reserved word alone', () => {
  for (const line of [
    'const session: PiSession = fake()',
    "import type { HostedSession } from '../host/agent-host.ts'",
    'return <ToolStep selected={selected} />',
    'export type PiDialogResponse = { id: string }', // the class: any Pi-prefixed shape
    'export function isPiCommand(value: unknown): boolean {',
    'readonly turns: number',
  ]) {
    expect(namesRetired(line)).toBe(true)
  }
  for (const path of [
    'packages/core/src/session-inspection.ts',
    'scripts/enso-session.mjs',
    'packages/core/src/pi-rpc.ts',
  ]) {
    expect(pathNamesRetired(path)).toBe(true)
  }
  expect(namesRetired("const line = '- session: ' + inspection.sessionId")).toBe(false)
  for (const line of [
    'const { sessionId, sessionDir, sessionFile } = inspection',
    "const origin: EnsoUiRequestOrigin = 'session-start'",
    'export const EnsoStoredThread = Type.Object({})',
    'const steps = recipe.steps',
    'publishObservation(feed, mapPiEvent(event, delivery))', // mid-identifier: names what it maps
    "for (const name of ['PATH', 'PI_CODING_AGENT_DIR'])", // the runtime's own variable
    "if (observation.kind === 'turn-end') turn += 1", // `turn`, singular, is a word of ours
  ]) {
    expect(namesRetired(line)).toBe(false)
  }
})

test('a decided name has to be declared, not merely contained (#241, PR #287 review)', () => {
  const spelled = spelledNames("export function describeObservationList(entries: string[]) { return 'ok' }")
  expect(spelled.has('describeObservationList')).toBe(true)
  expect(spelled.has('describeObservation')).toBe(false)
  // Why not the sibling matcher: it says yes to the same longer name, by design.
  expect(hasWordSequence(wordsOf('describeObservationList'), ['describe', 'observation'])).toBe(true)
  // A hyphenated attribute is one name, so a longer attribute is not it.
  expect(spelledNames('<span data-enso-tool-call="running" />').has('data-enso-tool-call')).toBe(true)
  expect(spelledNames('<span data-enso-tool-call-status="running" />').has('data-enso-tool-call')).toBe(false)
})

test('a replacement is resolved by shape, and an unknown shape is reported (#241, PR #287 review)', () => {
  const files: SpelledFile[] = [
    { name: 'thread-inspection.ts', spelled: new Set(['thread-inspection', 'HostedThread', 'runtime']) },
  ]
  expect(declares(files, 'thread-inspection.ts')).toBe(true)
  expect(declares(files, 'HostedThread.runtime')).toBe(true)
  expect(declares(files, 'HostedThread.session')).toBe(false)
  // The extension list's hole: a module the tree does not have, satisfied by its own stem.
  expect(declares(files, 'thread-inspection.js')).toBe(false)
  // A shape the resolver does not know is refused, not guessed at — a red that names the row.
  expect(declares(files, 'styles/global.css')).toBe(false)
})
