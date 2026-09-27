/**
 * Dev entry point for the enso server.
 *
 * ⚠ `cwd` comes from an argument or this process's own cwd — NEVER from a request. With no
 * sandbox and `bash` unconfined (#9), whatever directory a session runs in is its blast radius,
 * so the launch directory is set by whoever starts the server, and the roots other projects may
 * sit under (#395) by the install's `enso.config.json` — never by whoever opens the page. A config
 * that cannot be read refuses the launch rather than meaning "no roots": it is a policy file.
 *
 * The launcher is where logging is configured (#132): the library under it configures
 * nothing. `ENSO_LOG_LEVEL` picks the file's tier (default `info`; `debug` for every
 * observation; `trace` with payloads; `info,enso.host.events=trace` for one subtree);
 * `ENSO_LOG_CONSOLE` the terminal's (default `info`).
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { parseEnsoConfig } from '@enso/core'
import { startLauncher } from '@enso/core/log-process'
import { ensoAgentDir, ensoConfigPath, ensoProjectsPath, findRepoRoot, harnessPackageDir } from '@enso/core/paths'
import { startEnsoServer } from './index.ts'

const cwdArgument: string | undefined = process.argv[2]
const cwd: string = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument

const repoRoot = findRepoRoot(import.meta.url)
const config = parseEnsoConfig(readFileSync(ensoConfigPath(repoRoot), 'utf8'))
if (config.kind === 'unreadable') throw new Error(`enso-server: ${config.reason}`)
const projectRoots: readonly string[] = config.config.projects?.roots ?? []

// The user's Enso state (#421): migrated, then logging opened there (`startLauncher`).
const { home, logsDir, log } = await startLauncher({
  repoRoot,
  environment: process.env,
  process: 'server',
  logger: ['server', 'dev'],
})
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = ensoAgentDir(home)
mkdirSync(agentDir, { recursive: true })

const { listening } = startEnsoServer({
  cwd,
  projectRoots,
  projectsStatePath: ensoProjectsPath(home),
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
