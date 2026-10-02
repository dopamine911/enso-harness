/**
 * Dev entry point for the enso server.
 *
 * ⚠ `cwd` comes from an argument or this process's own cwd — NEVER from a request. With no
 * sandbox and `bash` unconfined (#9), whatever directory a session runs in is its blast radius,
 * so the launch directory is set by whoever starts the server, and the roots other projects may
 * sit under (#395) by the user's config (`ENSO_HOME/config.json`, #421) — never by whoever opens
 * the page. A config that is there and cannot be read refuses the launch rather than meaning "no
 * roots": it is a policy file. No file at all is the defaults — no roots — and is said.
 *
 * The launcher is where logging is configured (#132): the library under it configures
 * nothing. `ENSO_LOG_LEVEL` picks the file's tier (default `info`; `debug` for every
 * observation; `trace` with payloads; `info,enso.host.events=trace` for one subtree);
 * `ENSO_LOG_CONSOLE` the terminal's (default `info`).
 */

import { mkdirSync } from 'node:fs'
import { incidentPolicyOf, parseEnsoConfig, threadTreeFor } from '@enso/core'
import { startLauncher } from '@enso/core/log-process'
import {
  ensoAgentDir,
  ensoConfigPath,
  ensoPermissionRulesPath,
  ensoProjectsDir,
  ensoProjectsPath,
  ensoPromptsDir,
  findRepoRoot,
  harnessPackageDir,
  readTextIfPresent,
} from '@enso/core/paths'
import { startEnsoServer } from './index.ts'
import { canonicalConfigPath } from './projects.ts'

const cwdArgument: string | undefined = process.argv[2]
const cwd: string = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument

const repoRoot = findRepoRoot(import.meta.url)

// The user's Enso state (#421): migrated, then logging opened there (`startLauncher`).
const { home, logsDir, log } = await startLauncher({
  repoRoot,
  environment: process.env,
  process: 'server',
  logger: ['server', 'dev'],
})

// The user's config (#421): absent is the defaults — said, since "no project roots" hides every
// registered project outside the launch directory. A file that is there and unreadable refuses the
// launch: it is a policy file.
const configPath = ensoConfigPath(home)
const configText = readTextIfPresent(configPath)
const config = parseEnsoConfig(configText)
if (config.kind === 'unreadable') {
  log.error('{configPath} is unreadable: {reason}', { configPath, reason: config.reason })
  throw new Error(`enso-server: ${configPath}: ${config.reason}`)
}
if (configText === undefined) {
  log.info('no {configPath}: the defaults — no project roots, an empty web_fetch allowlist', { configPath })
}
// Trees became the default (#551 decision 1): said at every launch that relies on it, since an
// upgrade changes where a new thread's edits land with nothing in the user's own file saying so.
if (config.config.threads?.tree === undefined) {
  log.info(
    'new threads run in a tree of their own by default (#551): their edits stay out of your checkout — set "threads": {"tree": "off"} in {configPath} to keep them there',
    { configPath },
  )
}
const projectRoots: readonly string[] = config.config.projects?.roots ?? []
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = ensoAgentDir(home)
mkdirSync(agentDir, { recursive: true })

const { listening } = startEnsoServer({
  cwd,
  projectRoots,
  projectsConfigPath: configPath,
  // The replayed risk is measured as the guard measures it (#466): the user's thresholds.
  riskThresholds: incidentPolicyOf(config.config.security).thresholds,
  projectsStatePath: ensoProjectsPath(home),
  promptsDir: ensoPromptsDir(home),
  projectsDir: ensoProjectsDir(home),
  // Each new thread in its own tree (#551): a worktree by default, as the user's `threads` section overrides it.
  threadTree: (project) => threadTreeFor(config.config, project, (key) => canonicalConfigPath(key)),
  harnessPackageDir: harnessPackageDir(repoRoot),
  agentDir,
  permissionRulesPath: ensoPermissionRulesPath(home),
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
