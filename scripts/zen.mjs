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
 * ⚠ THE `pi` SPAWNED HERE IS VERSION-GATED (#217). It comes from `PATH`, while the guard's
 *   replica of pi's path resolver is pinned against the pi in the workspace tree — two
 *   resolutions that nothing held together. The version is read before the spawn and refused
 *   outside `zen-launch.mjs#SUPPORTED_PI_VERSIONS`; see the block below.
 *
 * Usage:  bun run zen -p "hello"
 *         ZEN_AGENT_DIR=/somewhere/else bun run zen
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot, harnessPackageDir, printHarnessDir, zenAgentDir } from '../packages/core/src/paths.ts'
import { quarantineSecrets } from '../packages/core/src/secrets.ts'
import { buildPrintManifest, materializePrintHarness } from './print-harness.mjs'
import {
  declaredResources,
  isPrintRun,
  missingVendorPaths,
  piArguments,
  piVersionSupported,
  piVersionText,
  SUPPORTED_PI_VERSIONS,
} from './zen-launch.mjs'

const repoRoot = findRepoRoot(import.meta.url)
const packageRoot = harnessPackageDir(repoRoot)
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

const resources = declaredResources(manifest)
if (resources.length === 0) {
  process.stderr.write('zen: packages/harness/package.json declares no pi resources\n')
  process.exit(1)
}

// The check and its reason: `zen-launch.mjs#missingVendorPaths`. Refuse to launch on a gap.
const missing = missingVendorPaths(manifest, packageRoot)
if (missing.length > 0) {
  process.stderr.write('zen: vendor package paths are missing from the harness package:\n')
  for (const missingPath of missing) process.stderr.write(`  - ${missingPath}\n`)
  process.stderr.write('zen: run `bun install` (its postinstall relinks the vendor packages)\n')
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
 * (#13) is the durable fix; this is the honest interim. The trigger: `zen-launch.mjs#isPrintRun`.
 */
const printRun = isPrintRun(passthroughArgs, process.stdin.isTTY === true)

const packageToLoad = printRun
  ? materializePrintHarness(printHarnessDir(repoRoot), packageRoot, buildPrintManifest(manifest))
  : packageRoot

// The isolation triple's two argument legs: `zen-launch.mjs#piArguments`.
const args = piArguments(packageToLoad, passthroughArgs)

/**
 * ⚠ SECRETS OUT BEFORE ANY CHILD (#89). bun auto-loaded a root `.env` into THIS process's
 * environment; the spread below would carry every key into pi and from there into every
 * `bash` child — which is how `TAVILY_API_KEY` ended up in a transcript. The extensions
 * that need a key read `.zen/secrets.env` directly (`readSecret`); the environment carries
 * none, and a root `.env` that still holds a secret is reported as misplaced.
 *
 * ⚠ FIRST, not just before the pi spawn (PR #294 review). `secrets.ts` says "before any
 * session or child process exists", and #217 added a child ahead of it: the `pi --version`
 * probe below, handed the un-scrubbed environment — to the one binary this launcher has not
 * yet decided it trusts, which is the entire premise of the version gate. A pi that prints
 * its environment diagnostically, or a shadowing pi earlier on `PATH`, could read a key out
 * of `--version`. Quarantining here makes the probe's inherited environment the scrubbed
 * one, so the ordering matches the invariant instead of contradicting it eight lines down.
 */
const quarantine = quarantineSecrets(process.env, repoRoot)
if (quarantine.removed.length > 0)
  process.stderr.write(`zen: secrets kept out of pi's environment (#89): ${quarantine.removed.join(', ')}\n`)
if (quarantine.misplaced.length > 0) {
  process.stderr.write(
    `zen: ⚠ the root .env defines ${quarantine.misplaced.join(', ')} — bun autoloads .env into every bun child, ` +
      'so a tool can still read it there. Move it to .zen/secrets.env (#89); it is not read from .env.\n',
  )
}

/**
 * ⚠ THE PI ON `PATH` IS NOT NECESSARILY THE PI THE GUARD WAS PINNED AGAINST (#217). The guard
 * REPLICATES pi's path normaliser (`packages/harness/core/paths.ts`) and the corpus pins the
 * copy against the pi in the WORKSPACE tree; this spawn takes whatever `pi` comes first on
 * `PATH`, which is a different resolution that no manifest bounded. Reproduced 2026-09-18 with
 * a shim printing `0.85.0` earlier on `PATH`: it launched, and the whole suite stayed green —
 * the guard resolving a path differently from the tool it gates is exactly the failure the
 * replica exists to prevent. So the version is read BEFORE the spawn and refused when it falls
 * outside `zen-launch.mjs#SUPPORTED_PI_VERSIONS`, the shape `assertVendorLinks` already uses on
 * the other surface: one precondition, enforced at both launch points.
 *
 * There is no override flag, deliberately: the range is widened by running the corpus against
 * the new pi (`scripts/__tests__/pi-version-parity.test.ts` is what holds those two together), not by a flag
 * on a launch. The cost is one extra process per launch, ~30 ms.
 */
/**
 * ⚠ The probe is BOUNDED, and its exit is read (PR #294 review). A precondition that can hang
 * is not a precondition: a wedged `pi --version` parked the launcher with no output at all,
 * which is worse than the refusal it exists to print. And a probe that exits non-zero has not
 * reported anything — whatever landed on stdout is not a version claim, so it is refused
 * rather than parsed. Both fail the way the range check does: closed, and named.
 *
 * The deadline races the READ, not just the process. Killing the child does not necessarily
 * end the stream: a shell shim's own child inherits the pipe and holds it open after its
 * parent dies, so awaiting stdout to EOF hung for the full 30s of a `sleep` shim even with the
 * kill armed. Measured, then fixed by racing.
 */
const PI_PROBE_TIMEOUT_MS = 5000
let reportedPiVersion = ''
try {
  // ⚠ `env` EXPLICITLY, or the quarantine above does not reach this child (PR #294 review,
  // measured): a `Bun.spawn` with no `env` hands the child the environment this process
  // STARTED with, not its live `process.env` — deletions and additions made since are both
  // invisible. So ordering the quarantine first is necessary and not sufficient; the probe
  // has to be given the scrubbed object, the way the pi spawn below is.
  const probe = Bun.spawn(['pi', '--version'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    env: process.env,
  })
  const reported = (async () => ({
    text: (await new Response(probe.stdout).text()).trim(),
    status: await probe.exited,
  }))()
  const outcome = await Promise.race([reported, Bun.sleep(PI_PROBE_TIMEOUT_MS).then(() => null)])
  if (outcome === null) {
    probe.kill('SIGKILL')
    process.stderr.write(
      `zen: \`pi --version\` did not answer within ${PI_PROBE_TIMEOUT_MS / 1000}s, so the version the guards ` +
        'are pinned against could not be read (#217)\n',
    )
    process.exit(1)
  }
  if (outcome.status !== 0) {
    process.stderr.write(
      `zen: \`pi --version\` exited ${outcome.status}, so the version the guards are pinned against ` +
        'could not be read (#217)\n',
    )
    process.exit(1)
  }
  reportedPiVersion = outcome.text
} catch {
  process.stderr.write('zen: no `pi` on PATH — the terminal surface spawns it, so install it first\n')
  process.exit(1)
}
if (!piVersionSupported(reportedPiVersion)) {
  process.stderr.write(
    `zen: the \`pi\` on PATH reports ${reportedPiVersion === '' ? 'no version' : reportedPiVersion}, ` +
      `outside the range the guards are pinned against ` +
      `(>=${piVersionText(SUPPORTED_PI_VERSIONS.minimum)} <${piVersionText(SUPPORTED_PI_VERSIONS.below)}).\n` +
      "The guard replicates pi's path resolver; against an unpinned pi a deny can be computed against the wrong\n" +
      'target (#217). Either use the pinned pi, or run the corpus against this one and widen the range:\n' +
      '  bun test packages/harness/core/__tests__/paths.test.ts   then scripts/zen-launch.mjs#SUPPORTED_PI_VERSIONS\n',
  )
  process.exit(1)
}

process.stderr.write(
  `zen: vanilla pi ${reportedPiVersion} | agent-dir=${agentDir} | package=${packageToLoad}` +
    `${printRun ? ' (print variant, no permission modes — #20)' : ''} | ` +
    `${resources.length} declared resource path(s)\n`,
)

const pi = Bun.spawn(['pi', ...args], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
})
// `exited` resolves with the exit code (never null, unlike Node's `exit` event).
process.exit(await pi.exited)
