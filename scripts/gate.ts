#!/usr/bin/env node
/**
 * Ported from slop-factory's bun example (examples/bun/scripts/gate.ts) — the shape is
 * deliberately identical so improvements travel in either direction.
 *
 * The single repo-wide gate. One ordered list of checks; `check:all` delegates
 * here, and both the pre-commit hook and CI invoke `check:all` — so one list is
 * the single source of what "green" means everywhere. Add a check here and every
 * caller inherits it.
 *
 * Ordering is cheap-first: a fast format or lint failure surfaces before the slower
 * typecheck and test gates run.
 *
 * The checks, in the order GATES lists them:
 *   1. format    — `bun --bun oxfmt --check`: formatting, import order and Tailwind class order
 *                  (check-only, no writes). `.oxfmtrc.json` is the style; `bun run format` writes it.
 *   2. lint      — `bun --bun oxlint`: the rules in `oxlint.config.ts`, type-aware, including the
 *                  naming gate (the `enso` plugin, scripts/lint/). `--bun` runs oxlint's Node entry
 *                  under Bun, which loads the TypeScript config and plugin without depending on
 *                  the Node version a machine or CI runner happens to carry.
 *   3. typecheck — `tsc -b --pretty false --checkers 4`: a project-reference BUILD, not `--noEmit`. The
 *                  blueprint's `--noEmit` is not available here and the difference is not
 *                  cosmetic: `composite` is required by project references, `composite` requires
 *                  declaration emit, and `tsc -b --noEmit` is refused outright — measured
 *                  2026-09-18, `error TS6310: Referenced project '…/packages/core' may not
 *                  disable emit`. So this gate WRITES: `emitDeclarationOnly` declarations into
 *                  each package's `dist-types/`, gitignored, and fallow skips them. `tsc` is
 *                  TypeScript 7's native binary (#745); `--checkers 4` is its default, written
 *                  down so a laptop and CI split the program across the same checkers whatever
 *                  a later 7.x defaults to.
 *   4. dead-code — `fallow dead-code --quiet`: fails on ANY unused file, export, type or dependency.
 *                  No baseline since #594 — it had held zero findings since #263, and re-saving it
 *                  was the one way to accept a finding silently. After typecheck, because
 *                  fallow's graph is syntactic.
 *   5. complexity — `fallow health --complexity --max-cognitive 20 --max-cyclomatic 1000 --quiet`: every
 *                  function under the cognitive ceiling of 20 (25 until #595), or under its own per-function pin
 *                  in `.fallowrc.jsonc` (`health.thresholdOverrides`). Cyclomatic is lifted out of
 *                  reach on purpose: cognitive is what a reader pays for.
 *   6. new-complexity — `fallow health --complexity --max-cognitive 15 --max-cyclomatic 1000 --quiet --baseline complexity-baseline.json --baseline-mode identity --fail-on-stale-baseline`:
 *                  every function NOT in `complexity-baseline.json` (an identity baseline of the
 *                  functions already over 15 when it was taken, #594) under 15, fallow's default.
 *                  New or renamed code meets the stricter number; listed code is held by the
 *                  ceiling. A listed function that no longer needs its entry fails: here when its
 *                  whole file has none left, and in `test/complexity-ratchet.test.ts` for the single
 *                  function. `bun run complexity:baseline` re-saves the list.
 *   7. duplication — `fallow dupes --quiet --summary`: duplicated lines under `duplicates.threshold`
 *                  in `.fallowrc.jsonc`, a ratchet that may only fall (#593). Semantic mode; what is
 *                  excluded from the count, and why, is recorded beside the threshold. `--summary`
 *                  prints the rate and the counts, not every clone group: on a pass the listing was
 *                  ~95 lines per commit, and `bunx fallow dupes` prints it when a failure needs it.
 *   8. react-doctor — `react-doctor --project packages/web --scope full --no-score --no-supply-chain --blocking warning`:
 *                  react-doctor's lint pass over the web surface, failing on any finding, warnings
 *                  included (#342, #747). Offline by construction: `--no-score` skips the score API, the
 *                  share URL and the crash trace, `--no-supply-chain` the Socket.dev lookups — a
 *                  pre-commit hook must not phone home. ⚠ That is also why the gate holds no SCORE
 *                  (#747): the number is computed by react.doctor's API from an upload of every
 *                  finding plus repo and sha, by a formula that can move without a pin bump; measured,
 *                  85 on that scale is "at most four warnings on the surface", which `--blocking
 *                  warning` holds locally, with zero. After typecheck, as dead-code is: the pass
 *                  is syntactic. The rule set is upstream's and moves between versions, so a bump
 *                  of the `react-doctor` pin is a gate change and is reviewed as one (#208). The
 *                  ported `src/components/` are out of its scan (`packages/web/doctor.config.json`),
 *                  the same boundary the linter, coverage and fallow draw (presentation-gate.test.ts).
 *                  Cost: ~1.4 s wall for 141 files (measured 2026-09-23) — a rounding error beside
 *                  `bun test`. The human-facing `doctor` script (`bunx react-doctor --verbose`) keeps
 *                  the score and the share URL because a developer reading a report wants them; it
 *                  runs the same pin, with a developer's ambient credentials, never in the gate.
 *   9. test      — `bun test`, not `vitest run`. bunfig keeps coverage always on, so this
 *                  writes `coverage/lcov.info` for gate 10.
 *   10. coverage — `bun scripts/check-coverage.ts`: the TOTAL line and function floors over the
 *                  full denominator, which bun's own per-file `coverageThreshold` cannot express.
 *   11. api-docs — `typedoc --emit none`: the owned contract surface across both barrels, with warnings
 *                  FATAL. TypeDoc's warnings are documentation drift — a `{@link}` whose target
 *                  was renamed, a type a documented signature exposes but nothing exports — and
 *                  none of them is visible to `tsc`. `--emit none`: it VALIDATES, and the site
 *                  renders the same surface as native pages (`starlight-typedoc`), so the
 *                  contract is converted once for checking and once for reading (#188).
 *   12. site     — `bun scripts/docs/build-docs.ts && bun scripts/docs/site-content.ts && bunx astro build --root site && bun scripts/docs/site-links.ts`:
 *                  builds every generated and flow page (#482), projects `docs/` into the Starlight site, builds it, and
 *                  crawls every built page for dead internal links. The BUILD is not the check —
 *                  `astro build` reported success over 139 dead links, because a page's
 *                  `./routes.md` is correct on GitHub and a 404 as a route. The crawl is (#188).
 *   13. crap     — `bun scripts/coverage-istanbul.ts && fallow health --complexity --max-cognitive 1000 --max-cyclomatic 1000 --max-crap 30 --report-only --coverage coverage/coverage-final.json --top 10 --sort severity --quiet`:
 *                  CRAP as WARNINGS (#826): converts the LCOV `test` wrote into Istanbul, then lists
 *                  the ten worst functions at CRAP ≥ 30 from measured coverage and the total.
 *                  `--report-only`: it never fails. It is its own step, not `health.maxCrap` in the
 *                  config, because CRAP on in the config changes the key of the function
 *                  `complexity-baseline.json` holds and fails the new-complexity step, and because
 *                  only a step after `test` can score from measured coverage, on CI and laptops alike.
 *
 * ⚠ Each row's name and first backticked command is CHECKED against GATES and package.json by
 * `test/gate-abort.test.ts`, because this list is the documented authority for what "green" means
 * (`docs/verification.md`) and a header nothing checks is a header that drifts. It did: it named
 * three checks, `vitest run`, and `tsc --noEmit` (#257), so a reader auditing coverage of the gate
 * list concluded that fallow and the coverage floor were not part of green.
 *
 * ADDING A GATE. This is the extension point a project adopting the blueprint is
 * expected to use: append an entry to GATES and every caller (the pre-commit hook,
 * CI, a developer running `npm run check:all`) inherits it with no other edit. Put
 * expensive behavioural checks LAST so the cheap ones fail fast — e.g. a build, an
 * IaC synth, a container smoke test, a schema-compatibility check.
 *
 * Runtime is node — `check:all` runs `node scripts/gate.ts`, and Node strips the
 * TypeScript types at load. Each gate shells out through `npm run <script>`, so a
 * command's definition lives in exactly one place: package.json.
 */
import { spawn } from 'node:child_process'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/**
 * The package managers this gate knows how to shell out to. Each runs a package.json script with
 * `<manager> run <script>`, so the invocation shape is identical and only the binary differs.
 */
const KNOWN_PACKAGE_MANAGERS = ['npm', 'bun', 'pnpm', 'yarn'] as const
type PackageManager = (typeof KNOWN_PACKAGE_MANAGERS)[number]

const DEFAULT_PACKAGE_MANAGER: PackageManager = 'npm'

/**
 * Which package manager to shell out to for each gate.
 *
 * Hardcoding `npm` here was a real portability bug: `bun scripts/gate.ts` runs the TypeScript fine
 * (Bun executes `.ts` natively) and then dies with `Executable not found in $PATH: "npm"` on a
 * machine that has only Bun. Two signals, in order:
 *
 *   1. `npm_config_user_agent` — every major package manager sets it when running a script, and its
 *      first token is the manager's name (`bun/1.3.14 …`, `npm/11.17.0 …`). This is authoritative
 *      when the gate was reached via `<manager> run check:all`, which is the normal path.
 *   2. The runtime itself — when the script is invoked DIRECTLY (`bun scripts/gate.ts`) no user
 *      agent is set, but a `Bun` global means we are under Bun and should use it.
 *
 * Falls back to npm, which is correct for `node scripts/gate.ts` on a normal Node install.
 */
function detectPackageManager(): PackageManager {
  const userAgent = process.env.npm_config_user_agent
  if (userAgent !== undefined) {
    const managerName = userAgent.split('/')[0]
    const knownManager = KNOWN_PACKAGE_MANAGERS.find((candidate) => candidate === managerName)
    if (knownManager !== undefined) {
      return knownManager
    }
  }
  // Reading the global this way (rather than declaring `Bun`) keeps the check dependency-free and
  // avoids `any` — the repo bans it, and pulling in @types/bun for one truthiness test is worse.
  const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  return isBunRuntime ? 'bun' : DEFAULT_PACKAGE_MANAGER
}

const PACKAGE_MANAGER = detectPackageManager()

/** One child-process gate: a display name, a one-line description, and the script it runs. */
interface Gate {
  readonly name: string
  readonly describe: string
  /** The package.json script name — run as `<package manager> run <script>`. */
  readonly script: string
}

/** Exported for `test/gate-abort.test.ts`, which holds the header above equal to this list (#257). */
export const GATES: readonly Gate[] = [
  {
    name: 'format',
    describe: 'oxfmt: formatting, import order, Tailwind class order (check-only)',
    script: 'format:check',
  },
  {
    name: 'lint',
    describe: 'oxlint: the rules in oxlint.config.ts, type-aware, naming gate included',
    script: 'lint',
  },
  {
    // `tsc -b`, never `--noEmit` (#229, #257): project references need `composite`, `composite`
    // needs declaration emit, and `tsc -b --noEmit` is refused outright — TS6310. So this step
    // WRITES: each project's own `dist-types/`, gitignored. It is the only gate that leaves
    // build state behind, which is why two checkouts running it over one tree fight, and why
    // the operator is told it emits rather than being sold a no-emit check.
    name: 'typecheck',
    describe: 'tsc -b: typecheck + declaration emit into each project dist-types/',
    script: 'typecheck',
  },
  {
    // AFTER typecheck: fallow's graph is syntactic, so a file tsc refuses would be reported
    // as findings rather than as the parse error it is. No baseline (#594): the identity
    // baseline of #163 had held zero findings since #263, and a baseline re-save was the one
    // way to accept new dead code without anyone deciding to.
    name: 'dead-code',
    describe: 'fallow: no dead-code finding',
    script: 'deadcode:check',
  },
  {
    // Beside dead-code: the same tool, syntactic. A per-function ceiling rather than the lint
    // gate's per-file overrides — the pins in `.fallowrc.jsonc` name the FUNCTION, so a pinned
    // file's other functions stay under 20. `test/complexity-ratchet.test.ts` holds each pin
    // equal to its function's score, so a number may go down, never up.
    name: 'complexity',
    describe: 'fallow health: cognitive complexity under 20, or under its function pin',
    script: 'complexity:check',
  },
  {
    // The stricter number for code that is not already over it (#594). In place of `fallow
    // audit`, which was the plan: its verdict also counts every new clone group — the ratchet
    // owns duplication — and styling, and it needs a git base a hook or a shallow CI checkout
    // may not have. An identity baseline needs neither.
    name: 'new-complexity',
    describe: 'fallow health: new or renamed functions under cognitive 15',
    script: 'complexity:new',
  },
  {
    // Beside complexity: the same tool, syntactic, and cheap (well under a second). The threshold
    // is `.fallowrc.jsonc` → `duplicates.threshold`, a ratchet that may only fall; its comment holds
    // the measurement history and what is excluded from the count, and why. Advisory in CI until
    // #593, which promoted it: it had been crossed four times unseen, each time already red.
    name: 'duplication',
    describe: 'fallow dupes: duplicated lines under the ratchet in .fallowrc.jsonc',
    script: 'dupes:check',
  },
  {
    // AFTER typecheck, as dead-code is: react-doctor's pass is syntactic (#342). Promoted from
    // the advisory CI job (`continue-on-error`, once per PR, never local) so the verdict can
    // block, and so the hook, `check:all` and CI inherit one definition. `--blocking error` was
    // the ratchet's starting rung (#342); `--blocking warning` is the next (#747), taken once the
    // surface's 16 warnings were fixed and the ported components left the scan. ⚠ `--scope full`
    // IS NOT THE DEFAULT IT CLAIMS TO BE: on a TTY, with the branch carrying changes, react-doctor
    // asks "Choose what to scan" and waits — a pre-commit hook or `bun check:all` in a terminal
    // hung on it (PR #345, found by the author running the gate). Pinned, so a gate is a gate
    // wherever it runs; a piped run never saw the prompt, which is how it shipped. OFFLINE FLAGS ARE
    // LOAD-BEARING: `--no-score --no-supply-chain` are the score API, share URL, crash trace and
    // Socket.dev lookups — every one a network call a pre-commit hook may not make. The rule
    // set is upstream's and moves between versions: a bump of the `react-doctor` pin is a gate
    // change and is reviewed as one (#208).
    name: 'react-doctor',
    describe: 'react-doctor: no finding, warnings included, on the web surface outside the ported components',
    script: 'doctor:check',
  },
  {
    name: 'test',
    describe: 'bun test',
    script: 'test',
  },
  {
    // AFTER test, which writes coverage/lcov.info (bunfig keeps coverage always on).
    // Enforces the TOTAL floor bun cannot: its own coverageThreshold is per-file
    // (measured 2026-09-04 — see scripts/check-coverage.ts).
    name: 'coverage',
    describe: 'total coverage floor over the full denominator',
    script: 'coverage:check',
  },
  {
    // AFTER typecheck for the same reason dead-code is: TypeDoc reads the compiler's view, so a
    // file tsc refuses would surface here as link noise rather than as the type error it is.
    //
    // ⚠ WARNINGS ARE FATAL (`treatWarningsAsErrors`, #188), and that is the whole point of the
    // step: TypeDoc's warnings ARE the drift. A `{@link}` whose target was renamed, a type
    // referenced by a documented signature but never exported, an entry point that left the
    // program — each is a doc that has stopped matching the code, and none of them is visible
    // to `tsc`. Two were live when the step was added and both are fixed in the same commit.
    //
    // It emits NOTHING (`--emit none`). The step exists to fail on drift, not to produce an
    // artifact: the API pages are markdown the site generates from the same `typedoc.json`
    // (`starlight-typedoc`), so there is no HTML to diff and no build product to keep in step.
    // What is gated is that the surface still DOCUMENTS — the source comments are the artifact,
    // and the fences and the docs gate already hold those to the code.
    //
    // ⚠ THIS IS NOT REDUNDANT WITH THE SITE STEP, AND THAT WAS MEASURED. A `{@link}` pointed at
    // a name that does not exist fails HERE with exit 4 — and the site build renders it, exits
    // 0, and publishes the dead link: `starlight-typedoc` runs TypeDoc through its own logger
    // and `treatWarningsAsErrors` does not reach it. Delete this step and documentation drift
    // ships silently.
    name: 'api-docs',
    describe: 'typedoc: the owned contract surface documents, with warnings fatal',
    script: 'docs:api',
  },
  {
    // ⚠ THE SITE BUILD IS NOT THE CHECK; THE LINK CRAWL IS. `astro build` reported success over
    // 139 dead internal links on the first build — a markdown page's `./routes.md` and
    // `../../packages/…#L47` are both correct on GitHub and both 404 as routes, and nothing in
    // the build has an opinion about that. `docs:site` projects `docs/` into the site, builds,
    // and then crawls every built page: a link that resolves to nothing names itself.
    //
    // Runs LAST because it consumes what the steps above check: the pages `build-docs.ts` writes
    // from the generators and tags the tests hold (#482), and the API surface `api-docs` validates.
    name: 'site',
    describe: 'starlight: the docs site builds from docs/, and every internal link resolves',
    script: 'docs:site',
  },
  {
    // AFTER test, which wrote coverage/lcov.info; LAST because it can only warn (#826).
    name: 'crap',
    describe: 'CRAP warnings: the ten worst functions at CRAP ≥ 30 from measured coverage (never fails)',
    script: 'crap:report',
  },
]

/**
 * A tool that died mid-run and still exited 0 — the one failure a gate cannot see by
 * asking the exit code.
 *
 * Measured 2026-09-10: Biome 2.5.13 — this repo's linter until the oxlint migration — with a
 * GritQL plugin loaded overflowed a worker thread's stack, printed
 * `fatal runtime error: stack overflow, aborting`, and **exited 0**. Whatever that worker
 * held was never checked, and the gate reported green over it. Same silent-pass class this
 * repo keeps finding in its own matchers — a gate that cannot fail still reads as
 * protection — arriving from a dependency instead of from us.
 *
 * Rust panics and segfaults print their own banner and are covered by the same scan. A tool
 * that dies loudly AND exits non-zero was already caught by the status check below.
 */
const WORKER_ABORT = /has overflowed its stack|fatal runtime error|panicked at|Segmentation fault/

/** Whether a tool's stderr says it aborted. Exported for `test/gate-abort.test.ts`. */
export function reportsWorkerAbort(stderr: string): boolean {
  return WORKER_ABORT.test(stderr)
}

/**
 * The overlap kept between stderr chunks so a banner split across a chunk boundary still
 * matches — comfortably longer than the longest phrase in `WORKER_ABORT`.
 */
const ABORT_SCAN_OVERLAP = 64

/**
 * Runs one gate to completion. Both of the tool's streams are piped and written straight
 * through as they arrive — live, verbatim, unbuffered, each to the stream it came from.
 * Only stderr is scanned for a runtime abort, and nothing accumulates, so there is no
 * output size a gate can exceed. Resolves the child's exit code (non-zero = failure); a
 * child killed by a signal, one that failed to spawn, or one that aborted while claiming
 * success, fails.
 *
 * Both streams are piped rather than one, because inheriting stdout while piping stderr
 * races a direct fd against one that round-trips our event loop: a linter writing diagnostics
 * to stdout and its summary to stderr (Biome did) had the two spliced into each other mid-line.
 * Delaying both by the same path keeps the tool's own order.
 */
function runGate(gate: Gate): Promise<number> {
  process.stdout.write(`\n${BOLD}▶ ${gate.name}${RESET} ${DIM}— ${gate.describe}${RESET}\n`)
  return new Promise<number>((resolve) => {
    const child = spawn(PACKAGE_MANAGER, ['run', gate.script], {
      stdio: ['inherit', 'pipe', 'pipe'],
      // Piping costs the tool its TTY, and most tools drop color when they lose it. Ask for
      // it back only when both of ours are terminals — forcing it with either redirected
      // would write escapes into someone's log file.
      env: process.stdout.isTTY && process.stderr.isTTY ? { ...process.env, FORCE_COLOR: '1' } : process.env,
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => process.stdout.write(chunk))

    // Only stderr is scanned: an abort banner is a runtime's dying words, always on stderr,
    // and a tool that quotes source on stdout (a linter printing this repo's own test file, which
    // names the banners) would otherwise take the gate down for reporting correctly.
    let aborted = false
    let carry = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      const window = carry + chunk
      if (reportsWorkerAbort(window)) aborted = true
      carry = window.slice(-ABORT_SCAN_OVERLAP)
    })

    let settled = false
    const settle = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }

    child.on('error', (error: Error) => {
      process.stderr.write(`${RED}gate "${gate.name}" failed to spawn: ${error.message}${RESET}\n`)
      settle(1)
    })

    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      if (aborted) {
        const exited = signal ? `signal ${signal}` : `${status}`
        process.stderr.write(
          `${RED}gate "${gate.name}": the tool ABORTED — whatever it held was not checked, whatever it exited with (${exited}).${RESET}\n`,
        )
        settle(1)
        return
      }
      settle(status ?? 1)
    })
  })
}

/**
 * Run only when EXECUTED, never when imported. `reportsWorkerAbort` is exported so its
 * matcher can be tested, and a test that imported this file would otherwise run every gate
 * — including itself — from inside the test run.
 */
async function main(): Promise<void> {
  process.stdout.write(`${DIM}gate: running via ${PACKAGE_MANAGER}${RESET}\n`)

  let failedGate: string | null = null
  for (const gate of GATES) {
    if ((await runGate(gate)) !== 0) {
      failedGate = gate.name
      break
    }
  }

  if (failedGate) {
    process.stdout.write(`\n${RED}✗ gate "${failedGate}" failed.${RESET}\n`)
    // ⚠ `exitCode`, NEVER `process.exit` (#256). When either stream is a pipe — CI, a file,
    // `$(…)` — a write is queued, not performed, and `process.exit` drops whatever is still
    // queued. A gate that printed megabytes before dying leaves enough backlog that the
    // ABORTED line, written microseconds earlier, never reaches the reader: measured 12 of 12
    // runs of `gate-abort.test.ts`'s 2 MB fixture losing it, and the run reported as a plain
    // failure instead. Setting the code and returning lets the runtime drain first.
    process.exitCode = 1
    return
  }

  process.stdout.write(`\n${GREEN}✓ All gates passed.${RESET}\n`)
}

if (import.meta.main) await main()
