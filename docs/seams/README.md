# Seams

One page per contract with one implementation on each side, a fake for tests, and a gate that names
its boundary (#168, under #167 / #162). A seam page is what a reviewer is handed: this contract,
`architecture.md`'s five control-plane invariants, and the question *where does this boundary leak,
and what breaks on a pivot?*

Every page has the same six sections — what the seam is · the contract, verbatim · who implements it
and who consumes it · what fences it · what crosses it that should not · pivot cost — and every
`ts` fence is the source: `test/docs-gate.test.ts` fails when a fence differs from the declaration its
marker names. When it does, `bun scripts/docs/refresh-fences.ts <page>` is the fix and the diff is
the review. Two pages are generated whole (`bun <script> > <page>`) and diffed the same way.

The table of seams — domain, gate, and each page's own statement of what crosses it — lives in
[`architecture.md` → *Seams*](../architecture.md#seams), generated from these pages by
`scripts/docs/seams-table.ts` so it cannot restate a leak a page has closed. A page states its leak;
it does not fix it.
