import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'

/**
 * Presentation stays presentation (#121 item 4, #31).
 *
 * ⚠ Enforcement, not a unit test — the shape of `logging-gate.test.ts` and
 * `vendor-gate.test.ts`. Three lines about `packages/web/src/components/`, the directory in
 * this repo whose files came from somewhere else:
 *
 *   1. **Every vendored subdirectory names its origin.** A receipt per subdirectory — the
 *      pinned upstream commit for `ai-elements`, the registry and style for `ui` — and the
 *      receipt set is held against what is on DISK in both directions, so a new vendored
 *      subdirectory fails until it arrives with one instead of quietly inheriting the
 *      exclusions. A vendored file without provenance is just code nobody dares touch.
 *   2. **Every file names its subdirectory's receipt**, so a port that drifts can be diffed
 *      against the pin and a file that moves between subdirectories cannot keep the wrong one.
 *   3. **Nothing under it holds APPLICATION state.** The distinction that makes the rule
 *      usable: a disclosure's open flag, an IME composing flag, the attachment strip before
 *      submit — component-local `useState`/`useRef` — is what a presentation component IS,
 *      and forbidding it would forbid the components. What may not cross is the *state
 *      layer*: our stores, the follow connection, the wire schemas, TanStack's client. A
 *      component that reads a thread's store is no longer portable, no longer replaceable
 *      by an upstream re-port, and the seam README rule 3 names has moved.
 *
 * So the gate matches imports, not hooks. The ported files import React, the `ui` primitives,
 * `lucide-react`, `radix-ui`, `class-variance-authority`, `use-stick-to-bottom` and each
 * other — nothing else — and the point of the test is that the first import of a store fails
 * the build instead of passing review.
 *
 * ⚠ The scan is the EXCLUSION BOUNDARY, recursively (#253). It read `components/ai-elements`
 * only, non-recursively, while three separate exclusions — `biome.jsonc` → `files.includes`,
 * `bunfig.toml` → `coveragePathIgnorePatterns`, `.fallowrc.jsonc` → `ignoreFindings` — are
 * all drawn at `components`. So the eight `ui/*.tsx` shadcn primitives were unlinted,
 * unmeasured, exempt from dead-code findings, carried no provenance, and were held to no
 * state-layer rule: `import { useStore } from "@/store.ts"` in `ui/card.tsx` passed every
 * gate in the repo, and so did any new file one directory below `ai-elements/`. The fence is
 * now the boundary it justifies, over the one walker (`scripts/source-tree.ts`, #174), whose
 * extension set is a superset of the `\.tsx?$` this used to apply.
 */

const repositoryRoot = join(import.meta.dir, '..')
/** The exclusion boundary the three exclusions are drawn at, and therefore the fence. */
const PORTED_DIRECTORY = 'packages/web/src/components'
/**
 * The receipt each vendored subdirectory's files must name; bump one here when its clone or
 * registry moves (the #31 procedure). `ai-elements` is commit-addressable, so the receipt IS
 * the commit. The shadcn registry is not — components are re-fetched by style, not by sha —
 * so its receipt is the registry and style `packages/web/components.json` names, and
 * `ui/README.md` carries the rest (CLI version, the commit that added them, what diverged).
 */
const PROVENANCE_RECEIPTS: Record<string, string> = {
  'ai-elements': '6a9d5b1822ffb10bba4bd97175f01edd7d8651cd',
  ui: 'shadcn/ui radix-nova',
}

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
const STATE_LAYER_MODULES = 'store|thread-stores|stored-threads|follow-connection|session-stats|custom-event-router'
const STATE_LAYER_IMPORT = new RegExp(
  `from\\s+["'](?:@zen/core(?:/[^"']+)?|@tanstack/[^"']+|(?:(?:\\.\\./)+|@/)(?:${STATE_LAYER_MODULES})\\.ts)["']`,
)

/** Every vendored file, at any depth under the boundary. */
function portedFiles(): string[] {
  return filesUnder(join(repositoryRoot, PORTED_DIRECTORY))
}

/** The vendored subdirectory a file belongs to, or `undefined` for a file sitting at the root. */
function vendoredSubdirectory(path: string): string | undefined {
  const [head, ...rest] = relative(join(repositoryRoot, PORTED_DIRECTORY), path).split(sep)
  return rest.length > 0 ? head : undefined
}

test('⚠ every vendored subdirectory has a receipt, and every receipt a subdirectory (#31, #253)', () => {
  const onDisk = readdirSync(join(repositoryRoot, PORTED_DIRECTORY), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  // Both directions, because each is a different rot: a subdirectory with no receipt is
  // upstream code that inherited three exclusions without saying where it came from, and a
  // receipt with no subdirectory is a pin nobody can check (the `v` shape of #251).
  expect(onDisk).toEqual(Object.keys(PROVENANCE_RECEIPTS).sort())
})

test('⚠ every ported presentation file names its subdirectory’s receipt (#31, #121, #253)', () => {
  const withoutProvenance: string[] = []
  for (const path of portedFiles()) {
    const subdirectory = vendoredSubdirectory(path)
    const receipt = subdirectory === undefined ? undefined : PROVENANCE_RECEIPTS[subdirectory]
    // A file at the root belongs to no receipted port: it is first-party code in an excluded
    // tree, which is the one thing this directory may not hold.
    if (receipt === undefined || !readFileSync(path, 'utf8').includes(receipt))
      withoutProvenance.push(path.slice(repositoryRoot.length + 1))
  }
  expect(withoutProvenance).toEqual([])
})

test('⚠ nothing under components/ reaches the state layer — component-local state only (#121 item 4, #253)', () => {
  const offenders: string[] = []
  for (const path of portedFiles()) {
    for (const [lineIndex, line] of readFileSync(path, 'utf8').split('\n').entries()) {
      if (STATE_LAYER_IMPORT.test(line)) offenders.push(`${path.slice(repositoryRoot.length + 1)}:${lineIndex + 1}`)
    }
  }
  expect(offenders).toEqual([])
})

// The gate can only gate what its pattern sees. Every spelling of the same forbidden module
// belongs here, and the `@/` alias row is the one PR #152's review found missing.
test('the state-layer matcher catches both spellings — the alias and the relative path (PR #152 review)', () => {
  for (const line of [
    'import { useStore } from "@/store.ts";',
    'import { useThreadStores } from "../../thread-stores.ts";',
    'import type { ZenObservation } from "@zen/core";',
    'import { useChat } from "@tanstack/react-ai";',
    'import { createFollowConnection } from "@/follow-connection.ts";',
    // A subpath is the same package: `@zen/core/log-process` is imported elsewhere in the
    // repo, and the bare-specifier branch would have missed it (PR #153 review).
    'import { parseZenLogLine } from "@zen/core/log-process";',
  ]) {
    expect(STATE_LAYER_IMPORT.test(line)).toBe(true)
  }
  // What presentation legitimately imports, and must keep importing.
  for (const line of [
    'import { cn } from "@/lib/utils.ts";',
    'import { Button } from "@/components/ui/button.tsx";',
    'import { useState } from "react";',
    'import { PromptAttachment } from "./prompt-input.tsx";',
  ]) {
    expect(STATE_LAYER_IMPORT.test(line)).toBe(false)
  }
})
