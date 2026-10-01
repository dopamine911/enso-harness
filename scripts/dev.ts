#!/usr/bin/env bun
import type { Subprocess } from 'bun'

/** What `run` spawns: stdin ignored, both output streams piped so they can be prefixed. */
type PrefixedChild = Subprocess<'ignore', 'pipe', 'pipe'>

/** Bun's own exit callback for the options below — the source of the two types under it. */
type ExitCallback = NonNullable<Bun.Spawn.OptionsObject<'ignore', 'pipe', 'pipe'>['onExit']>
/** The exit code and signal as BUN declares them — widen there, and every narrow use here goes red. */
type ExitCode = Parameters<ExitCallback>[1]
type ExitSignal = Parameters<ExitCallback>[2]

/**
 * Run both dev surfaces with one command.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN A `concurrently` DEPENDENCY
 * Two child processes and a shared teardown is about forty lines. A dependency for it
 * would be a third-party package in the critical path of every dev session, and this repo
 * has spent the day cataloguing what unpinned third-party packages cost.
 *
 * ⚠ The server MUST come up before the web surface proxies to it — the `/api` proxy does
 * not retry a refused connection, it surfaces an error to the browser, and that reads as
 * "the app is broken" rather than "the API is not up yet". So the server is started first
 * and given a moment.
 *
 * The launcher writes to the day file as its own process, `dev` (#385): a child's exit code or
 * signal is something only the launcher can see — a child that was SIGKILLed or OOM-killed said
 * nothing — so `{label} exited ({exit})` goes to the file and not only to this terminal, and the
 * launcher's own stop and crash are recorded like every launcher's (`installLoggingShutdown`).
 *
 * Usage:  bun run dev                 # pi runs in the repo root
 *         bun run dev /some/path      # pi runs there instead
 */
import { startLauncher } from '../packages/core/src/log-process.ts'
import { ENSO_LOG_EVENTS } from '../packages/core/src/log-stats.ts'
import { findRepoRoot, webPackageDir } from '../packages/core/src/paths.ts'

const SERVER_HEAD_START_MS = 1200

const repoRoot = findRepoRoot(import.meta.url)
const webPackageRunDir = webPackageDir(repoRoot)
const piCwd: string = process.argv[2] ?? repoRoot

const children: PrefixedChild[] = []
let shuttingDown = false

/**
 * Stop both children, waiting for them a bounded time — a child that ignores SIGTERM must not
 * hold the launcher. Runs inside the logging contract (`installLoggingShutdown`): a signal or a
 * crash records itself, ends the children here, flushes, and exits 130/143/1 (#267, #385).
 */
async function stopChildren(): Promise<void> {
  shuttingDown = true
  for (const child of children) child.kill('SIGTERM')
  await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(500)])
}

const { log, dispose } = await startLauncher({
  repoRoot,
  environment: process.env,
  process: 'dev',
  logger: ['server', 'dev-launcher'],
  beforeStop: stopChildren,
})

/** Prefix every line a stdio stream produces; resolves when the stream ends. */
async function prefixStream(
  stream: ReadableStream<Uint8Array>,
  label: string,
  emit: (lines: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const lines = decoder
      .decode(chunk, { stream: true })
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `[${label}] ${line}`)
      .join('\n')
    if (lines.length > 0) emit(lines)
  }
}

function run(label: string, command: string, args: string[]): PrefixedChild {
  const child = Bun.spawn([command, ...args], {
    cwd: webPackageRunDir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // ⚠ If either surface dies, take the other down. A half-running dev environment is
    // worse than none: the web surface serving a page whose API is gone looks like an app bug.
    //
    // ⚠ The parameter types are DERIVED from Bun's own callback, never restated (PR #325
    // review). A method parameter is bivariant, so spelling `signalCode: number | null` by
    // hand keeps compiling after a bun-types bump that widened it — and every use of the
    // value then reads a string as a number, with nothing red anywhere. Measured: widening
    // the installed declaration to `NodeJS.Signals | number | null` and assigning the
    // parameter to a `number | null` is TS2322 with the types below and SILENT with the
    // hand-written ones. Deriving does not make the bump itself an error — it makes it an
    // error wherever the value is used as the narrower thing, which is the honest place for
    // it. The lint wants every parameter typed; this types them without copying a vendor
    // signature into our file.
    onExit: (_child: PrefixedChild, code: ExitCode, signalCode: ExitSignal): void => {
      if (shuttingDown) return
      // ⚠ To the FILE, not only this terminal (#385): the exit code or signal is the one fact about
      // a child's end that the child itself could not record. A surface dying on its own is not a
      // clean stop of the dev environment, so the launcher exits 1 after taking the other down.
      log.warn(ENSO_LOG_EVENTS.devChildExited, { label, exit: String(code ?? signalCode ?? 'signal') })
      void stopChildren()
        .then(dispose)
        .finally(() => process.exit(1))
    },
  })
  void prefixStream(child.stdout, label, (lines) => process.stdout.write(`${lines}\n`))
  void prefixStream(child.stderr, label, (lines) => process.stderr.write(`${lines}\n`))
  children.push(child)
  return child
}

log.info('pi will run in {piCwd}', { piCwd })
// ⚠ bun runs the server (#30): the runtime the tests exercise (`bun test`) is now the
// runtime that ships. Node's strip-types flag — and its strip-ONLY constraint — is gone.
run('server', 'bun', ['src/server/dev.ts', piCwd])

setTimeout(() => {
  // Bun's fullstack dev server (#36) — vite is gone, and with it the one dev-path tool
  // that still executed under node (bunx honored vite's node shebang).
  if (!shuttingDown) run('web', 'bun', ['src/server/dev-web.ts'])
}, SERVER_HEAD_START_MS).unref()
