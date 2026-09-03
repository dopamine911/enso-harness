/**
 * Dev entry point for the zen server.
 *
 * ⚠ `cwd` comes from an argument or this process's own cwd — NEVER from a request. With no
 * sandbox and `bash` unconfined (#9), whatever this value is becomes the blast radius, so
 * it is set by whoever starts the server rather than by whoever opens the page.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { startZenServer } from "./index.ts";

const cwdArgument = process.argv[2];
const cwd = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const harnessPackageDir = join(repoRoot, "packages", "harness");
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = join(repoRoot, ".zen", "pi-agent");
mkdirSync(agentDir, { recursive: true });

const { url } = startZenServer({
	launch: { cwd },
	harnessPackageDir,
	agentDir,
	onProblem: (problem) => console.error("[zen-server]", problem),
});

console.error(`[zen-server] listening on ${url}`);
console.error(`[zen-server]   pi cwd:   ${cwd}`);
console.error(`[zen-server]   package:  ${harnessPackageDir}`);
console.error(`[zen-server]   agentDir: ${agentDir}`);
