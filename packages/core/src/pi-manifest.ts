import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * What a pi package's manifest declares, and where pi will look for it (#221) — THE one
 * place that knows pi's manifest-resource layout.
 *
 * TWO pi ASSUMPTIONS LIVE HERE, AND NOWHERE ELSE:
 *
 *  1. a `pi.*` value is a resource path or an array of them (`docs/packages.md` §
 *     Dependencies), so reading them means flattening one level;
 *  2. a resource path beginning `node_modules/` is a LITERAL path relative to the package
 *     root — not a specifier pi resolves — so the file must be there on disk. Our harness
 *     manifest depends on that at the file level: it names
 *     `node_modules/@ladbabynpm/picc-permission-modes/index.ts` and
 *     `node_modules/pi-multi-account/index.ts`, source paths inside vendor packages rather
 *     than export-map entries.
 *
 * ⚠ pi does NOT error on a manifest resource path that does not exist — it skips it
 * SILENTLY (verified 2026-09-03: the vendor extension did not load and nothing was
 * reported). That is why `missingVendorPaths` exists at all, and why both launch points
 * refuse on a non-empty result instead of starting.
 *
 * ⚠ ONE COPY. Before #221 the flatten-and-filter existed three times — `scripts/zen.ts`'s
 * launcher decisions, `scripts/link-vendor-packages.ts`, and the server's
 * `assertVendorLinks` — with the prefix spelled as a constant in two of them and as a bare
 * literal in the third, which is why the `no-duplicate-shapes` gate never named them. The
 * cost of three was that a change in how pi resolves resources would have to land in three
 * files in two languages, and the one that was missed becomes the silent path — the exact
 * failure `packages/web/src/server/index.ts` records having already cost a debugging detour.
 *
 * ⚠ `node:` — a subpath (`@zen/core/pi-manifest`), never the barrel (#211).
 */

/** The prefix that makes a declared resource path a vendor path: assumption 2 above. */
const VENDOR_PATH_PREFIX = 'node_modules/'

/** `resourceDeclarations`' refusal, so its three refused shapes read as three lines. */
function malformedTable(shape: string): Error {
  return new Error(
    `pi-manifest: a \`pi\` that is not an object cannot declare resource paths (got ${shape}) — ` +
      `refusing rather than skipping the vendor-path precondition`,
  )
}

/**
 * One entry per resource kind the manifest's `pi` table declares — the values, unread.
 *
 * ⚠ `unknown` IN, NARROWED HERE. A manifest is a parsed JSON file: every caller gets it
 * from `JSON.parse`, so a declared parameter type would be a cast at each of them — three
 * casts asserting the same unverified shape, which is the duplication this module exists
 * to end.
 *
 * ⚠ ABSENT IS LEGAL, MALFORMED IS A REFUSAL (#226). No `pi` at all means a package that
 * declares no resources, which is a real thing. A `pi` that is PRESENT and is not an
 * object is a broken manifest, and returning "nothing declared" for it reproduces the very
 * failure `missingVendorPaths` exists to prevent: measured on a `pi` spelled as a bare
 * string, `Object.values` walks it CHARACTER BY CHARACTER, no character starts
 * `node_modules/`, the check comes back empty and the server boots with its vendor
 * precondition silently unenforced. So it throws, naming the shape it got. A non-string
 * value INSIDE the table is different and is skipped, not fatal: that is a resource kind
 * we do not model yet, and it is `zen-launch.ts`'s long-standing behaviour.
 */
function resourceDeclarations(manifest: unknown): unknown[] {
  // `in` narrows the object type itself, so `manifest.pi` reads as `unknown` with no cast
  // (TS 4.9+). Casting to `Record<string, unknown>` would be the same check written twice,
  // and a cast is exactly what this function exists to remove from its callers (PR #314 review).
  if (typeof manifest !== 'object' || manifest === null || !('pi' in manifest)) return []
  const table = manifest.pi
  if (table === undefined) return []
  if (Array.isArray(table)) throw malformedTable('an array')
  if (table === null) throw malformedTable('null')
  if (typeof table !== 'object') throw malformedTable(`a ${typeof table}`)
  return Object.values(table)
}

/**
 * Every resource path the manifest declares under `pi.*`, flattened, in declaration order.
 *
 * A non-string entry is not a resource path and is dropped rather than coerced — a hand-edited
 * manifest should not turn into a check against `"42"`.
 */
export function declaredResources(manifest: unknown): string[] {
  const resources: string[] = []
  for (const declared of resourceDeclarations(manifest)) {
    for (const resourcePath of Array.isArray(declared) ? declared : [declared]) {
      if (typeof resourcePath === 'string') resources.push(resourcePath)
    }
  }
  return resources
}

/** The declared resources pi will read as literal vendor paths — assumption 2's subset. */
function vendorResourcePaths(manifest: unknown): string[] {
  return declaredResources(manifest).filter((resourcePath) => resourcePath.startsWith(VENDOR_PATH_PREFIX))
}

/**
 * The declared `node_modules/…` paths that are not under `packageRoot`.
 *
 * Only the vendor paths are checked: a repo-local resource (`./extensions/…`) is the
 * package's own and is there or the package is broken, whereas the vendor ones are
 * materialized by the installer and npm workspaces used to hoist them away.
 */
export function missingVendorPaths(manifest: unknown, packageRoot: string): string[] {
  return vendorResourcePaths(manifest).filter((resourcePath) => !existsSync(resolve(packageRoot, resourcePath)))
}

/**
 * The package names those vendor paths reach into, deduplicated.
 *
 * ⚠ A scoped package carries its scope in the FIRST TWO segments (`@scope/name`), so the
 * name is not simply the first one — `node_modules/@ladbabynpm/picc-permission-modes/index.ts`
 * names `@ladbabynpm/picc-permission-modes`, not `@ladbabynpm`.
 */
export function vendorPackageNames(manifest: unknown): string[] {
  const names = new Set<string>()
  for (const resourcePath of vendorResourcePaths(manifest)) {
    const [scopeOrName, scopedName] = resourcePath.slice(VENDOR_PATH_PREFIX.length).split('/')
    if (scopeOrName === undefined || scopeOrName.length === 0) continue
    if (!scopeOrName.startsWith('@')) {
      names.add(scopeOrName)
      continue
    }
    // ⚠ A scope with nothing after it names NO package (PR #314 review): `node_modules/@scope`
    // would otherwise be handed to the linker as a package called `@scope`, which cannot
    // resolve — a malformed declaration reported as a missing dependency instead of as itself.
    if (scopedName !== undefined && scopedName.length > 0) names.add(`${scopeOrName}/${scopedName}`)
  }
  return [...names]
}
