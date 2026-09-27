/**
 * The environment boundary (#89): every file allowed to read the real process environment.
 *
 * `node/no-process-env` cannot be satisfied by a program that has to read its own environment,
 * so the rule is not switched off — it is scoped to THIS LIST (`oxlint.config.ts`), and the list
 * is the inventory of every place that touches the real environment. A new file reading
 * `process.env` fails the gate and has to argue its way onto this list; everything else takes an
 * injected environment, which is also what makes the quarantine testable (#89) without a test
 * ever reading the machine it runs on.
 *
 * ⚠ oxlint's rule sees `process.env` (and its destructuring) but not `import { env } from
 * 'node:process'`, which Biome's `noProcessEnv` also refused. `scripts/docs/env-and-config.ts`
 * detects that spelling too and fails generation when its readers and this list diverge, so the
 * inventory holds even where the lint rule is blind.
 */
export const PROCESS_ENVIRONMENT_READERS: readonly string[] = [
  'scripts/enso.ts', // the launcher: quarantine, then the spawn's env
  'scripts/enso-thread.ts', // ENSO_SERVER_URL
  'scripts/enso-logs.ts', // ENSO_SERVER_URL, ENSO_HOME
  'scripts/gate.ts', // npm_config_user_agent, and the child's FORCE_COLOR
  'packages/core/src/secrets.ts', // the quarantine's default argument — the seam itself
  'packages/harness/extensions/logging/index.ts', // the pi entry point's own environment
  'packages/harness/extensions/web-fetch/index.ts', // ENSO_HOME: where the user's config is (#421)
  'packages/harness/extensions/web-search/index.ts', // ENSO_HOME: where the secrets file and the config are (#421)
  'packages/web/src/host/agent-host.ts', // pins PI_CODING_AGENT_DIR, then quarantines
  'packages/web/src/server/dev.ts', // launcher: ENSO_HOME + levels
  'packages/web/src/server/dev-web.ts', // launcher: ENSO_HOME + levels
  'scripts/docs/site-base.ts', // ENSO_SITE_BASE: where the published site is served from
]
