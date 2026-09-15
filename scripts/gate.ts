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
 * Ordering is cheap-first: a fast Biome failure surfaces before the slower
 * typecheck and test gates run.
 *
 * The checks:
 *   1. biome     — lint + format + import-organize (check-only, no writes). This
 *                  also enforces the discipline rules Biome can express, e.g.
 *                  `noTsIgnore` is set to error in biome.jsonc, so a banned
 *                  suppression directive fails the gate rather than merely warning.
 *   2. typecheck — `tsc --noEmit` over the package.
 *   3. test      — `vitest run`.
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

const GATES: readonly Gate[] = [
  {
    name: 'biome',
    describe: 'lint + format + import-organize (check-only)',
    script: 'lint',
  },
  {
    name: 'typecheck',
    describe: 'tsc --noEmit',
    script: 'typecheck',
  },
  {
    // AFTER typecheck: fallow's graph is syntactic, so a file tsc refuses would be reported
    // as findings rather than as the parse error it is. Identity baseline (#163): fails only
    // on a finding that is NOT in `fallow-baseline.json` — the backlog is inventory, growth
    // is the regression. Re-save the baseline only when a finding is deliberately accepted.
    name: 'dead-code',
    describe: 'fallow: no dead-code finding beyond the committed baseline',
    script: 'deadcode:check',
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
]

/**
 * A tool that died mid-run and still exited 0 — the one failure a gate cannot see by
 * asking the exit code.
 *
 * Measured 2026-09-10: Biome 2.5.13 with any GritQL plugin loaded (ours is
 * `.biome/naming.grit`) overflows a worker thread's stack, prints
 * `fatal runtime error: stack overflow, aborting`, and **exits 0**. Whatever that worker
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
 * races a direct fd against one that round-trips our event loop: Biome writes diagnostics
 * to stdout and its summary to stderr, and the two spliced into each other mid-line.
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
    // and a tool that quotes source on stdout (Biome prints this repo's own test file, which
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
    process.exit(1)
  }

  process.stdout.write(`\n${GREEN}✓ All gates passed.${RESET}\n`)
}

if (import.meta.main) await main()
