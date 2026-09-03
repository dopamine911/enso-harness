#!/usr/bin/env node
/**
 * Run both dev surfaces with one command.
 *
 * ⚠ WHY THIS EXISTS RATHER THAN A `concurrently` DEPENDENCY
 * Two child processes and a shared teardown is about forty lines. A dependency for it
 * would be a third-party package in the critical path of every dev session, and this repo
 * has spent the day cataloguing what unpinned third-party packages cost.
 *
 * ⚠ The server MUST come up before vite proxies to it — vite's proxy does not retry a
 * refused connection, it returns 500 to the browser, and that reads as "the app is broken"
 * rather than "the API is not up yet". So the server is started first and given a moment.
 *
 * Usage:  npm run dev                 # pi runs in the repo root
 *         npm run dev -- /some/path   # pi runs there instead
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_HEAD_START_MS = 1_200;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webPackageDir = join(repoRoot, "packages", "web");
const piCwd = process.argv[2] ?? repoRoot;

const children = [];
let shuttingDown = false;

function run(label, command, args) {
	const child = spawn(command, args, { cwd: webPackageDir, stdio: ["ignore", "pipe", "pipe"] });
	const prefix = (chunk) =>
		String(chunk)
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => `[${label}] ${line}`)
			.join("\n");
	child.stdout.on("data", (chunk) => console.log(prefix(chunk)));
	child.stderr.on("data", (chunk) => console.error(prefix(chunk)));
	// ⚠ If either surface dies, take the other down. A half-running dev environment is
	// worse than none: vite serving a page whose API is gone looks like an app bug.
	child.on("exit", (code) => {
		if (shuttingDown) return;
		console.error(`[dev] ${label} exited (${code ?? "signal"}) — stopping the other surface`);
		shutdown();
	});
	children.push(child);
	return child;
}

function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) child.kill("SIGTERM");
	// Do not wait forever on a child that ignores SIGTERM.
	setTimeout(() => process.exit(0), 500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.error(`[dev] pi will run in ${piCwd}`);
run("server", "node", ["--experimental-strip-types", "src/server/dev.ts", piCwd]);

setTimeout(() => {
	if (!shuttingDown) run("web", "npx", ["vite"]);
}, SERVER_HEAD_START_MS).unref();
