/**
 * Dev entry point for the zen server.
 *
 * ⚠ `cwd` comes from an argument or this process's own cwd — NEVER from a request. With no
 * sandbox and `bash` unconfined (#9), whatever this value is becomes the blast radius, so
 * it is set by whoever starts the server rather than by whoever opens the page.
 *
 * The launcher is where logging is configured (#132): the library under it configures
 * nothing. `ZEN_LOG_LEVEL` picks the file's tier (default `info`; `debug` for every
 * observation; `trace` with payloads; `info,zen.host.events=trace` for one subtree);
 * `ZEN_LOG_CONSOLE` the terminal's (default `info`).
 */

import { mkdirSync } from 'node:fs'
import { findRepoRoot, harnessPackageDir, knownSecretValues, zenAgentDir, zenLogger } from '@zen/core'
import { configureProcessLogging, logsDirFrom, parseZenLogLevels } from '@zen/core/log-process'
import { startZenServer } from './index.ts'

const cwdArgument = process.argv[2]
const cwd = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument

const repoRoot = findRepoRoot(import.meta.url)
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = zenAgentDir(repoRoot)
mkdirSync(agentDir, { recursive: true })

const logsDir = logsDirFrom(process.env, repoRoot)
const disposeLogging = await configureProcessLogging({
  logsDir,
  process: 'server',
  levels: parseZenLogLevels(process.env, { console: 'info' }),
  // The value pass (#139): what a token quoted in a message or a trace payload is scrubbed against.
  secretValues: knownSecretValues(repoRoot),
})
const log = zenLogger('server', 'dev')

// A stop from the hub or a terminal: flush the file, then exit the way the signal would
// have (128 + its number: 130 for SIGINT, 143 for SIGTERM), so a supervisor reads it right.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.once(signal, () => {
    void disposeLogging().finally(() => process.exit(code))
  })
}

const { listening } = startZenServer({
  cwd,
  harnessPackageDir: harnessPackageDir(repoRoot),
  agentDir,
  logsDir,
})

try {
  log.info('listening on {url} · pi cwd {cwd} · package {harnessPackageDir} · agentDir {agentDir} · logs {logsDir}', {
    url: await listening,
    cwd,
    harnessPackageDir: harnessPackageDir(repoRoot),
    agentDir,
    logsDir,
  })
} catch {
  // The bind failed; the server already logged why. Exit non-zero instead of dangling.
  process.exitCode = 1
}
