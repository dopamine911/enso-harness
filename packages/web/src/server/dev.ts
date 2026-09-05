/**
 * Dev entry point for the zen server.
 *
 * ⚠ `cwd` comes from an argument or this process's own cwd — NEVER from a request. With no
 * sandbox and `bash` unconfined (#9), whatever this value is becomes the blast radius, so
 * it is set by whoever starts the server rather than by whoever opens the page.
 */

import { mkdirSync } from "node:fs";
import { findRepoRoot, harnessPackageDir, zenAgentDir } from "@zen/core";
import { startZenServer } from "./index.ts";

const cwdArgument = process.argv[2];
const cwd = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument;

const repoRoot = findRepoRoot(import.meta.url);
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = zenAgentDir(repoRoot);
mkdirSync(agentDir, { recursive: true });

const { url } = startZenServer({
	cwd,
	harnessPackageDir: harnessPackageDir(repoRoot),
	agentDir,
	onProblem: (problem) => console.error("[zen-server]", problem),
});

console.error(`[zen-server] listening on ${url}`);
console.error(`[zen-server]   pi cwd:   ${cwd}`);
console.error(`[zen-server]   package:  ${harnessPackageDir(repoRoot)}`);
console.error(`[zen-server]   agentDir: ${agentDir}`);
