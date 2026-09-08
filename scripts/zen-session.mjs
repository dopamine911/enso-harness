#!/usr/bin/env bun
/**
 * Inspect the live web server's threads from a shell — the agent's half of #86.
 *
 * Every readout the web surface shows is derived from the event stream. When one is
 * questioned, the human opens the debug drawer (`?debug`); an agent runs this. Both read
 * the same two endpoints, which report what pi's session ACTUALLY contains — the in-memory
 * branch, which is what pi acts on. The session file is a lagging copy: pi flushes it only
 * after the first assistant message, so a thread that has only run slash commands has
 * `sessionFile: null` and this is the only way to see its state at all.
 *
 * Read-only. Talks to the loopback dev server only.
 *
 * Usage:  bun scripts/zen-session.mjs                 # every live thread, one line each
 *         bun scripts/zen-session.mjs <threadId>      # one thread: summary, then the branch
 *         bun scripts/zen-session.mjs <threadId> --events  # the event tails (#97): what the
 *                                                          # host emitted, with provenance,
 *                                                          # then what the server sent
 *         bun scripts/zen-session.mjs <threadId> --json   # the raw payload, for piping
 *
 * The server address defaults to the dev server's; override with ZEN_SERVER_URL.
 */

const serverUrl = process.env.ZEN_SERVER_URL ?? "http://127.0.0.1:5179";
const [threadId, ...flags] = process.argv.slice(2);
const wantsJson = flags.includes("--json");
const wantsEvents = flags.includes("--events");

async function fetchJson(path) {
	let response;
	try {
		response = await fetch(`${serverUrl}${path}`);
	} catch (error) {
		console.error(`zen-session: cannot reach ${serverUrl} — is \`bun run dev\` up? (${String(error)})`);
		process.exit(1);
	}
	if (!response.ok) {
		console.error(`zen-session: ${response.status} ${await response.text()}`);
		process.exit(1);
	}
	return response.json();
}

/** pi's shapes are carried, not modelled — read the base fields defensively. */
function describeEntry(entry) {
	if (typeof entry !== "object" || entry === null) return String(entry);
	const kind = typeof entry.type === "string" ? entry.type : "?";
	const custom = typeof entry.customType === "string" ? `:${entry.customType}` : "";
	const role = typeof entry.message?.role === "string" ? ` ${entry.message.role}` : "";
	const when = typeof entry.timestamp === "string" ? entry.timestamp.slice(11, 19) : "        ";
	const mode = entry.customType === "modes" && typeof entry.data?.mode === "string" ? ` mode=${entry.data.mode}` : "";
	return `${when}  ${kind}${custom}${role}${mode}`;
}

if (threadId === undefined) {
	const threads = await fetchJson("/api/threads");
	if (threads.length === 0) {
		console.log("no live threads — nothing has run since the server started, or every session idled out");
	}
	for (const thread of threads) {
		const state = [thread.busy ? "busy" : "idle", thread.parked ? "parked" : null].filter(Boolean).join(",");
		const file = thread.sessionFile ?? "(in memory, not flushed yet)";
		console.log(`${thread.threadId}  mode=${thread.mode}  ${state}  last=${thread.lastActivityAt}  ${file}`);
	}
	process.exit(0);
}

/** `12:34:56  held ×3   entry_appended modes` — the same row the drawer shows, columned. */
function describeThreadEvent(event) {
	const count = event.count > 1 ? ` ×${event.count}` : "";
	const name = event.name === undefined ? "" : ` ${event.name}`;
	return `${event.at.slice(11, 19)}  ${(event.provenance + count).padEnd(12)} ${event.type}${name}`;
}

if (wantsEvents) {
	const events = await fetchJson(`/api/threads/${encodeURIComponent(threadId)}/events`);
	if (wantsJson) {
		console.log(JSON.stringify(events, null, 2));
		process.exit(0);
	}
	console.log(`thread ${events.threadId}`);
	console.log(`the host emitted (${events.emitted.length} events, oldest first):`);
	for (const event of events.emitted) console.log(`  ${describeThreadEvent(event)}`);
	console.log(`the server sent (${events.sent.length} chunks, oldest first):`);
	for (const event of events.sent) console.log(`  ${describeThreadEvent(event)}`);
	process.exit(0);
}

const inspection = await fetchJson(`/api/threads/${encodeURIComponent(threadId)}`);
if (wantsJson) {
	console.log(JSON.stringify(inspection, null, 2));
	process.exit(0);
}

console.log(`thread      ${inspection.threadId}`);
console.log(`session     ${inspection.sessionId}`);
console.log(`cwd         ${inspection.cwd}`);
console.log(`session dir ${inspection.sessionDir}`);
console.log(
	`file        ${inspection.sessionFile ?? "(in memory, not flushed yet — pi writes after the first assistant message)"}`,
);
console.log(
	`mode        ${inspection.permissionMode.mode}  (may switch to: ${inspection.permissionMode.available.join(", ")})`,
);
console.log(
	`state       ${inspection.busy ? "busy" : "idle"}${inspection.parked ? ", dialog parked" : ""}, last activity ${inspection.lastActivityAt}`,
);
console.log(`commands    ${inspection.commands.map((commandName) => `/${commandName}`).join(" ")}`);
console.log(`branch      ${inspection.entries.length} entries, root to leaf:`);
for (const branchEntry of inspection.entries) console.log(`  ${describeEntry(branchEntry)}`);
