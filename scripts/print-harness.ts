/**
 * The PRINT-MODE harness variant (#20): the Enso package minus picc-permission-modes.
 *
 * WHY A VARIANT PACKAGE AND NOT A FLAG
 * picc fails closed when it cannot prompt (`ctx.hasUI` false → every mutating tool denied),
 * which is the correct direction for the package and exactly wrong for `enso -p`: a print
 * run could complete no task requiring `write` or `bash`. There is no escape hatch — mode
 * lives in the session tree, set only via `/mode` interactively (upstream launch-time mode
 * selection is #13, the durable fix). pi offers no per-extension CLI exclusion either: `-e`
 * loads a whole package by its manifest, and passing extension FILES individually silently
 * drops every other resource kind (skills, prompts, themes — see scripts/enso.ts's header).
 *
 * So print mode loads a GENERATED package: a scratch dir whose manifest is the harness
 * manifest with the picc extension filtered out, and whose resource directories are
 * symlinks into the real package — everything else loads exactly as interactive enso loads
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
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { relinkDirectory } from './link-vendor-packages.ts'

/** The manifest entry to remove — matching by package name, not exact path. */
const PICC_EXTENSION_FRAGMENT = 'picc-permission-modes'

/** The one real file in the variant; everything else is a symlink into the package. */
const MANIFEST_FILENAME = 'package.json'

/**
 * The harness `package.json` as this filter reads it: the pi manifest block, and everything
 * else carried verbatim. Only `pi.extensions` is examined.
 */
export interface HarnessManifest {
  readonly name?: string
  readonly pi?: {
    readonly extensions?: unknown
    readonly skills?: unknown
    readonly prompts?: unknown
    readonly themes?: unknown
  }
  readonly [key: string]: unknown
}

/** The filtered manifest: `pi.extensions` is a string list by construction. */
export type PrintManifest = HarnessManifest & {
  readonly pi: NonNullable<HarnessManifest['pi']> & { readonly extensions: string[] }
}

export class PrintHarnessShapeError extends Error {
  constructor(detail: string) {
    super(
      `print-harness: the harness manifest no longer matches the shape this filter ` +
        `expects (${detail}). Re-derive the print variant (#20) before launching ` +
        `non-interactive runs.`,
    )
    this.name = 'PrintHarnessShapeError'
  }
}

/**
 * The harness manifest with picc-permission-modes removed from `pi.extensions`.
 * Everything else — skills, prompts, themes, dependencies — is carried verbatim.
 */
export function buildPrintManifest(manifest: HarnessManifest): PrintManifest {
  const extensions = manifest?.pi?.extensions
  if (!Array.isArray(extensions)) {
    throw new PrintHarnessShapeError('pi.extensions is not an array')
  }
  const keptExtensions = extensions.filter(
    (extensionPath) => typeof extensionPath !== 'string' || !extensionPath.includes(PICC_EXTENSION_FRAGMENT),
  )
  if (keptExtensions.length === extensions.length) {
    throw new PrintHarnessShapeError(`no extension entry contains "${PICC_EXTENSION_FRAGMENT}" — the filter is stale`)
  }
  if (keptExtensions.length === 0) {
    throw new PrintHarnessShapeError('the filter removed every extension')
  }
  return {
    ...manifest,
    name: `${manifest.name}-print`,
    pi: { ...manifest.pi, extensions: keptExtensions },
  }
}

/**
 * Write the variant package to `printHarnessDir`: the filtered manifest plus symlinks to
 * the real package's resource directories. Idempotent and self-healing in BOTH directions
 * — links are recreated every launch (a moved repo heals), and entries the harness no
 * longer has are REMOVED (a renamed or deleted sibling does not leave a dead link that pi
 * would skip in silence). Returns the directory to pass to `-e`.
 */
export function materializePrintHarness(
  printHarnessDir: string,
  harnessPackageRoot: string,
  printManifest: PrintManifest,
): string {
  mkdirSync(printHarnessDir, { recursive: true })
  // ⚠ EVERY package-root entry is mirrored, not a curated list: extensions import their
  // siblings by relative path (guards reaches `../../core/index.ts`), and pi resolves
  // those against the variant's path — a missing sibling is a launch-time module error.
  // readdir keeps the mirror complete as the package grows. ⓘ `enso.config.json` (#59) is
  // NOT mirrored and does not need to be: it lives at the REPO root, and web-fetch finds
  // it via `findRepoRoot`, which realpaths out of this mirror before walking (paths.ts) —
  // do not "fix" the mirror to carry it.
  const packageEntries = readdirSync(harnessPackageRoot).filter((packageEntry) => packageEntry !== MANIFEST_FILENAME)
  const wantedEntries = new Set([...packageEntries, MANIFEST_FILENAME])
  for (const stale of readdirSync(printHarnessDir)) {
    if (!wantedEntries.has(stale)) rmSync(join(printHarnessDir, stale), { recursive: true, force: true })
  }
  for (const packageEntry of packageEntries) {
    relinkDirectory(join(printHarnessDir, packageEntry), join(harnessPackageRoot, packageEntry))
  }
  writeFileSync(join(printHarnessDir, MANIFEST_FILENAME), `${JSON.stringify(printManifest, null, '\t')}\n`)
  return printHarnessDir
}
