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
 *                        package). Without it the extension would load twice — once
 *                        from the package, once from -e.
 *
 * The -e list is derived from the package manifest rather than hardcoded, so it cannot
 * drift from what ships and it exercises the manifest's declared order on every run.
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
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "harness");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

const declared = manifest.pi?.extensions ?? [];
if (declared.length === 0) {
	console.error("zen: packages/harness/package.json declares no pi.extensions");
	process.exit(1);
}

const agentDir = process.env.ZEN_AGENT_DIR ?? join(repoRoot, ".zen", "pi-agent");
mkdirSync(agentDir, { recursive: true });

const extensionFlags = declared.flatMap((entry) => ["-e", resolve(packageRoot, entry)]);
const args = ["--no-extensions", ...extensionFlags, ...process.argv.slice(2)];

console.error(`zen: vanilla pi | agent-dir=${agentDir} | ${declared.length} extension(s): ${declared.join(", ")}`);

spawn("pi", args, {
	stdio: "inherit",
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
}).on("exit", (code) => process.exit(code ?? 0));
