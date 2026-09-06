import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../index.ts";

/**
 * Anchors for the reason this package exists.
 *
 * ⚠ These are not unit tests of a schema — they are the enforcement of "one place". Without
 * them, nothing stops the next session declaring `Type.Object` beside a consumer, which is
 * exactly the drift that made centralising them necessary. A convention with no check is a
 * convention that has already been broken somewhere nobody has looked.
 */

const packagesDir = join(import.meta.dir, "..", "..", "..");
// Matches `export const X = Type.…` AND the annotated form `export const X: TSchema = Type.…`
// (#53 S3: the bare regex let an annotated declaration through).
const SCHEMA_DECLARATION = /^export const [A-Za-z][A-Za-z0-9]*(?:: [^=\n]+)? = Type\./m;

/** Every `.ts`/`.tsx` under `packages/`, excluding node_modules and build output. */
function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist-types") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...sourceFiles(path));
		else if (/\.tsx?$/.test(entry.name)) found.push(path);
	}
	return found;
}

test("⚠ no TypeBox schema is declared outside @zen/core", () => {
	const offenders = sourceFiles(packagesDir)
		.filter((path) => !path.includes(`${join("packages", "core")}`))
		.filter((path) => SCHEMA_DECLARATION.test(readFileSync(path, "utf8")))
		.map((path) => path.slice(packagesDir.length + 1));
	// Named, not counted — a count cannot say which file to look at.
	expect(offenders).toEqual([]);
});

test("the barrel re-exports every module, so one import reaches every shape", () => {
	// If a module is added to src/ and not to index.ts, a consumer would have to reach past
	// the barrel — and "is this shape already declared?" stops being one search.
	const modules = readdirSync(join(import.meta.dir, ".."), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts")
		.map((entry) => entry.name);
	const barrel = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
	for (const module of modules) expect(barrel).toContain(module);
});

test("the schemas the rest of the repo depends on are actually exported", () => {
	// A spot check that the barrel resolves, rather than an inventory that rots.
	for (const name of [
		"GuardPolicy",
		"DEFAULT_GUARD_POLICY",
		"ZenToolResultDescriptor",
		"ZenObservation",
		"PiRpcEventSchema",
		"PiSession",
		"PiCommand",
		"PiImageContent",
		"PiStreamingBehavior",
	]) {
		expect(core).toHaveProperty(name);
	}
});
