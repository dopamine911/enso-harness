import { expect, test } from 'bun:test'
import { codeOffenders, hasWordSequence, wordsOf } from './gate-support.ts'

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
 * The allowlist has four entries: this file, which has to spell the words it refuses; the two
 * files holding the one leak the glossary left in place on purpose (L2); and one contract test
 * that reads the vendor's module by design (all below). The renames landed in the same PR as
 * this file, so a fifth entry would be the first regression; an entry needs the reason it is
 * not one, the way the vendor gate's entries do.
 *
 * What it cannot catch: a retired MEANING under a fresh word (`conversation` for a thread).
 * That is a review question; this file holds the words that were decided.
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
 * …and the retired FILE names, matched against a path only. `session inspection` and `zen
 * session` are too common as adjacent prose words (`session: ${inspection.sessionId}`) to
 * refuse on a line; as a file name each is exact.
 */
const RETIRED_PATH_SEQUENCES = [...RETIRED_WORD_SEQUENCES, ['session', 'inspection'], ['zen', 'session']] as const

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
    'scripts/zen-session.mjs',
    'packages/core/src/pi-rpc.ts',
  ]) {
    expect(pathNamesRetired(path)).toBe(true)
  }
  expect(namesRetired("const line = '- session: ' + inspection.sessionId")).toBe(false)
  for (const line of [
    'const { sessionId, sessionDir, sessionFile } = inspection',
    "const origin: ZenUiRequestOrigin = 'session-start'",
    'export const ZenStoredThread = Type.Object({})',
    'const steps = recipe.steps',
    'publishObservation(feed, mapPiEvent(event, delivery))', // mid-identifier: names what it maps
    "for (const name of ['PATH', 'PI_CODING_AGENT_DIR'])", // the runtime's own variable
    "if (observation.kind === 'turn-end') turn += 1", // `turn`, singular, is a word of ours
  ]) {
    expect(namesRetired(line)).toBe(false)
  }
})
