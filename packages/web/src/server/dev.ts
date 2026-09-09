/**
 * Dev entry point for the zen server.
 *
 * ⚠ `cwd` comes from an argument or this process's own cwd — NEVER from a request. With no
 * sandbox and `bash` unconfined (#9), whatever this value is becomes the blast radius, so
 * it is set by whoever starts the server rather than by whoever opens the page.
 *
 * The launcher is where logging is configured (#132): the library under it configures
 * nothing. The terminal sees `info` and up; the file under `.zen/logs` gets everything.
 */

import { mkdirSync } from "node:fs";
import { findRepoRoot, harnessPackageDir, zenAgentDir, zenLogger, zenLogsDir } from "@zen/core";
import { startZenServer } from "./index.ts";
import { configureProcessLogging } from "./logging.ts";

const cwdArgument = process.argv[2];
const cwd = cwdArgument === undefined || cwdArgument.length === 0 ? process.cwd() : cwdArgument;

const repoRoot = findRepoRoot(import.meta.url);
// Same scratch dir the TUI launcher uses, so both surfaces share one isolated config.
const agentDir = zenAgentDir(repoRoot);
mkdirSync(agentDir, { recursive: true });

const disposeLogging = await configureProcessLogging({
	logsDir: zenLogsDir(repoRoot),
	file: "server.jsonl",
	console: "info",
});
const log = zenLogger("server", "dev");

// A stop from the hub or a terminal: flush the file before the process goes.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void disposeLogging().finally(() => process.exit(0));
	});
}

const { listening } = startZenServer({
	cwd,
	harnessPackageDir: harnessPackageDir(repoRoot),
	agentDir,
});

try {
	log.info("listening on {url} · pi cwd {cwd} · package {harnessPackageDir} · agentDir {agentDir} · logs {logsDir}", {
		url: await listening,
		cwd,
		harnessPackageDir: harnessPackageDir(repoRoot),
		agentDir,
		logsDir: zenLogsDir(repoRoot),
	});
} catch {
	// The bind failed; the server already logged why. Exit non-zero instead of dangling.
	process.exitCode = 1;
}
