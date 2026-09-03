#!/usr/bin/env node
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
 * Usage:  npm run zen -- -p "hello"
 *         ZEN_AGENT_DIR=/somewhere/else npm run zen
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "harness");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

const VENDOR_PATH_PREFIX = "node_modules/";

const declaredResources = Object.values(manifest.pi ?? {}).flatMap((paths) =>
	Array.isArray(paths) ? paths : [paths],
);
if (declaredResources.length === 0) {
	console.error("zen: packages/harness/package.json declares no pi resources");
	process.exit(1);
}

/**
 * ⚠ pi does NOT error on a manifest resource path that does not exist — it skips it
 * silently (verified 2026-09-03: the vendor extension did not load and nothing was
 * reported). npm workspaces hoist our vendor packages to the repo root, so those paths
 * are missing until `npm run link:vendor` materializes them. Check here and refuse to
 * launch, because the alternative is a session that looks correct and is missing
 * whatever the vendor package was supposed to provide.
 */
const missingVendorPaths = declaredResources
	.filter((entry) => typeof entry === "string" && entry.startsWith(VENDOR_PATH_PREFIX))
	.filter((entry) => !existsSync(resolve(packageRoot, entry)));

if (missingVendorPaths.length > 0) {
	console.error("zen: vendor package paths are missing from the harness package:");
	for (const missing of missingVendorPaths) console.error(`  - ${missing}`);
	console.error("zen: run `npm install && npm run link:vendor`");
	process.exit(1);
}

const agentDir = process.env.ZEN_AGENT_DIR ?? join(repoRoot, ".zen", "pi-agent");
mkdirSync(agentDir, { recursive: true });

const args = ["--no-extensions", "--no-skills", "-e", packageRoot, ...process.argv.slice(2)];

console.error(
	`zen: vanilla pi | agent-dir=${agentDir} | package=${packageRoot} | ${declaredResources.length} declared resource path(s)`,
);

spawn("pi", args, {
	stdio: "inherit",
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
}).on("exit", (code) => process.exit(code ?? 0));
