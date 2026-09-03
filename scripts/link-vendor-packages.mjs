#!/usr/bin/env node
/**
 * Materialize the vendor pi packages inside the harness package's own node_modules.
 *
 * WHY THIS EXISTS
 * pi requires a package to reference bundled pi packages through `node_modules/` paths
 * relative to its own root (docs/packages.md § Dependencies), and a published tarball
 * built from `bundledDependencies` has exactly that layout. npm workspaces do not:
 * they hoist workspace dependencies to the repo root, so `packages/harness/node_modules`
 * comes back empty and every `node_modules/...` entry in our manifest fails to resolve.
 *
 * ⚠ `install-strategy=nested` does NOT fix this — tested 2026-09-03; workspace
 * dependencies are hoisted regardless of install strategy. Do not reach for it again.
 *
 * So this script links the hoisted copies into place, making the local tree match the
 * layout a consumer installing from npm would get. It runs from the root `postinstall`,
 * so a clean clone plus `npm install` is enough — nothing here is manual.
 *
 * Symlinks, not copies: `pi update` and `npm install` stay authoritative over the real
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

const linked = [];
for (const packageName of requiredPackageNames()) {
	const hoisted = join(repoRoot, "node_modules", packageName);
	if (!existsSync(hoisted)) {
		console.error(`link-vendor-packages: ${packageName} is not installed at the repo root — run npm install`);
		process.exit(1);
	}
	const target = join(packageRoot, "node_modules", packageName);
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

console.error(`link-vendor-packages: linked ${linked.length} package(s): ${linked.join(", ") || "none"}`);
