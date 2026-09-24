# Vendored shadcn/ui primitives

**Source:** the [shadcn/ui](https://ui.shadcn.com) registry, `shadcn/ui radix-nova` style —
the `style` field of [`packages/web/components.json`](../../../components.json), with
`baseColor: neutral`, `iconLibrary: lucide`, `rsc: false`, `tsx: true`.
**Fetched by:** `shadcn@4.20.1` (`packages/web/package.json`), in commit `cc84ab4`
("feat(#31): the presentation layer — shadcn theme + vendored ai-elements shells", 2026-09-03);
`chart.tsx` later, by the same CLI and style, for #45's stats drawer — it brought `recharts`
(pinned at the `3.8.0` the CLI chose) and no other dependency. `tabs.tsx` for #361's
Chat | Stats views, by the same CLI and style; it needs nothing `radix-ui` does not already carry.
**License:** MIT (the shadcn/ui project's licence, as published with the CLI).
**Issue:** #31, fenced by `test/presentation-gate.test.ts` since #253.

## Why the receipt is a style and not a commit

`ai-elements` next door is vendored from a git clone, so its receipt is a commit sha and a
drifted file can be diffed against it. The shadcn registry is not commit-addressable: a
component is re-fetched by NAME and STYLE (`bunx shadcn@<version> add button`), and what comes
back is whatever the registry serves for `radix-nova` that day. So the receipt is the pair
that reproduces the fetch — style plus CLI version — and the diff procedure is:

1. `cd packages/web && bunx shadcn@4.20.1 add <component> --overwrite` into a scratch
   worktree (never this one),
2. diff against the file here,
3. re-apply the local changes below,
4. update the CLI version in this README if you fetched with a newer one.

## The local changes, all of them

- **`@/lib/utils` → `@/lib/utils.ts`** in every file that imports `cn`. `components.json`
  declares the alias without the extension; this repo's imports carry it (the bundler and
  `tsconfig` are configured for extension-ful specifiers), so the registry's spelling does not
  resolve here.
- **`collapsible.tsx` keeps its `"use client"` directive.** It is inert under `rsc: false` and
  removing it is churn against the next re-fetch.
- **`dropdown-menu.tsx` spreads `checked` conditionally** in `DropdownMenuCheckboxItem`
  (`{...(checked === undefined ? {} : { checked })}`). The registry writes `checked={checked}`,
  which under this repo's `exactOptionalPropertyTypes` hands `undefined` to a prop typed
  `CheckedState`; the spread is the same behaviour and type-checks.
- **Intra-`ui` imports carry `.tsx`** (`@/components/ui/dialog.tsx`), for the reason `cn`'s does.
- **`cn` comes from `@/lib/utils.ts`, not the `cn` package.** The registry at `shadcn@4.20.1`
  emits `import { cn } from "cn"` and adds that package; this repo has one `cn` and it is ours.

Nothing else. These files are otherwise the registry's output, which is the point: an
unportable primitive is one nobody can re-fetch.

## The rules for files in this directory

1. **Every file carries the provenance header** naming this receipt. `test/presentation-gate.test.ts`
   fails on a file that does not, and on a new subdirectory of `components/` with no receipt
   at all — the three exclusions drawn at `packages/web/src/components` (biome's
   `files.includes`, bunfig's `coveragePathIgnorePatterns`, `.fallowrc.jsonc`'s
   `ignoreFindings`) are not something a directory should inherit in silence.
2. **Presentation only.** Nothing here may import the state layer — our stores, the follow
   connection, `@enso/core`'s wire schemas, TanStack's client. A primitive that reads a
   thread's store cannot be re-fetched, which makes the exclusions above indefensible. The
   same gate enforces it.
3. **This is a standing fork.** Registry updates do not merge themselves; see the procedure
   above.
