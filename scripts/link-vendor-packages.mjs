#!/usr/bin/env bun
/**
 * Ensure the vendor pi packages exist inside the harness package's own node_modules.
 *
 * WHY THIS EXISTS
 * pi requires a package to reference bundled pi packages through `node_modules/` paths
 * relative to its own root (docs/packages.md § Dependencies), and a published tarball
 * built from `bundledDependencies` has exactly that layout.
 *
 * ⚠ WHAT THE INSTALLER PROVIDES CHANGED WITH #30, so this script is verify-or-fix:
 *
 *   bun (current)  bun's isolated linker puts a symlink for every workspace dependency in
 *                  the workspace's OWN node_modules (→ the `.bun` store), so the layout pi
 *                  needs exists NATIVELY after `bun install` and the loop below verifies
 *                  it and links nothing.
 *   npm (history)  npm hoisted workspace dependencies to the repo root and left
 *                  `packages/harness/node_modules` empty — the fallback branch below (link
 *                  the hoisted copy into place) was the script's whole job then, and it is
 *                  KEPT because a bunfig `linker = "hoisted"` (or a future bun default
 *                  flip) reproduces the npm shape. npm's `install-strategy=nested` did NOT
 *                  avoid the need — tested 2026-09-03; hoisting ignored the strategy.
 *
 * It runs from the root `postinstall` (wired for real with #30 — the claim predated the
 * wiring), so a clean clone plus `bun install` is enough — nothing here is manual. The
 * server's own `assertVendorLinks` re-checks the effective layout at startup either way.
 *
 * Symlinks, not copies: `pi update` and `bun install` stay authoritative over the real
 * package, and there is no second copy to go stale.
 */
import { readFileSync, mkdirSync, symlinkSync, rmSync, existsSync, lstatSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR_PATH_PREFIX = "node_modules/";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "harness");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

/**
 * Every package that must exist inside the harness package's own node_modules.
 *
 * Two sources, and both are needed:
 *
 *  1. Manifest resource paths beginning `node_modules/` — pi reads those as literal paths
 *     relative to the package root, so a missing one is a silently skipped resource.
 *  2. EVERY entry in `dependencies` — because pi loads packages with separate module roots,
 *     so a bare `import "@zen/core"` from an extension is not guaranteed to resolve by
 *     walking up to the repo root the way plain Node would. ⚠ This is the case that made
 *     the list insufficient: `@zen/core` appears nowhere in the manifest paths, only as an
 *     import in the source, so a manifest-only sweep left it unlinked and the extension
 *     failed at load rather than at typecheck.
 */
function requiredPackageNames() {
	const names = new Set(Object.keys(manifest.dependencies ?? {}));
	for (const paths of Object.values(manifest.pi ?? {})) {
		for (const entry of Array.isArray(paths) ? paths : [paths]) {
			if (typeof entry !== "string" || !entry.startsWith(VENDOR_PATH_PREFIX)) continue;
			const withoutPrefix = entry.slice(VENDOR_PATH_PREFIX.length);
			const segments = withoutPrefix.split("/");
			// Scoped packages carry their scope in the first segment.
			names.add(segments[0].startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0]);
		}
	}
	return [...names];
}

const verified = [];
const linked = [];
for (const packageName of requiredPackageNames()) {
	const target = join(packageRoot, "node_modules", packageName);
	// existsSync FOLLOWS symlinks, so a bun-made link into the `.bun` store passes here
	// while a broken link falls through to the fix branch below.
	if (existsSync(target)) {
		verified.push(packageName);
		continue;
	}
	const hoisted = join(repoRoot, "node_modules", packageName);
	if (!existsSync(hoisted)) {
		console.error(
			`link-vendor-packages: ${packageName} is at neither ${target} nor the repo root — run bun install`,
		);
		process.exit(1);
	}
	mkdirSync(dirname(target), { recursive: true });
	// lstat, not exists: a broken symlink must be replaced, and exists() follows links.
	try {
		lstatSync(target);
		rmSync(target, { recursive: true, force: true });
	} catch {
		// nothing there yet
	}
	symlinkSync(relative(dirname(target), hoisted), target, "dir");
	linked.push(packageName);
}

console.error(
	`link-vendor-packages: ${verified.length} already in place (${verified.join(", ") || "none"}); ` +
		`linked ${linked.length} (${linked.join(", ") || "none"})`,
);
