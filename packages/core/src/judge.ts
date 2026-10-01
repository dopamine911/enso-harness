import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ENSO_JUDGE_POLICY, type EnsoJudgeState } from './command-judge.ts'
import { ENSO_REDACTED, ENSO_REDACTED_VALUE } from './log.ts'
import { realpathOrSelf, textLooksLikeSecretPath } from './paths.ts'
import { isSecretShapedName } from './secrets.ts'
import type { EnsoJudgeContext } from './session-risk.ts'

/**
 * The command judge's node half (#469): what a command runs, read from disk, and every string the
 * judge is sent, redacted. `@enso/core/judge`, never the barrel — it reads files and secrets.
 *
 * - **Script resolution.** Without the contents of what a command runs, "write it to a file, then
 *   run it" stays open: the judge sees `bash cleanup.sh` and nothing else. So a script handed to a
 *   shell or an interpreter, an executable named by path, a `package.json` script and a Makefile are
 *   read and sent with it, each capped. ⚠ Stated limit: what those scripts import, and dependency
 *   install scripts, are not followed — that is confinement's (#397).
 * - **Never a secret's contents.** A path that looks like credential material — by its text, or by
 *   the realpath a symlink leads to — is not opened, and the judge reads that it was withheld.
 *
 * @group Command judge
 */

/** The most a file contributes, and the most files one command sends. */
const MAX_FILE_BYTES = 16_384
const MAX_FILES = 4

/** What the judge reads in place of a file it may not, or need not, see. */
const WITHHELD_SECRET = '[withheld: the path looks like credential material]'
const WITHHELD_BINARY = '[withheld: a binary file]'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.'])
const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'lua',
  'tsx',
  'ts-node',
])
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
/** A package manager's own commands, which run no `package.json` script. */
const PACKAGE_BUILTINS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'update',
  'upgrade',
  'ci',
  'init',
  'create',
  'x',
  'exec',
  'dlx',
  'link',
  'publish',
  'pack',
  'outdated',
  'audit',
  'why',
  'info',
  'view',
  'login',
  'logout',
  'config',
  'cache',
])

/** The words at command position, one list per segment of a command line. */
function segmentsOf(command: string): string[][] {
  return command
    .split(/\n|;|&&|\|\||\||&/)
    .map((segment) => (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^["']|["']$/g, '')))
    .map((words) => words.slice(words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))))
    .filter((words) => words.length > 0)
}

/** What one segment runs from disk: a path (relative to `cwd`), or a package script, or the Makefile. */
type Runs =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package-script'; readonly name: string }
  | { readonly kind: 'makefile' }

/** Bun's own commands, which run no `package.json` script — `bun test` is Bun's test runner. */
const BUN_BUILTINS = new Set(['test', 'build', 'pm', 'repl', 'upgrade', 'run'])

function runsOf(words: readonly string[]): Runs | undefined {
  const [program = '', first] = words
  if (program.startsWith('./') || program.startsWith('../') || program.startsWith('/')) {
    return { kind: 'file', path: program }
  }
  if (PACKAGE_RUNNERS.has(program) && (program !== 'bun' || isBunScriptCall(first))) return runsOfPackage(words)
  if ((SHELLS.has(program) || INTERPRETERS.has(program)) && first !== undefined && !first.startsWith('-')) {
    // Bun's command names are Bun's alone: `bash build` runs a file called build (PR #533 review).
    return program === 'bun' && BUN_BUILTINS.has(first) ? undefined : { kind: 'file', path: first }
  }
  if (program === 'make' || program === 'gmake') return { kind: 'makefile' }
  return undefined
}

/** `bun run x` and `bun x` (no extension, no path, not a Bun command) run a package script. */
function isBunScriptCall(first: string | undefined): boolean {
  if (first === undefined || first.startsWith('-')) return false
  if (first === 'run') return true
  return !BUN_BUILTINS.has(first) && !PACKAGE_BUILTINS.has(first) && !first.includes('.') && !first.includes('/')
}

function runsOfPackage(words: readonly string[]): Runs | undefined {
  const [, first, second] = words
  if (first === undefined || first.startsWith('-')) return undefined
  if (first === 'run' || first === 'run-script') {
    return second === undefined ? undefined : { kind: 'package-script', name: second }
  }
  if (PACKAGE_BUILTINS.has(first)) return undefined
  return { kind: 'package-script', name: first }
}

/** A file's text for the judge, or why it is withheld; undefined when there is no such file. */
function readForJudge(absolutePath: string, fragments: readonly string[]): string | undefined {
  if (
    textLooksLikeSecretPath(absolutePath, fragments) ||
    textLooksLikeSecretPath(realpathOrSelf(absolutePath), fragments)
  ) {
    return existsSync(absolutePath) ? WITHHELD_SECRET : undefined
  }
  try {
    if (!statSync(absolutePath).isFile()) return undefined
    const bytes = readFileSync(absolutePath)
    if (bytes.subarray(0, 8000).includes(0)) return WITHHELD_BINARY
    const text = bytes.subarray(0, MAX_FILE_BYTES).toString('utf8')
    return bytes.length > MAX_FILE_BYTES ? `${text}\n[… ${bytes.length - MAX_FILE_BYTES} more bytes not read]` : text
  } catch {
    return undefined
  }
}

/** A `package.json` script's command line, as the judge's file entry. */
function packageScriptOf(cwd: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const script = manifest.scripts?.[name]
    return typeof script === 'string' ? script : undefined
  } catch {
    return undefined
  }
}

/**
 * The contents of what `command` runs, by the name the judge reads them under: a file by its path
 * as the command spells it (relative to `cwd` when inside it), a package script as
 * `package.json#scripts.<name>`, the Makefile as `Makefile`. Empty when it runs nothing from disk.
 *
 * @group Command judge
 */
export function judgeFilesOf(command: string, cwd: string, fragments: readonly string[]): Record<string, string> {
  const files: Record<string, string> = {}
  for (const runs of segmentsOf(command).map(runsOf)) {
    if (Object.keys(files).length >= MAX_FILES) break
    const entry = runs === undefined ? undefined : fileEntryOf(runs, cwd, fragments)
    if (entry !== undefined) files[entry[0]] = entry[1]
  }
  return files
}

/** What one segment runs, as the judge's `[name, contents]`, or undefined when nothing is there. */
function fileEntryOf(runs: Runs, cwd: string, fragments: readonly string[]): [name: string, text: string] | undefined {
  if (runs.kind === 'package-script') {
    const script = packageScriptOf(cwd, runs.name)
    return script === undefined ? undefined : [`package.json#scripts.${runs.name}`, script]
  }
  const absolutePath = runs.kind === 'makefile' ? join(cwd, 'Makefile') : resolve(cwd, runs.path)
  const text = readForJudge(absolutePath, fragments)
  if (text === undefined) return undefined
  return [runs.kind === 'makefile' ? 'Makefile' : nameUnder(cwd, absolutePath), text]
}

/** A path as the judge reads it: relative to `cwd` when inside it, absolute otherwise. */
function nameUnder(cwd: string, absolutePath: string): string {
  const inside = relative(cwd, absolutePath)
  return inside.startsWith('..') || isAbsolute(inside) ? absolutePath : inside
}

/**
 * A secret-shaped name assigned a value (`FOO_TOKEN=…`, `export API_KEY="…"`), a secret-shaped
 * flag given one (`--token …`, `--password=…`), an `Authorization` header or a bearer value, and the
 * token shapes vendors print: OpenAI/Anthropic `sk-`, GitHub, Slack, AWS access keys, private keys.
 */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g
const SECRET_FLAG = /(--?(?:api[-_]?key|token|secret|password|passwd|auth)(?:[=\s]+))("[^"]*"|'[^']*'|[^\s;&|]+)/gi
const AUTHORIZATION = /(authorization:\s*)[^\n'"]+/gi
const BEARER = /(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi
const TOKEN_SHAPES =
  /\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/** Every known value, longest first — a shorter one listed first would leave a longer one's tail. */
function knownValuePattern(secretValues: readonly string[]): RegExp | undefined {
  const scannable = secretValues
    .filter((secret) => secret.length > 0)
    .toSorted((left, right) => right.length - left.length)
  if (scannable.length === 0) return undefined
  return new RegExp(scannable.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
}

/**
 * One string as the judge may see it: known secret values first, then the shapes. Markers, not
 * deletions, so the judge still reads that something was there.
 *
 * @group Command judge
 */
export function redactJudgeText(text: string, secretValues: readonly string[]): string {
  const known = knownValuePattern(secretValues)
  const scrubbed = known === undefined ? text : text.replace(known, ENSO_REDACTED_VALUE)
  return scrubbed
    .replace(ASSIGNMENT, (whole: string, name: string) =>
      isSecretShapedName(name) ? `${name}=${ENSO_REDACTED}` : whole,
    )
    .replace(SECRET_FLAG, (_whole: string, flag: string) => `${flag}${ENSO_REDACTED}`)
    .replace(AUTHORIZATION, (_whole: string, header: string) => `${header}${ENSO_REDACTED}`)
    .replace(BEARER, (_whole: string, scheme: string) => `${scheme}${ENSO_REDACTED}`)
    .replace(TOKEN_SHAPES, ENSO_REDACTED_VALUE)
}

/**
 * The state with every string redacted — the command, the files, the calls before it and the
 * refusal. ⚠ Only this crosses to a backend.
 *
 * @group Command judge
 */
export function redactJudgeState(state: EnsoJudgeState, secretValues: readonly string[]): EnsoJudgeState {
  const redact = (text: string): string => redactJudgeText(text, secretValues)
  return {
    cwd: state.cwd,
    policy: state.policy,
    command: redact(state.command),
    ...(state.files === undefined
      ? {}
      : { files: Object.fromEntries(Object.entries(state.files).map(([name, contents]) => [name, redact(contents)])) }),
    ...(state.recentCalls === undefined
      ? {}
      : {
          recentCalls: state.recentCalls.map((recent) => ({
            ...recent,
            ...(recent.command === undefined ? {} : { command: redact(recent.command) }),
          })),
        }),
    ...(state.denied === undefined
      ? {}
      : { denied: { command: redact(state.denied.command), reason: redact(state.denied.reason) } }),
  }
}

/**
 * Where a judge state is built from, beside the call's context: the directory it runs in (its
 * scripts are read from there), the guard's secret-path fragments (a script under one is never
 * read) and every known secret value (scrubbed before the state leaves).
 *
 * @group Command judge
 */
export interface JudgeStateInputs {
  readonly cwd: string
  readonly secretPathFragments: readonly string[]
  readonly secretValues: readonly string[]
}

/**
 * What the judge is asked about a call in its scope (#469): the command, where it runs, the
 * policy, the scripts it runs, the calls before it and the refusal it follows — redacted. ⚠ The
 * only way to build a state, so the live guard and the replay send the same thing, and nothing
 * holds an unredacted one.
 *
 * @group Command judge
 */
export function judgeStateOf(context: EnsoJudgeContext, inputs: JudgeStateInputs): EnsoJudgeState {
  const files = judgeFilesOf(context.command, inputs.cwd, inputs.secretPathFragments)
  return redactJudgeState(
    {
      cwd: inputs.cwd,
      policy: ENSO_JUDGE_POLICY,
      command: context.command,
      ...(Object.keys(files).length === 0 ? {} : { files }),
      recentCalls: context.recentCalls.map((recent) => ({ ...recent })),
      ...(context.denied === undefined ? {} : { denied: { ...context.denied } }),
    },
    inputs.secretValues,
  )
}
