import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildPrintManifest,
	materializePrintHarness,
	PrintHarnessShapeError,
} from "../print-harness.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const harnessPackageRoot = join(repoRoot, "packages", "harness");

const exampleManifest = {
	name: "zen-harness",
	pi: {
		extensions: [
			"./extensions/guards/index.ts",
			"node_modules/@ladbabynpm/picc-permission-modes/index.ts",
			"node_modules/pi-multi-account/index.ts",
		],
		skills: ["./skills"],
		prompts: ["./prompts"],
		themes: ["./themes"],
	},
};

test("buildPrintManifest removes exactly the picc extension and keeps everything else", () => {
	const printManifest = buildPrintManifest(exampleManifest);
	expect(printManifest.pi.extensions).toEqual([
		"./extensions/guards/index.ts",
		"node_modules/pi-multi-account/index.ts",
	]);
	expect(printManifest.pi.skills).toEqual(["./skills"]);
	expect(printManifest.pi.prompts).toEqual(["./prompts"]);
	expect(printManifest.pi.themes).toEqual(["./themes"]);
	expect(printManifest.name).toBe("zen-harness-print");
	// The input is not mutated — interactive launches read the same object.
	expect(exampleManifest.pi.extensions).toHaveLength(3);
});

// ⚠ The contract test: run the filter against the REAL harness manifest, so renaming or
// removing picc there turns THIS test red instead of turning a print launch into a loud
// runtime refusal (or worse, a silent no-op filter).
test("the real harness manifest matches the shape the print filter expects", () => {
	const realManifest = JSON.parse(
		readFileSync(join(harnessPackageRoot, "package.json"), "utf8"),
	);
	const printManifest = buildPrintManifest(realManifest);
	expect(printManifest.pi.extensions.join("\n")).not.toContain("picc-permission-modes");
	expect(printManifest.pi.extensions.join("\n")).toContain("guards");
	expect(printManifest.pi.extensions.join("\n")).toContain("pi-multi-account");
});

test("a manifest with no picc entry is a stale filter, not a quiet pass", () => {
	const withoutPicc = {
		name: "x",
		pi: { extensions: ["./extensions/guards/index.ts"] },
	};
	expect(() => buildPrintManifest(withoutPicc)).toThrow(PrintHarnessShapeError);
});

test("a manifest where picc is the only extension refuses rather than launching empty", () => {
	const onlyPicc = {
		name: "x",
		pi: { extensions: ["node_modules/@ladbabynpm/picc-permission-modes/index.ts"] },
	};
	expect(() => buildPrintManifest(onlyPicc)).toThrow(PrintHarnessShapeError);
});

test("materializePrintHarness writes the filtered manifest and symlinks into the real package", () => {
	const printDir = mkdtempSync(join(tmpdir(), "zen-print-harness-test-"));
	try {
		const returned = materializePrintHarness(
			printDir,
			harnessPackageRoot,
			buildPrintManifest(exampleManifest),
		);
		expect(returned).toBe(printDir);
		const written = JSON.parse(readFileSync(join(printDir, "package.json"), "utf8"));
		expect(JSON.stringify(written)).not.toContain("picc-permission-modes");
		// Every package-root sibling is mirrored — `core` is what extensions actually import.
		for (const entry of ["extensions", "core", "skills", "prompts", "themes", "node_modules"]) {
			const target = readlinkSync(join(printDir, entry));
			expect(resolve(printDir, target)).toBe(join(harnessPackageRoot, entry));
		}
		// Idempotent: a second materialize over existing links must not throw.
		materializePrintHarness(printDir, harnessPackageRoot, buildPrintManifest(exampleManifest));
	} finally {
		rmSync(printDir, { recursive: true, force: true });
	}
});
