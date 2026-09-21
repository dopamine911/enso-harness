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
import { zenLogger } from '@zen/core'
import { configureProcessLogging, installLoggingShutdown, logsDirFrom, parseZenLogLevels } from '@zen/core/log-process'
import { findRepoRoot, harnessPackageDir, zenAgentDir } from '@zen/core/paths'
import { knownSecretValuesTracking } from '@zen/core/secrets'
import { startZenServer } from './index.ts'

const cwdArgument: string | undefined = process.argv[2]
const cwd: string = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument

const repoRoot = findRepoRoot(import.meta.url)
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = zenAgentDir(repoRoot)
mkdirSync(agentDir, { recursive: true })

const logsDir = logsDirFrom(process.env, repoRoot)
const disposeLogging: () => Promise<void> = await configureProcessLogging({
  logsDir,
  process: 'server',
  levels: parseZenLogLevels(process.env, { console: 'info' }),
  // The value pass (#139): what a token quoted in a message or a trace payload is scrubbed
  // against — asked per record, so a key rotated while the server runs is redacted too (#207).
  secretValues: knownSecretValuesTracking(repoRoot),
})
const log = zenLogger('server', 'dev')

installLoggingShutdown(disposeLogging)

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
