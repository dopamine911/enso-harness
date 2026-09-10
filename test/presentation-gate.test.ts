import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Presentation stays presentation (#121 item 4, #31).
 *
 * ⚠ Enforcement, not a unit test — the shape of `logging-gate.test.ts` and
 * `vendor-gate.test.ts`. Two lines about `components/ai-elements/`, which is the one
 * directory in this repo whose files came from somewhere else:
 *
 *   1. **Every file names its origin.** The pinned upstream commit in a provenance header,
 *      so a reader knows the file is ported, and a port that drifts can be diffed against
 *      the pin. A vendored file without provenance is just code nobody dares touch.
 *   2. **Nothing under it holds APPLICATION state.** The distinction that makes the rule
 *      usable: a disclosure's open flag, an IME composing flag, the attachment strip before
 *      submit — component-local `useState`/`useRef` — is what a presentation component IS,
 *      and forbidding it would forbid the components. What may not cross is the *state
 *      layer*: our stores, the follow connection, the wire schemas, TanStack's client. A
 *      component that reads a thread's store is no longer portable, no longer replaceable
 *      by an upstream re-port, and the seam README rule 3 names has moved.
 *
 * So the gate matches imports, not hooks. Today the six ported files import React, two ui
 * primitives, `lucide-react`, `use-stick-to-bottom` and each other — nothing else — and the
 * point of the test is that the first import of a store fails the build instead of passing
 * review.
 */

const repositoryRoot = join(import.meta.dir, "..");
const PORTED_DIRECTORY = "packages/web/src/components/ai-elements";
/** The pin every ported file carries; bump it here when the clone moves (the #31 procedure). */
const UPSTREAM_PIN = "6a9d5b1822ffb10bba4bd97175f01edd7d8651cd";
const SOURCE_EXTENSION = /\.tsx?$/;

/**
 * The state layer, by import. `@zen/core` is the wire: a presentation component taking a
 * `ZenObservation` is reading the protocol, which is the renderer's job (README rule 4 —
 * types are retyped as they cross, not imported).
 *
 * ⚠ Both spellings of the same module (PR #152 review). `packages/web/tsconfig.json` maps
 * `@/*` to `./src/*`, and these files already reach for that alias for their ui primitives —
 * so `@/store.ts` is the MORE natural way to write the import this gate exists to refuse,
 * and a relative-only pattern would have waved it through.
 */
const STATE_LAYER_MODULES = "store|thread-stores|stored-threads|follow-connection|session-stats|custom-event-router";
const STATE_LAYER_IMPORT = new RegExp(
	`from\\s+["'](?:@zen/core|@tanstack/[^"']+|(?:(?:\\.\\./)+|@/)(?:${STATE_LAYER_MODULES})\\.ts)["']`,
);

function portedFiles(): string[] {
	const directory = join(repositoryRoot, PORTED_DIRECTORY);
	return readdirSync(directory)
		.filter((name) => SOURCE_EXTENSION.test(name))
		.map((name) => join(directory, name));
}

test("⚠ every ported presentation file names its upstream pin (#31, #121)", () => {
	const withoutProvenance = portedFiles()
		.filter((path) => !readFileSync(path, "utf8").includes(UPSTREAM_PIN))
		.map((path) => path.slice(repositoryRoot.length + 1));
	expect(withoutProvenance).toEqual([]);
});

test("⚠ nothing under ai-elements reaches the state layer — component-local state only (#121 item 4)", () => {
	const offenders: string[] = [];
	for (const path of portedFiles()) {
		for (const [lineIndex, line] of readFileSync(path, "utf8").split("\n").entries()) {
			if (STATE_LAYER_IMPORT.test(line)) offenders.push(`${path.slice(repositoryRoot.length + 1)}:${lineIndex + 1}`);
		}
	}
	expect(offenders).toEqual([]);
});

// The gate can only gate what its pattern sees. Every spelling of the same forbidden module
// belongs here, and the `@/` alias row is the one PR #152's review found missing.
test("the state-layer matcher catches both spellings — the alias and the relative path (PR #152 review)", () => {
	for (const line of [
		'import { useStore } from "@/store.ts";',
		'import { useThreadStores } from "../../thread-stores.ts";',
		'import type { ZenObservation } from "@zen/core";',
		'import { useChat } from "@tanstack/react-ai";',
		'import { createFollowConnection } from "@/follow-connection.ts";',
	]) {
		expect(STATE_LAYER_IMPORT.test(line)).toBe(true);
	}
	// What presentation legitimately imports, and must keep importing.
	for (const line of [
		'import { cn } from "@/lib/utils.ts";',
		'import { Button } from "@/components/ui/button.tsx";',
		'import { useState } from "react";',
		'import { PromptAttachment } from "./prompt-input.tsx";',
	]) {
		expect(STATE_LAYER_IMPORT.test(line)).toBe(false);
	}
});
