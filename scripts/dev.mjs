#!/usr/bin/env bun
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
 * Usage:  bun run dev                 # pi runs in the repo root
 *         bun run dev /some/path      # pi runs there instead
 */
import { findRepoRoot, webPackageDir } from '../packages/core/src/index.ts'

const SERVER_HEAD_START_MS = 1200

const repoRoot = findRepoRoot(import.meta.url)
const webPackageRunDir = webPackageDir(repoRoot)
const piCwd = process.argv[2] ?? repoRoot

/** @type {import("bun").Subprocess[]} */
const children = []
let shuttingDown = false

/**
 * Prefix every line a stdio stream produces; resolves when the stream ends.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {string} label
 * @param {(lines: string) => void} emit
 */
async function prefixStream(stream, label, emit) {
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

/**
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 */
function run(label, command, args) {
  const child = Bun.spawn([command, ...args], {
    cwd: webPackageRunDir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // ⚠ If either surface dies, take the other down. A half-running dev environment is
    // worse than none: the web surface serving a page whose API is gone looks like an app bug.
    onExit(_child, code, signalCode) {
      if (shuttingDown) return
      console.error(`[dev] ${label} exited (${code ?? signalCode ?? 'signal'}) — stopping the other surface`)
      shutdown()
    },
  })
  void prefixStream(child.stdout, label, (lines) => console.log(lines))
  void prefixStream(child.stderr, label, (lines) => console.error(lines))
  children.push(child)
  return child
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill('SIGTERM')
  // Do not wait forever on a child that ignores SIGTERM.
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.error(`[dev] pi will run in ${piCwd}`)
// ⚠ bun runs the server (#30): the runtime the tests exercise (`bun test`) is now the
// runtime that ships. Node's strip-types flag — and its strip-ONLY constraint — is gone.
run('server', 'bun', ['src/server/dev.ts', piCwd])

setTimeout(() => {
  // Bun's fullstack dev server (#36) — vite is gone, and with it the one dev-path tool
  // that still executed under node (bunx honored vite's node shebang).
  if (!shuttingDown) run('web', 'bun', ['src/server/dev-web.ts'])
}, SERVER_HEAD_START_MS).unref()
