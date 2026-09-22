import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATES, reportsWorkerAbort } from '../scripts/gate.ts'

/**
 * The gate's blind spot, closed (#157): a tool that dies mid-run and still exits 0.
 *
 * Measured 2026-09-10 — Biome 2.5.13 with any GritQL plugin loaded overflows a worker's
 * stack, prints `fatal runtime error: stack overflow, aborting`, and exits **0**. The files
 * that worker held go unchecked and `bun run check` says green. Every other gate failure
 * announces itself in the exit code; this one does not, so it is the one worth a test.
 */

test('⚠ a tool that aborts a worker is a failure whatever it exited with', () => {
  // The verbatim banner Biome 2.5.13 printed, and the other runtimes' equivalents.
  expect(reportsWorkerAbort("thread 'biome::workspace_worker_4' (3220082) has overflowed its stack")).toBe(true)
  expect(reportsWorkerAbort('fatal runtime error: stack overflow, aborting')).toBe(true)
  expect(reportsWorkerAbort("thread 'main' panicked at src/lib.rs:42:9:")).toBe(true)
  expect(reportsWorkerAbort('Segmentation fault (core dumped)')).toBe(true)
})

test('ordinary stderr is not an abort — diagnostics, warnings and an empty stream all pass', () => {
  expect(reportsWorkerAbort('')).toBe(false)
  expect(reportsWorkerAbort('Found 214 warnings.\nChecked 185 files in 1301ms.')).toBe(false)
  expect(reportsWorkerAbort('error: script "lint" exited with code 1')).toBe(false)
  // A test NAMING the banner (this file does) is prose in someone's output, not an abort of
  // the tool that printed it — the scan reads the running tool's stderr, nothing else.
  expect(reportsWorkerAbort('the message says stack overflow when it aborts')).toBe(false)
})

/**
 * The second way `bun run check` reports a green it has not earned (#257): the header of
 * `scripts/gate.ts` is the documented authority for what "green" means
 * (`docs/verification.md`: "each gate's header is the authority"), and it had drifted to the
 * ported blueprint's — three checks where the file runs five, `vitest run` for `bun test`,
 * `tsc --noEmit` for a project-reference build that emits declarations. Nothing exited non-zero;
 * a reader auditing the gate list simply concluded fallow and the coverage floor were not part
 * of green. Same class as the abort above — the run says nothing is wrong — so it is checked
 * here, where the subject is already `scripts/gate.ts`.
 *
 * It pins the row STRUCTURE, never the prose: the ordered names and the first backticked command
 * on each row. The reasoning around them is free to be rewritten.
 */
const HEADER_GATE_ROW = /^\s*\*\s+\d+\.\s+(\S+)\s+—\s+`([^`]+)`/

test('⚠ the header of scripts/gate.ts names the gates the file actually runs, with their real commands', async () => {
  const source = await Bun.file(join(import.meta.dir, '..', 'scripts', 'gate.ts')).text()
  const rows = source
    .split('\n')
    .map((line) => HEADER_GATE_ROW.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[1] ?? '', command: match[2] ?? '' }))
  const packageScripts = (await Bun.file(join(import.meta.dir, '..', 'package.json')).json()).scripts as Record<
    string,
    string
  >
  expect(rows).toEqual(GATES.map((gate) => ({ name: gate.name, command: packageScripts[gate.script] ?? '' })))
})

/**
 * The same drift, one file further out (#188): `docs/verification.md` is the page a reader is
 * pointed at for what green means, and it said **five gates** for the whole life of the sixth.
 * #327 added `api-docs` to `GATES`, to the gate header — which this file already held — and to
 * the generated inventory, and the hand-written page beside them went on saying five, twice, in
 * a numbered list that stopped one step early. Nothing exited non-zero.
 *
 * It pins the COUNT and the ordered numbered names, not the prose: each step's paragraph is
 * free to be rewritten, and the word is checked in the two places the page states it.
 */
const NUMBERED_STEP = /^(\d+)\.\s+\*\*(.+?)\*\*/gm
const COUNT_WORDS_TWENTY: readonly string[] = [
  ...['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
  ...['eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'],
  ...['twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five'],
]
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const

test('⚠ docs/verification.md counts and numbers the gates the file actually runs (#188)', async () => {
  const page = await Bun.file(join(import.meta.dir, '..', 'docs', 'verification.md')).text()
  const steps = [...page.matchAll(NUMBERED_STEP)].map((match) => Number(match[1]))
  expect(steps).toEqual(GATES.map((_gate, index) => index + 1))
  const word = COUNT_WORDS[GATES.length]
  if (word === undefined) throw new Error(`gate-abort: no English word for ${GATES.length} gates`)
  // Both statements: the lead sentence and the CI paragraph's "<word>-step gate".
  expect(page).toContain(`${word.charAt(0).toUpperCase()}${word.slice(1)} gates, in order`)
  expect(page).toContain(`${word}-step gate`)
})

/**
 * The free prose around the lists names gates by number too — "gate 7 builds the site", "it is
 * gate 5 inside check:all" — and the pins above cannot see it: they match list rows. #342
 * inserted a gate and three such sentences kept their old numbers in the two files the PR was
 * renumbering (PR #345 review). So each mention is read as a sentence, and the sentence must
 * name the gate it points at — by the gate's own name, or by a word only that gate's work uses.
 */
const GATE_PROSE_MARKS: Readonly<Record<string, RegExp>> = {
  biome: /biome|lint/i,
  typecheck: /typecheck|tsc/i,
  'dead-code': /dead-code|fallow/i,
  'react-doctor': /react-doctor/i,
  test: /bun test|the suite/i,
  coverage: /coverage/i,
  'api-docs': /typedoc|api-docs/i,
  site: /site|build|crawl/i,
}

test('⚠ every prose "gate N" names the gate it points at — the lists are pinned, the sentences were not (#342)', async () => {
  const pages = ['docs/verification.md', 'README.md', 'scripts/gate.ts', join('.github', 'workflows', 'ci.yml')]
  const misses: string[] = []
  for (const page of pages) {
    const source = await Bun.file(join(import.meta.dir, '..', page)).text()
    for (const match of source.matchAll(/\bgate (\d+)\b/g)) {
      const number = Number(match[1])
      const gate = GATES[number - 1]
      const at = match.index ?? 0
      // The sentence: back to the previous full stop or blank line, forward to the next.
      const start = Math.max(source.lastIndexOf('. ', at), source.lastIndexOf('\n\n', at)) + 1
      const stop = source.indexOf('.', at + match[0].length)
      const sentence = source
        .slice(start, stop === -1 ? undefined : stop)
        .replace(/\s+/g, ' ')
        .trim()
      const mark = gate === undefined ? undefined : GATE_PROSE_MARKS[gate.name]
      if (gate === undefined) misses.push(`${page}: "${sentence}" — there is no gate ${number}`)
      else if (mark === undefined) misses.push(`gate-abort: no prose mark for gate "${gate.name}"`)
      else if (!mark.test(sentence)) misses.push(`${page}: "${sentence}" — gate ${number} is ${gate.name}`)
    }
  }
  expect(misses).toEqual([])
})

/**
 * Builds a throwaway package whose `lint` gate runs `body`, then runs the real
 * `scripts/gate.ts` against it.
 */
function runGateOver(body: string): { status: number | null; stdout: string; stderr: string; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'enso-gate-abort-'))
  writeFileSync(join(scratch, 'crash.sh'), `#!/bin/sh\n${body}`, { mode: 0o755 })
  // ⚠ DERIVED FROM `GATES`, never listed (#188): a hand-written set of five stopped matching
  // the day a sixth gate was added, and the fixture then failed on the missing script rather
  // than on the crash it exists to reproduce — a red test that says nothing about its subject.
  // Every gate is a no-op here except `lint`, which is the one under test.
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'gate-abort-fixture',
      private: true,
      packageManager: 'bun@1.4.0',
      scripts: { ...Object.fromEntries(GATES.map((gate) => [gate.script, 'true'])), lint: './crash.sh' },
    }),
  )

  const run = spawnSync('bun', [join(import.meta.dir, '..', 'scripts', 'gate.ts')], {
    cwd: scratch,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, output: `${run.stdout}${run.stderr}` }
}

/**
 * End to end, because the unit above cannot prove the wiring: a gate script that prints the
 * banner and exits 0 must take the whole gate down.
 */
test('⚠ end to end: a gate script that prints the banner and exits 0 still fails the run', () => {
  // Exits 0 on purpose — that is the whole point.
  const run = runGateOver(
    'echo "thread \'biome::workspace_worker_0\' has overflowed its stack" >&2\necho "fatal runtime error: stack overflow, aborting" >&2\nexit 0\n',
  )
  expect(run.status).toBe(1)
  expect(run.output).toContain('ABORTED')
  // …and it stops there rather than running the gates behind it on a broken tree.
  expect(run.output).not.toContain('All gates passed')
})

/**
 * A tool that says a lot before it dies is still a tool that died. stderr is streamed and
 * scanned as it passes, never accumulated, so there is no size at which the gate stops
 * reading — a buffered read would have hit its 1 MB ceiling here and reported the crash as
 * something else entirely.
 *
 * ⚠ AND THE VERDICT HAS TO SURVIVE THE EXIT. This test was intermittent — roughly one run in
 * three here, and a CI failure on an unrelated PR — because `gate.ts` ended with
 * `process.exit(1)`. Both of the gate's own streams are pipes under `spawnSync`, so its
 * writes were queued rather than performed, and exiting threw the queue away: 2 MB of
 * backlog ahead of them meant the ABORTED line and the failure line, written microseconds
 * before, never reached the reader. Measured 12 of 12 runs losing both, 12 of 12 keeping
 * them once the gate set `exitCode` and returned instead. The last assertion is the one that
 * fails if that regresses — detecting the abort is worth nothing if saying so is dropped.
 */
test('⚠ megabytes of stderr before the banner does not hide the abort', () => {
  const run = runGateOver(
    "head -c 2000000 /dev/zero | tr '\\0' 'x' >&2\necho >&2\necho 'fatal runtime error: stack overflow, aborting' >&2\nexit 0\n",
  )
  expect(run.status).toBe(1)
  expect(run.output).toContain('ABORTED')
  expect(run.output).not.toContain('failed to spawn')
  expect(run.output).toContain('✗ gate "biome" failed.')
})

/**
 * Both streams are piped, so the gate is now the only writer to the terminal. Every line the
 * tool wrote must arrive whole and on the stream it was written to — an earlier revision
 * inherited stdout while piping stderr, and Biome's diagnostics and its summary spliced into
 * each other mid-line. (Ordering ACROSS the two streams is grouped in chunks, not exact;
 * that is the price of reading either of them.)
 */
test('⚠ a tool writing both streams has every line arrive whole, on the stream it came from', () => {
  const run = runGateOver('i=0\nwhile [ $i -lt 300 ]; do\n  echo "out $i"\n  echo "err $i" >&2\n  i=$((i+1))\ndone\n')
  expect(run.status).toBe(0)
  const lines = (stream: string, tag: string): string[] => stream.split('\n').filter((line) => line.startsWith(tag))
  expect(lines(run.stdout, 'out ')).toEqual(Array.from({ length: 300 }, (_, index) => `out ${index}`))
  expect(lines(run.stderr, 'err ')).toEqual(Array.from({ length: 300 }, (_, index) => `err ${index}`))
})

/**
 * stdout is forwarded but never scanned. A linter quoting source — this very file names every
 * banner, and Biome prints the offending lines — must not read as its own death.
 */
test('⚠ a banner quoted on stdout is a tool reporting, not a tool dying', () => {
  const run = runGateOver('echo "fatal runtime error: stack overflow, aborting"\necho "  > 42 | Segmentation fault"\n')
  expect(run.status).toBe(0)
  expect(run.output).toContain('All gates passed')
  expect(run.output).not.toContain('ABORTED')
})

/**
 * The README states two censuses, and a hand-copied number is a fact with a half-life (PR #335
 * review). One of them — "1016 tests" — was deleted rather than checked, because a count that
 * changes every time a test is added is stale by construction and cannot be asserted without the
 * assertion changing it. The other two are stable enough to hold, so they are held:
 *
 *   • the numbered step table, against `GATES` — the same drift `docs/verification.md` carried for
 *     the whole life of the sixth gate;
 *   • "<word> of those tests are gates", against the rows of the generated inventory the sentence
 *     is about.
 */
const GATE_STEP_ROW = /^\| (\d+) \| `([a-z-]+)` \|/gm
const STATED_GATE_COUNT = /^([A-Z][a-z]+) of those tests are \*\*gates\*\*/m

test('⚠ the README names the gate steps the file runs, and counts the gates the inventory lists (#335)', async () => {
  const readme = await Bun.file(join(import.meta.dir, '..', 'README.md')).text()
  const rows = [...readme.matchAll(GATE_STEP_ROW)].map((match) => ({
    position: Number(match[1]),
    name: match[2] ?? '',
  }))
  expect(rows).toEqual(GATES.map((gate, index) => ({ position: index + 1, name: gate.name })))

  const inventory = await Bun.file(join(import.meta.dir, '..', 'docs', 'reference', 'verification-inventory.md')).text()
  const section = inventory.slice(inventory.indexOf('## Enforcement gates'))
  const listed = [...section.slice(0, section.indexOf('\n## ', 1)).matchAll(/^\| \[/gm)].length
  const stated = STATED_GATE_COUNT.exec(readme)?.[1]?.toLowerCase()
  if (stated === undefined) throw new Error('README states no "<word> of those tests are gates" count')
  expect(COUNT_WORDS_TWENTY.indexOf(stated)).toBe(listed)
})
