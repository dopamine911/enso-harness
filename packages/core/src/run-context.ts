import { type Static, Type } from "typebox";

/**
 * The conditions a run happened under, recorded in pi's own log (#126, #102 §6).
 *
 * An experiment whose conditions cannot be named cannot be compared, and a fork inherits
 * its parent's log — so provenance belongs IN that log as a custom entry, never in a side
 * file that a fork would not carry (`architecture.md`, and the pattern picc's `modes`
 * entry set).
 *
 * ⚠ ONE HOME PER FACT. pi already records the session id, `cwd` and `parentSession` in its
 * header, the model in a `model_change` entry, the thinking level in its own, and picc the
 * mode in `modes`. None of that is copied here — a copy is a second home that can disagree
 * with the first. This entry carries exactly what pi's log does NOT know:
 *
 *   • `revision`   — the project tree the run read, by commit, branch and dirtiness
 *   • `context`    — which context files were loaded, and a hash over their contents
 *   • `skills`     — the skills pi had loaded for the run
 *   • `harness`    — the harness configuration the run used, by digest
 *
 * ⚠ APPENDED ON CHANGE, never per turn. A two-hundred-turn thread under unchanged
 * conditions holds one entry; the reader's rule is last-wins, so "the conditions at entry
 * N" is the newest record at or before N.
 */

/** The `customType` this harness persists a run's conditions under. */
export const ZEN_RUN_CONTEXT_CUSTOM_TYPE = "zen:run-context";

/** The project tree a run read. `dirty` is undefined when git could not be consulted. */
export const ZenRunRevision = Type.Object(
	{
		/** The commit HEAD pointed at, full sha — `unknown` when there is no checkout. */
		commit: Type.String(),
		/** The branch name when HEAD is symbolic; absent on a detached HEAD. */
		branch: Type.Optional(Type.String()),
		/** Uncommitted changes present. Undefined when git itself could not answer. */
		dirty: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
export type ZenRunRevision = Static<typeof ZenRunRevision>;

/**
 * What pi loaded into the prompt, by name and by content. The paths say WHICH files, the
 * digest says whether their bytes changed — an edited `AGENTS.md` is a different condition
 * under the same path, and comparing two forks has to see that.
 */
export const ZenRunContextFiles = Type.Object(
	{
		/** Paths as pi reported them, sorted, so the list is comparable between runs. */
		paths: Type.Array(Type.String()),
		/** Hex digest over the sorted paths AND their contents. */
		digest: Type.String(),
	},
	{ additionalProperties: false },
);
export type ZenRunContextFiles = Static<typeof ZenRunContextFiles>;

export const ZenRunContext = Type.Object(
	{
		/** Schema version of this record: a reader may meet an older fork's entry. */
		version: Type.Literal(1),
		/** ISO 8601, when the record was appended. */
		at: Type.String(),
		revision: ZenRunRevision,
		context: ZenRunContextFiles,
		/** Skill names pi had loaded, sorted. */
		skills: Type.Array(Type.String()),
		/**
		 * A digest over the harness configuration the run used (`zen.config.json`, its absence
		 * included as its own value).
		 *
		 * ⚠ No harness VERSION field: every package here is `0.0.0`, so it would compare
		 * nothing. Which harness build ran is `revision` when the run reads this checkout, and
		 * the bundle's `about` otherwise (#132). A field that cannot distinguish two runs has no
		 * business in a record whose whole purpose is distinguishing runs.
		 */
		harness: Type.Object({ configDigest: Type.String() }, { additionalProperties: false }),
	},
	{ additionalProperties: false },
);
export type ZenRunContext = Static<typeof ZenRunContext>;

/**
 * The run context carried by ONE entry, or undefined when the entry is not ours, is
 * malformed, or is a version this reader does not know. Defensive like every wire
 * crossing: an unrelated extension's custom entry is ignored, never a throw inside a loop.
 */
export function readZenRunContext(entry: unknown): ZenRunContext | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const { customType, data } = entry as { customType?: unknown; data?: unknown };
	if (customType !== ZEN_RUN_CONTEXT_CUSTOM_TYPE) return undefined;
	if (typeof data !== "object" || data === null) return undefined;
	const candidate = data as { version?: unknown };
	if (candidate.version !== 1) return undefined;
	const { at, revision, context, skills, harness } = data as Record<string, unknown>;
	if (typeof at !== "string" || typeof revision !== "object" || revision === null) return undefined;
	if (typeof context !== "object" || context === null || !Array.isArray(skills)) return undefined;
	if (typeof harness !== "object" || harness === null) return undefined;
	return data as ZenRunContext;
}

/**
 * The conditions in force at the end of a branch: the LAST run-context entry, or undefined
 * when the thread has none (an older thread, or one that has not run).
 *
 * ⚠ Walked from the end, never cached — `/fork`, `/tree` and `/branch` move the leaf onto a
 * path whose last entry differs, which is the whole point of recording per branch. Same
 * rule, and the same reason, as `persistedPermissionMode`.
 */
export function latestRunContext(branch: readonly unknown[]): ZenRunContext | undefined {
	for (let position = branch.length - 1; position >= 0; position -= 1) {
		const found = readZenRunContext(branch[position]);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * Whether a new record says something the last one did not — the append rule (#126 item 5).
 * Compared on the CONDITIONS only: `at` is when the record was written, and writing a
 * record because time passed is exactly the per-turn noise this avoids.
 */
export function runContextChanged(previous: ZenRunContext | undefined, next: ZenRunContext): boolean {
	if (previous === undefined) return true;
	return conditionsOf(previous) !== conditionsOf(next);
}

function conditionsOf(record: ZenRunContext): string {
	return JSON.stringify([record.revision, record.context, record.skills, record.harness]);
}

/**
 * A run context as one line — `a1b2c3d4e5f6 (main, dirty) · 3 context files 9f8e7d · 2 skills`.
 * THE description, so the debug pane, a manifest view and `zen-session.mjs` cannot drift
 * the way the entry describers did before `describeSessionEntry` (PR #100 review).
 */
export function describeRunContext(record: ZenRunContext): string {
	const files = `${record.context.paths.length} context file${record.context.paths.length === 1 ? "" : "s"} ${record.context.digest.slice(0, 6)}`;
	const skills = `${record.skills.length} skill${record.skills.length === 1 ? "" : "s"}`;
	return `${record.revision.commit.slice(0, 12)} (${describeTree(record.revision)}) · ${files} · ${skills}`;
}

/** What is in the parentheses: the branch, and whether the tree was dirty — or that neither is known. */
function describeTree(revision: ZenRunRevision): string {
	if (revision.commit.startsWith("unknown")) return "no checkout";
	const dirtiness = dirtinessOf(revision.dirty);
	const branch = revision.branch ?? "detached";
	return dirtiness === "" ? branch : `${branch}, ${dirtiness}`;
}
/** `dirty`, nothing when clean, and — the honest third case — that git could not be asked. */
function dirtinessOf(dirty: boolean | undefined): "dirty" | "" | "dirtiness unknown" {
	if (dirty === true) return "dirty";
	if (dirty === false) return "";
	return "dirtiness unknown";
}
