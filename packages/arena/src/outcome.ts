import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { gitChildEnvironment } from '@enso/core/git'

/**
 * What the run built, measured apart from anything about Enso (#556 "report app completion separately",
 * #584 B5, #624): for each place the work can be — the project and each thread's tree — its files,
 * its git history and the tests the agent wrote. Whether the game is good, or which features count,
 * stays the reviewer's call; this is what is there.
 *
 * ⚠ RUNNING THE TESTS IS OPT-IN (`runTests`). They are code Enso's agent wrote, run on this machine
 * after the run with no approval in between, so they get only `PATH`, a throwaway `HOME`, and a
 * time limit — never the operator's environment, where a provider key could be.
 */

/** One place's work. */
export interface ArenaWorkOutcome {
  /** Relative to the run directory, or absolute for a workspace outside it. */
  readonly path: string
  readonly fileCount: number
  readonly bytes: number
  /** The largest files first, up to `LISTED_FILES`: enough to see what was built. */
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  readonly git: ArenaWorkGit
  readonly tests: readonly ArenaTestFile[]
  /** The workspace's own test script run once (`package.json` `scripts.test`), when it has one and tests were run. */
  readonly testScript?: ArenaTestRun
}

/**
 * The workspace's git: `none` when it is no repository of its own (a thread tree is a plain
 * directory; a parent repository's history is not this work's), else its commits, newest first.
 */
export type ArenaWorkGit =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'repository'
      readonly commits: readonly { readonly hash: string; readonly subject: string }[]
      readonly uncommitted: number
    }

export interface ArenaTestFile {
  readonly path: string
  /** Present when the tests were run: the command and how it ended. */
  readonly run?: ArenaTestRun
  /** Why the file was not run, when tests were run and this one had no runner. */
  readonly notRun?: string
}

export interface ArenaTestRun {
  readonly command: string
  /** The exit code, or `timeout` when it ran past `TEST_TIME_LIMIT_MS`. */
  readonly exit: number | 'timeout'
  /** The output's last lines, redacted. */
  readonly tail: string
}

export interface ArenaOutcomeOptions {
  readonly runTests: boolean
  /** The `PATH` a test runs with: the one thing it is given from the operator's environment. */
  readonly path: string
  readonly redact: (text: string) => string
  /**
   * The bun the tests run under: the arena's own (`process.execPath`), never looked up by name. Under
   * `bun run` that is the npm package's `bun.exe`, whose directory holds no `bun` (measured: a test
   * that put `dirname(execPath)` on `PATH` found nothing to run inside the gate).
   */
  readonly bun: string
}

/** Directories never walked: a repository's own, and installed dependencies. */
const SKIPPED = new Set(['.git', 'node_modules'])
const LISTED_FILES = 20
const WALK_LIMIT = 5000
const TEST_TIME_LIMIT_MS = 60_000
const TAIL_LINES = 12
/** A test file by its name (`test_logic.js`, `snake.test.ts`, `game-spec.mjs`) or its directory (`tests/`, `__tests__/`). */
const TEST_NAME = /(^|[._-])(test|spec)s?([._-]|$)/i
const TEST_DIRECTORY = /(^|\/)(__tests__|tests?)\//
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.py', '.sh'])
/** What bun runs: a `*.test.*`/`*.spec.*` file under its test runner, anything else as a script. */
const BUN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'])

export function workOutcomes(
  runDirectory: string,
  workspaces: readonly string[],
  options: ArenaOutcomeOptions,
): ArenaWorkOutcome[] {
  return workspaces
    .filter((workspace) => existsSync(workspace))
    .map((workspace) => workOutcome(runDirectory, workspace, options))
}

function workOutcome(runDirectory: string, workspace: string, options: ArenaOutcomeOptions): ArenaWorkOutcome {
  const files = filesUnder(workspace)
  const tests = files.filter((file) => isTestFile(file.path))
  const script = options.runTests ? testScriptOf(workspace) : undefined
  const shown = relative(runDirectory, workspace)
  return {
    path: shown.startsWith('..') ? workspace : shown,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    files: files.toSorted((left, right) => right.bytes - left.bytes).slice(0, LISTED_FILES),
    git: gitOf(workspace),
    tests: tests.map((file) =>
      options.runTests && script === undefined ? runTestFile(workspace, file.path, options) : { path: file.path },
    ),
    ...(script === undefined ? {} : { testScript: runCommand(workspace, ['bun', 'run', 'test'], options) }),
  }
}

function filesUnder(workspace: string): { path: string; bytes: number }[] {
  const found: { path: string; bytes: number }[] = []
  const walk = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const directoryEntry of entries) {
      if (found.length >= WALK_LIMIT) return
      const path = join(directory, directoryEntry.name)
      if (directoryEntry.isDirectory()) {
        if (!SKIPPED.has(directoryEntry.name)) walk(path)
      } else if (directoryEntry.isFile()) {
        found.push({ path: relative(workspace, path), bytes: statSync(path, { throwIfNoEntry: false })?.size ?? 0 })
      }
    }
  }
  walk(workspace)
  return found.toSorted((left, right) => (left.path < right.path ? -1 : 1))
}

function isTestFile(path: string): boolean {
  if (!SOURCE_EXTENSIONS.has(extname(path))) return false
  const name = path.split('/').at(-1) ?? path
  return TEST_NAME.test(name.slice(0, name.length - extname(name).length)) || TEST_DIRECTORY.test(path)
}

/** git in the workspace — without the inherited repository variables, which under a hook name the hook's. */
function git(workspace: string, args: readonly string[]): string | undefined {
  const result = spawnSync('git', args, {
    cwd: workspace,
    env: gitChildEnvironment(),
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout : undefined
}

function gitOf(workspace: string): ArenaWorkGit {
  // A directory inside someone else's repository is not a repository of its own.
  const top = git(workspace, ['rev-parse', '--show-toplevel'])?.trim()
  if (top === undefined || realpathSync(top) !== realpathSync(workspace)) return { kind: 'none' }
  const log = git(workspace, ['log', '--format=%h%x09%s', '-n', '50']) ?? ''
  const commits = log
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash = '', ...subject] = line.split('\t')
      return { hash, subject: subject.join('\t') }
    })
  const status = git(workspace, ['status', '--porcelain', '--untracked-files=all']) ?? ''
  return {
    kind: 'repository',
    commits,
    uncommitted: status.split('\n').filter((line) => line.trim().length > 0).length,
  }
}

/** The workspace's `scripts.test`, when its `package.json` has one. */
function testScriptOf(workspace: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('scripts' in manifest)) return undefined
    const scripts = manifest.scripts
    if (typeof scripts !== 'object' || scripts === null || !('test' in scripts)) return undefined
    return typeof scripts.test === 'string' ? scripts.test : undefined
  } catch {
    return undefined
  }
}

function runTestFile(workspace: string, path: string, options: ArenaOutcomeOptions): ArenaTestFile {
  const extension = extname(path)
  if (!BUN_EXTENSIONS.has(extension)) return { path, notRun: `no runner for ${extension} files` }
  const underTestRunner = /\.(test|spec)\.[^.]+$/.test(path)
  const command = underTestRunner ? ['bun', 'test', `./${path}`] : ['bun', `./${path}`]
  return { path, run: runCommand(workspace, command, options) }
}

function runCommand(workspace: string, command: readonly string[], options: ArenaOutcomeOptions): ArenaTestRun {
  const [, ...args] = command
  // A HOME of its own per run, removed when the run ends (PR #626 review): nothing the agent's tests
  // leave in it outlives them, and repeated reports leave no directories behind.
  const home = mkdtempSync(join(tmpdir(), 'arena-test-home-'))
  const result = spawnSync(options.bun, args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: TEST_TIME_LIMIT_MS,
    env: { PATH: options.path, HOME: home, CI: '1' },
  })
  rmSync(home, { recursive: true, force: true })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
  const timedOut = result.error !== undefined && 'code' in result.error && result.error.code === 'ETIMEDOUT'
  return {
    command: command.join(' '),
    exit: timedOut ? 'timeout' : (result.status ?? 1),
    tail: options.redact(output.split('\n').slice(-TAIL_LINES).join('\n')),
  }
}
