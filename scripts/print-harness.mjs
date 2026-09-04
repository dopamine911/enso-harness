/**
 * The PRINT-MODE harness variant (#20): the zen-harness package minus picc-permission-modes.
 *
 * WHY A VARIANT PACKAGE AND NOT A FLAG
 * picc fails closed when it cannot prompt (`ctx.hasUI` false → every mutating tool denied),
 * which is the correct direction for the package and exactly wrong for `zen -p`: a print
 * run could complete no task requiring `write` or `bash`. There is no escape hatch — mode
 * lives in the session tree, set only via `/mode` interactively (upstream launch-time mode
 * selection is #13, the durable fix). pi offers no per-extension CLI exclusion either: `-e`
 * loads a whole package by its manifest, and passing extension FILES individually silently
 * drops every other resource kind (skills, prompts, themes — see scripts/zen.mjs's header).
 *
 * So print mode loads a GENERATED package: a scratch dir whose manifest is the harness
 * manifest with the picc extension filtered out, and whose resource directories are
 * symlinks into the real package — everything else loads exactly as interactive zen loads
 * it. pi resolves the exact manifest paths through the symlinks; the docs' symlink caveat
 * applies to GLOBS, and this manifest lists resource roots and files directly.
 *
 * ⚠ The shape checks throw a NAMED error rather than degrade: if the harness manifest
 * stops matching (picc renamed, extensions list restructured), a print launch fails loudly
 * instead of silently launching WITH the prompt-denying extension — the failure mode this
 * file exists to prevent.
 *
 * ⚠ What a print run then has: OUR guards only. `bash` is unconfined (#9) — that is the
 * pre-picc posture restored, usability without unattended safety. Stated in #20.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The manifest entry to remove — matching by package name, not exact path. */
const PICC_EXTENSION_FRAGMENT = "picc-permission-modes";

/** The one real file in the variant; everything else is a symlink into the package. */
const MANIFEST_FILENAME = "package.json";

export class PrintHarnessShapeError extends Error {
	constructor(detail) {
		super(
			`print-harness: the harness manifest no longer matches the shape this filter ` +
				`expects (${detail}). Re-derive the print variant (#20) before launching ` +
				`non-interactive runs.`,
		);
		this.name = "PrintHarnessShapeError";
	}
}

/**
 * The harness manifest with picc-permission-modes removed from `pi.extensions`.
 * Everything else — skills, prompts, themes, dependencies — is carried verbatim.
 */
export function buildPrintManifest(manifest) {
	const extensions = manifest?.pi?.extensions;
	if (!Array.isArray(extensions)) {
		throw new PrintHarnessShapeError("pi.extensions is not an array");
	}
	const keptExtensions = extensions.filter(
		(entry) => typeof entry !== "string" || !entry.includes(PICC_EXTENSION_FRAGMENT),
	);
	if (keptExtensions.length === extensions.length) {
		throw new PrintHarnessShapeError(`no extension entry contains "${PICC_EXTENSION_FRAGMENT}" — the filter is stale`);
	}
	if (keptExtensions.length === 0) {
		throw new PrintHarnessShapeError("the filter removed every extension");
	}
	return {
		...manifest,
		name: `${manifest.name}-print`,
		pi: { ...manifest.pi, extensions: keptExtensions },
	};
}

/**
 * Write the variant package to `printHarnessDir`: the filtered manifest plus symlinks to
 * the real package's resource directories. Idempotent and self-healing in BOTH directions
 * — links are recreated every launch (a moved repo heals), and entries the harness no
 * longer has are REMOVED (a renamed or deleted sibling does not leave a dead link that pi
 * would skip in silence). Returns the directory to pass to `-e`.
 */
export function materializePrintHarness(printHarnessDir, harnessPackageRoot, printManifest) {
	mkdirSync(printHarnessDir, { recursive: true });
	// ⚠ EVERY package-root entry is mirrored, not a curated list: extensions import their
	// siblings by relative path (guards reaches `../../core/index.ts`), and pi resolves
	// those against the variant's path — a missing sibling is a launch-time module error.
	// readdir keeps the mirror complete as the package grows.
	const packageEntries = readdirSync(harnessPackageRoot).filter((entry) => entry !== MANIFEST_FILENAME);
	const wantedEntries = new Set([...packageEntries, MANIFEST_FILENAME]);
	for (const stale of readdirSync(printHarnessDir)) {
		if (!wantedEntries.has(stale)) rmSync(join(printHarnessDir, stale), { recursive: true, force: true });
	}
	for (const entry of packageEntries) {
		const linkPath = join(printHarnessDir, entry);
		const targetPath = join(harnessPackageRoot, entry);
		// lstat, not exists: a broken symlink must be replaced, and exists() follows links.
		try {
			lstatSync(linkPath);
			rmSync(linkPath, { recursive: true, force: true });
		} catch {
			// nothing there yet
		}
		symlinkSync(relative(printHarnessDir, targetPath), linkPath, "dir");
	}
	writeFileSync(join(printHarnessDir, MANIFEST_FILENAME), `${JSON.stringify(printManifest, null, "\t")}\n`);
	return printHarnessDir;
}
