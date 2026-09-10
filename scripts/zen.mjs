#!/usr/bin/env bun
/**
 * Launch a VANILLA pi with only zen-harness loaded.
 *
 * Isolation is two independent mechanisms, because each closes a different hole:
 *
 *   PI_CODING_AGENT_DIR  points pi at a scratch config dir, so none of the user's
 *                        installed packages, settings, keybindings, themes or
 *                        credentials are visible. Verified: 16 packages -> 0.
 *   --no-extensions      disables discovery, which also suppresses the PROJECT-local
 *                        .pi/settings.json in this repo (it installs zen-harness as a
 *                        package). Without it the package would load twice — once
 *                        from discovery, once from -e.
 *   --no-skills          ⚠ REQUIRED, and neither flag above covers it. pi discovers
 *                        skills from `~/.agents/skills/` as well as `~/.pi/agent/skills/`,
 *                        and the `~/.agents/` path is NOT under the agent dir — so
 *                        PI_CODING_AGENT_DIR does not redirect it and --no-extensions
 *                        does not touch skills. Found 2026-09-03 from a screenshot: a
 *                        session advertising itself as vanilla listed four of the user's
 *                        global skills (find-skills, herdr, mastra, shadcn).
 *
 * ⚠ `-e` receives the PACKAGE DIRECTORY, not each extension file. pi loads a directory
 *   using package rules, so the manifest drives everything — extensions, skills, prompts
 *   AND themes. Passing extension files individually (the original shape here) loaded the
 *   extensions and silently dropped every other resource kind, which is how a declared
 *   theme can appear to be wired and never load.
 *
 * ⚠ The scratch config dir has no credentials. Either `/login` inside it once, or export
 *   ANTHROPIC_API_KEY — which works here precisely because there is no auth.json to
 *   shadow it ("auth file credentials take priority over environment variables").
 *
 * ⚠ A `/login` here is a SEPARATE grant from the user's global one, with its own deadline:
 *   an Anthropic OAuth grant family has an absolute lifetime anchored at the interactive
 *   login (~30 days) that refresh rotation does not extend. So this dir will eventually
 *   demand its own re-login while the global one is still fine, and pi reports that as a
 *   bare `invalid_grant: "Refresh token expired"`. That is the cost of the isolation
 *   working, not a bug in it — see docs/concepts/provider-auth-and-client-identity.md.
 *
 * ⚠ A NON-INTERACTIVE RUN (`-p`, or piped stdin) loads a PRINT VARIANT of the package —
 *   the harness minus picc-permission-modes, which would otherwise fail closed and deny
 *   every mutating tool where no prompt can be shown. See the `isPrintRun` block below
 *   and scripts/print-harness.mjs (#20). Interactive runs keep the full permission model.
 *
 * Usage:  bun run zen -p "hello"
 *         ZEN_AGENT_DIR=/somewhere/else bun run zen
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  findRepoRoot,
  harnessPackageDir,
  printHarnessDir,
  quarantineSecrets,
  zenAgentDir,
} from '../packages/core/src/index.ts'
import { buildPrintManifest, materializePrintHarness } from './print-harness.mjs'

const repoRoot = findRepoRoot(import.meta.url)
const packageRoot = harnessPackageDir(repoRoot)
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

const VENDOR_PATH_PREFIX = 'node_modules/'

const declaredResources = Object.values(manifest.pi ?? {}).flatMap((paths) => (Array.isArray(paths) ? paths : [paths]))
if (declaredResources.length === 0) {
  console.error('zen: packages/harness/package.json declares no pi resources')
  process.exit(1)
}

/**
 * ⚠ pi does NOT error on a manifest resource path that does not exist — it skips it
 * silently (verified 2026-09-03: the vendor extension did not load and nothing was
 * reported). npm workspaces hoist our vendor packages to the repo root, so those paths
 * are missing until `bun run link:vendor` materializes them. Check here and refuse to
 * launch, because the alternative is a session that looks correct and is missing
 * whatever the vendor package was supposed to provide.
 */
const missingVendorPaths = declaredResources
  .filter((entry) => typeof entry === 'string' && entry.startsWith(VENDOR_PATH_PREFIX))
  .filter((entry) => !existsSync(resolve(packageRoot, entry)))

if (missingVendorPaths.length > 0) {
  console.error('zen: vendor package paths are missing from the harness package:')
  for (const missing of missingVendorPaths) console.error(`  - ${missing}`)
  console.error('zen: run `bun install` (its postinstall relinks the vendor packages)')
  process.exit(1)
}

const agentDir = process.env.ZEN_AGENT_DIR ?? zenAgentDir(repoRoot)
mkdirSync(agentDir, { recursive: true })

const passthroughArgs = process.argv.slice(2)

/**
 * ⚠ PRINT RUNS LOAD A VARIANT PACKAGE WITHOUT picc-permission-modes (#20).
 * picc fails closed when it cannot prompt — every mutating tool denied, no escape hatch —
 * so a `-p` run under the full package can chat and nothing else. The variant (built by
 * scripts/print-harness.mjs) is the harness minus that one extension: guards and
 * multi-account still load, skills/prompts/themes still load, and the run has OUR guards
 * only — bash unconfined (#9), the pre-picc posture. Launch-time mode selection upstream
 * (#13) is the durable fix; this is the honest interim.
 *
 * The trigger is "this run cannot prompt": an explicit `-p`/`--print`, or stdin that is
 * not a TTY (piped input cannot answer a permission dialog even without -p). Interactive
 * runs keep the full package and the full permission model.
 */
const isPrintRun = passthroughArgs.includes('-p') || passthroughArgs.includes('--print') || !process.stdin.isTTY

const packageToLoad = isPrintRun
  ? materializePrintHarness(printHarnessDir(repoRoot), packageRoot, buildPrintManifest(manifest))
  : packageRoot

const args = ['--no-extensions', '--no-skills', '-e', packageToLoad, ...passthroughArgs]

console.error(
  `zen: vanilla pi | agent-dir=${agentDir} | package=${packageToLoad}` +
    `${isPrintRun ? ' (print variant, no permission modes — #20)' : ''} | ` +
    `${declaredResources.length} declared resource path(s)`,
)

/**
 * ⚠ SECRETS OUT BEFORE THE SPAWN (#89). bun auto-loaded a root `.env` into THIS process's
 * environment; the spread below would carry every key into pi and from there into every
 * `bash` child — which is how `TAVILY_API_KEY` ended up in a transcript. The extensions
 * that need a key read `.zen/secrets.env` directly (`readSecret`); the environment carries
 * none, and a root `.env` that still holds a secret is reported as misplaced.
 */
const quarantine = quarantineSecrets(process.env, repoRoot)
if (quarantine.removed.length > 0)
  console.error(`zen: secrets kept out of pi's environment (#89): ${quarantine.removed.join(', ')}`)
if (quarantine.misplaced.length > 0) {
  console.error(
    `zen: ⚠ the root .env defines ${quarantine.misplaced.join(', ')} — bun autoloads .env into every bun child, ` +
      'so a tool can still read it there. Move it to .zen/secrets.env (#89); it is not read from .env.',
  )
}

const pi = Bun.spawn(['pi', ...args], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
})
// `exited` resolves with the exit code (never null, unlike Node's `exit` event).
process.exit(await pi.exited)
