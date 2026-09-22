/**
 * Dev entry point for the enso server.
 *
 * ⚠ `cwd` comes from an argument or this process's own cwd — NEVER from a request. With no
 * sandbox and `bash` unconfined (#9), whatever this value is becomes the blast radius, so
 * it is set by whoever starts the server rather than by whoever opens the page.
 *
 * The launcher is where logging is configured (#132): the library under it configures
 * nothing. `ENSO_LOG_LEVEL` picks the file's tier (default `info`; `debug` for every
 * observation; `trace` with payloads; `info,enso.host.events=trace` for one subtree);
 * `ENSO_LOG_CONSOLE` the terminal's (default `info`).
 */

import { mkdirSync } from 'node:fs'
import { ensoLogger } from '@enso/core'
import {
  configureProcessLogging,
  installLoggingShutdown,
  logsDirFrom,
  parseEnsoLogLevels,
} from '@enso/core/log-process'
import { ensoAgentDir, findRepoRoot, harnessPackageDir } from '@enso/core/paths'
import { knownSecretValuesTracking } from '@enso/core/secrets'
import { startEnsoServer } from './index.ts'

const cwdArgument: string | undefined = process.argv[2]
const cwd: string = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument

const repoRoot = findRepoRoot(import.meta.url)
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = ensoAgentDir(repoRoot)
mkdirSync(agentDir, { recursive: true })

const logsDir = logsDirFrom(process.env, repoRoot)
const disposeLogging: () => Promise<void> = await configureProcessLogging({
  logsDir,
  process: 'server',
  levels: parseEnsoLogLevels(process.env, { console: 'info' }),
  // The value pass (#139): what a token quoted in a message or a trace payload is scrubbed
  // against — asked per record, so a key rotated while the server runs is redacted too (#207).
  secretValues: knownSecretValuesTracking(repoRoot),
})
const log = ensoLogger('server', 'dev')

installLoggingShutdown(disposeLogging)

const { listening } = startEnsoServer({
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
