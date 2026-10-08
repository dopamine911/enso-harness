import { spawn } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep as pathSeparator } from 'node:path'
import { redactJudgeText } from './judge.ts'
import type { EnsoProjectThreadSettings, EnsoTreeSetupOutcome, EnsoTreeSetupStep } from './project-settings.ts'

/**
 * Preparing a new thread's tree (#754): what a `git worktree` does not hold — the checkout's
 * gitignored files (`copy`) and what its install step makes (`setup`) — so a build, a test or the
 * project's pre-commit hook can run in it (#749).
 *
 * ⚠ ACCEPTED RISK until #753: the commands come from config trusted by PATH (the project's own
 * tiers, read only when the project is trusted), not from contents the operator approved. They run
 * as Enso, like its own git calls, not as pi's tool calls: no permission rule sees them.
 */

/**
 * How long one setup command may run: an install on a cold cache takes minutes, a hung one forever.
 * Past it the command's process group is killed, its exit code is `null`, and the rest do not run.
 */
const SETUP_COMMAND_TIME_LIMIT_MS = 10 * 60_000

/** How much of a command's output is kept: its tail, since a failure says why at the end. */
const SETUP_OUTPUT_BYTES = 64 * 1024

/**
 * Copy the project's `copy` paths into `tree`, then run its `setup` commands there, in order,
 * stopping at the first that fails (#754). `undefined` when both lists are empty: nothing done,
 * nothing to record.
 *
 * A path to copy is relative to the project: a file or a directory, copied whole with its symlinks
 * kept as links. ⚠ An absolute path is refused, wherever it points (the page and the docs say paths
 * are relative; one that happens to land inside the project still is not one); so is one that
 * leaves the project — `../x`, or through a symlinked directory. Each is `missing`, as is one the
 * project does not have. A missing path makes the outcome not `ok`, but the commands still run.
 *
 * Each command runs with `sh -c` in the tree, in `environment` — the host's, after the secrets
 * quarantine (#89), the one pi's `bash` gets — its stdout and stderr interleaved, the tail kept
 * (`truncated`), and `secretValues` redacted from it with the judge's redaction (#469).
 *
 * @group Project settings
 */
export async function prepareThreadTree(request: {
  readonly project: string
  readonly tree: string
  readonly threads: EnsoProjectThreadSettings
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly secretValues: readonly string[]
  /** A test's short limit; the default is `SETUP_COMMAND_TIME_LIMIT_MS`. */
  readonly timeLimitMs?: number
}): Promise<EnsoTreeSetupOutcome | undefined> {
  const { setup, copy } = request.threads
  if (setup.value.length === 0 && copy.value.length === 0) return undefined
  const copied: string[] = []
  const missing: string[] = []
  for (const path of copy.value) {
    if (copyIntoTree(request.project, request.tree, path)) copied.push(path)
    else missing.push(path)
  }
  const steps: EnsoTreeSetupStep[] = []
  for (const command of setup.value) {
    const step = await runSetupCommand({
      command,
      cwd: request.tree,
      environment: request.environment,
      secretValues: request.secretValues,
      timeLimitMs: request.timeLimitMs ?? SETUP_COMMAND_TIME_LIMIT_MS,
    })
    steps.push(step)
    if (step.exitCode !== 0) break
  }
  const ok = missing.length === 0 && steps.every((step) => step.exitCode === 0)
  return { ok, copied, missing, steps, tiers: { setup: setup.tier, copy: copy.tier } }
}

/** `true` once `path` is copied; `false` when it is not the project's to copy, or is not there. */
function copyIntoTree(project: string, tree: string, path: string): boolean {
  if (isAbsolute(path)) return false
  const inside = relative(project, resolve(project, path))
  if (inside === '' || leaves(inside)) return false
  try {
    // The directory it is in, symlinks resolved, must still be the project's; the entry itself is
    // copied as it is (a symlink stays a link), so nothing outside is ever read through it.
    const parent = realpathSync(join(project, dirname(inside)))
    if (leaves(relative(realpathSync(project), parent))) return false
    const source = join(parent, basename(inside))
    if (lstatSync(source, { throwIfNoEntry: false }) === undefined) return false
    const target = join(tree, inside)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, verbatimSymlinks: true, force: true })
  } catch {
    return false
  }
  return true
}

/** A relative path that climbs out of where it is relative to (`..`, `../x`), or is absolute (another drive). */
function leaves(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${pathSeparator}`) || isAbsolute(relativePath)
}

/** One command in `sh -c`, bounded in time and output. */
function runSetupCommand(request: {
  readonly command: string
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly secretValues: readonly string[]
  readonly timeLimitMs: number
}): Promise<EnsoTreeSetupStep> {
  const started = performance.now()
  const output = { tail: Buffer.alloc(0), truncated: false }
  const keep = (chunk: Buffer): void => {
    const joined = Buffer.concat([output.tail, chunk])
    if (joined.length <= SETUP_OUTPUT_BYTES) {
      output.tail = joined
      return
    }
    output.tail = joined.subarray(joined.length - SETUP_OUTPUT_BYTES)
    output.truncated = true
  }
  // Its own process group, so a time limit kills what the command started too.
  const child = spawn('sh', ['-c', request.command], {
    cwd: request.cwd,
    env: request.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  const { promise, resolve: done } = Promise.withResolvers<EnsoTreeSetupStep>()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(child.pid)
    // A grandchild that left the group may hold the pipes open: stop waiting on them.
    child.stdout.destroy()
    child.stderr.destroy()
  }, request.timeLimitMs)
  const finish = (exitCode: number | null, note: string): void => {
    clearTimeout(timer)
    done({
      command: request.command,
      exitCode,
      durationMs: Math.round(performance.now() - started),
      output: redactJudgeText(tailText(output) + note, request.secretValues),
      truncated: output.truncated,
    })
  }
  child.once('error', (error) => finish(null, `\n[enso] the command could not start: ${String(error)}\n`))
  child.once('close', (code) => {
    if (timedOut) finish(null, `\n[enso] killed after ${request.timeLimitMs} ms, its time limit\n`)
    else finish(code, '')
  })
  return promise
}

/** The kept output as text: a cut tail starts at its first whole line, so no half secret leads it. */
function tailText(output: { readonly tail: Buffer; readonly truncated: boolean }): string {
  const text = output.tail.toString('utf8')
  if (!output.truncated) return text
  const lineStart = text.indexOf('\n')
  return lineStart === -1 ? '' : text.slice(lineStart + 1)
}

function killGroup(processId: number | undefined): void {
  if (processId === undefined) return
  try {
    process.kill(-processId, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
