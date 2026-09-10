import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	runContextChanged,
	ZEN_RUN_CONTEXT_CUSTOM_TYPE,
	type ZenRunContext,
	type ZenRunRevision,
	zenConfigPath,
	zenLogger,
} from "@zen/core";

/**
 * The conditions a run happened under, appended to pi's log when they change (#126).
 *
 * pi records the session, the model, the thinking level and — through picc — the mode. It
 * does not record which project tree the run read, which context files were loaded, which
 * skills were active, or how this harness was configured. Those are the fields a fork has
 * to carry for two branches to be comparable, so this extension writes them, in pi's own
 * log, as a `zen:run-context` custom entry (`@zen/core/run-context` owns the shape).
 *
 * ⚠ ON CHANGE, not per turn. The branch is read at each run start and the record is
 * appended only when it differs from the newest one already there — a long thread under
 * unchanged conditions holds exactly one. The reader's rule is last-wins, so the
 * conditions at any entry are the newest record at or before it.
 *
 * ⚠ `before_agent_start` is the hook because it is where pi hands over what it LOADED —
 * `systemPromptOptions.contextFiles` and `.skills`, its own answer rather than this
 * extension re-discovering resources and disagreeing with it.
 */

const log = zenLogger("extension", "run-context");

/** A git call that must never hold up a run, and must never throw into pi's loop. */
const GIT_TIMEOUT_MS = 2000;

/**
 * HEAD by hand — no shell for the common case, the way the bundle's `about` reads it. The
 * commit is what a fork is compared by, so it is the full sha, not an abbreviation.
 */
function readHead(cwd: string): { commit: string; branch?: string } {
	const headPath = join(cwd, ".git", "HEAD");
	if (!existsSync(headPath)) return { commit: "unknown (no .git)" };
	const head = readFileSync(headPath, "utf8").trim();
	if (!head.startsWith("ref: ")) return { commit: head };
	const ref = head.slice("ref: ".length);
	const branch = ref.replace("refs/heads/", "");
	const refPath = join(cwd, ".git", ref);
	if (existsSync(refPath)) return { commit: readFileSync(refPath, "utf8").trim(), branch };
	const packed = join(cwd, ".git", "packed-refs");
	if (existsSync(packed)) {
		const row = readFileSync(packed, "utf8")
			.split("\n")
			.find((line) => line.endsWith(` ${ref}`));
		if (row !== undefined) return { commit: row.slice(0, row.indexOf(" ")), branch };
	}
	return { commit: `unknown (${ref})`, branch };
}

/**
 * Uncommitted changes, from git itself — the one fact `.git` cannot be read for, since
 * dirtiness is the working tree against the index. `undefined` when git is absent, slow or
 * unhappy: a run context that says "I could not tell" is honest, one that guesses is not.
 */
function readDirty(cwd: string): boolean | undefined {
	try {
		const status = spawnSync("git", ["status", "--porcelain"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (status.status !== 0 || typeof status.stdout !== "string") return undefined;
		return status.stdout.trim().length > 0;
	} catch {
		return undefined;
	}
}

function revisionOf(cwd: string): ZenRunRevision {
	const head = readHead(cwd);
	const dirty = readDirty(cwd);
	return {
		...head,
		...(dirty === undefined ? {} : { dirty }),
	};
}

/** Hex digest over an ordered list of strings, each length-prefixed so a join cannot forge one. */
function digestOf(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(`${part.length}:${part}\u0000`);
	return hash.digest("hex");
}

interface LoadedContext {
	readonly paths: readonly string[];
	readonly contents: readonly string[];
	readonly skills: readonly string[];
}

/**
 * What pi says it loaded, read defensively — `systemPromptOptions` is a vendor shape
 * crossing into ours, and a run must not fail because a field moved.
 */
function loadedContextOf(options: unknown): LoadedContext {
	const source = (typeof options === "object" && options !== null ? options : {}) as {
		contextFiles?: unknown;
		skills?: unknown;
	};
	const files = Array.isArray(source.contextFiles) ? source.contextFiles : [];
	const rows = files
		.map((file) => (typeof file === "object" && file !== null ? (file as { path?: unknown; content?: unknown }) : {}))
		.map((file) => ({
			path: typeof file.path === "string" ? file.path : "(unnamed)",
			content: typeof file.content === "string" ? file.content : "",
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	const skills = (Array.isArray(source.skills) ? source.skills : [])
		.map((skill) => (typeof skill === "object" && skill !== null ? (skill as { name?: unknown }).name : skill))
		.map((name) => (typeof name === "string" ? name : "(unnamed)"))
		.sort((left, right) => left.localeCompare(right));
	return { paths: rows.map((row) => row.path), contents: rows.map((row) => row.content), skills };
}

/** The harness's configuration as it stands, by digest — absent file included, as its own value. */
function configDigest(cwd: string): string {
	const path = zenConfigPath(cwd);
	return digestOf([existsSync(path) ? readFileSync(path, "utf8") : "(no zen.config.json)"]);
}

export function createRunContextExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		// ⚠ The comparison base is THIS session's last append, held here, because the extension
		// API exposes no reader for the branch (`appendEntry` writes; nothing reads). The
		// consequence is deliberate and desirable: the first run of every session — a resume, a
		// fork — records its conditions, which is exactly when a branch's conditions may differ
		// from the parent's. Within a session it is then append-on-change, as the rule says.
		// The READER (`latestRunContext`) walks the branch, so the log stays the source.
		let lastRecorded: ZenRunContext | undefined;
		pi.on("before_agent_start", (event): void => {
			try {
				const promptOptions = "systemPromptOptions" in event ? event.systemPromptOptions : undefined;
				const cwd =
					typeof promptOptions === "object" && promptOptions !== null && "cwd" in promptOptions
						? String(promptOptions.cwd)
						: process.cwd();
				const loaded = loadedContextOf(promptOptions);
				const next: ZenRunContext = {
					version: 1,
					at: new Date().toISOString(),
					revision: revisionOf(cwd),
					context: {
						paths: [...loaded.paths],
						digest: digestOf([...loaded.paths, ...loaded.contents]),
					},
					skills: [...loaded.skills],
					harness: { configDigest: configDigest(cwd) },
				};
				if (!runContextChanged(lastRecorded, next)) return;
				pi.appendEntry(ZEN_RUN_CONTEXT_CUSTOM_TYPE, next);
				lastRecorded = next;
				log.info("run context recorded: {commit}{dirty}, {contextFiles} context file(s), {skills} skill(s)", {
					commit: next.revision.commit.slice(0, 12),
					dirty: next.revision.dirty === true ? " (dirty)" : "",
					contextFiles: next.context.paths.length,
					skills: next.skills.length,
					digest: next.context.digest.slice(0, 12),
				});
			} catch (error) {
				// ⚠ Provenance must never take a run down: a missing field, an unreadable file, a
				// git that hangs. The run proceeds unrecorded and the failure is a record itself.
				log.warn("run context not recorded: {error}", { error: String(error) });
			}
		});
	};
}

/** The pi entry point. */
export default createRunContextExtension();
