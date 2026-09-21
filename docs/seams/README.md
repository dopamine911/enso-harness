# Seams

One page per contract with one implementation on each side, a fake for tests, and a gate that names
its boundary (#168, under #167 / #162). A seam page is what a reviewer is handed: this contract,
`architecture.md`'s five control-plane invariants, and the question *where does this boundary leak,
and what breaks on a pivot?*

Every page has the same six sections — what the seam is · the contract, verbatim · who implements it
and who consumes it · what fences it · what crosses it that should not · pivot cost — and every
`ts` fence is the source: `test/docs-gate.test.ts` fails when a fence differs from the declaration its
marker names. When it does, `bun scripts/docs/refresh-fences.ts <page>` is the fix and the diff is
the review. One page is generated whole (`ported-provenance.md`, `bun <script> > <page>`) and diffed
the same way.

The table of seams — domain, gate, and each page's own statement of what crosses it — lives in
[`architecture.md` → *Seams*](../architecture.md#seams), generated from these pages by
`scripts/docs/seams-table.ts` so it cannot restate a leak a page has closed. A page states its leak;
it does not fix it.

## Leak numbers

`L1`–`L6` number the six places a vendor's name or shape crossed the loop's boundary, and the seam
pages, `architecture.md` and the glossary use the numbers as identifiers ("since L2", "leak L5").
The numbering started in a working note that is not in the repository; this is the committed
definition. Every row's *stated in* column is where the claim is made and checked in this checkout,
so a row can be verified rather than taken on the number's word.

| # | What crossed | Where it is now | Stated in |
|---|---|---|---|
| **L1** | the vendor's `Pi*` prefix on shapes of ours — `PiSession`, `PiPromptRequest`, `PiRpcEvent`, the module `pi-rpc.ts` | renamed: `ThreadRuntime`, `PromptRequest`, `RuntimeCommand` in [`thread-runtime.ts`](../../packages/core/src/thread-runtime.ts), and `PiRpcEvent` → `RuntimeEvent`, which L2 then moved below the seam to [`host/runtime-event.ts`](../../packages/web/src/host/runtime-event.ts) | [`glossary.md` → *Retired*](../glossary.md#retired), applied to the source tree by [`test/glossary-gate.test.ts`](../../test/glossary-gate.test.ts) |
| **L2** | the runtime's event and stored-entry shapes, read above the host | below the seam: the event is read only under `packages/web/src/host/` (`runtime-event.ts`, `map-events.ts`, `transcript.ts`), and a thread's branch is a transcript of ours ([`packages/core/src/transcript.ts`](../../packages/core/src/transcript.ts)) | the leak sections of [`thread-runtime.md`](./thread-runtime.md#what-crosses-it-that-should-not) (event side) and [`storage.md`](./storage.md#what-crosses-it-that-should-not) (persistence side) |
| **L3** | the permission mode, read three layers away from the runtime | the wire shape is ours ([`packages/core/src/permission-mode.ts`](../../packages/core/src/permission-mode.ts)); the vendor's persisted mode is read below the seam (`packages/web/src/host/permission-mode-adapter.ts`) | [`permission-mode.md`](./permission-mode.md#what-crosses-it-that-should-not) — its leak section reads *Nothing.*, its pivot section states the three-step fix |
| **L4** | the four dialog kinds are the runtime's extension-UI method names | kept, by decision — the kinds are the vocabulary ([`glossary.md` → *dialog kind*](../glossary.md#control)) | [`dialog.md`](./dialog.md#what-crosses-it-that-should-not) |
| **L5** | the guard's tool names are the runtime's, and the guard is the runtime's own extension hook | open, by decision, and stated wherever it shows: the guards page, the guarded-tool-call flow, and the composition roots on the web-providers page | [`guards.md`](./guards.md#what-crosses-it-that-should-not), [`flows/guarded-tool-call.md`](../flows/guarded-tool-call.md), [`web-providers.md`](./web-providers.md#what-crosses-it-that-should-not) |
| **L6** | first-party code outside the vendor roots naming the vendor's model and credential types — the search provider vocabulary and auth | the provider contract names its own model and credential types; the vendor gate's import allowlist is empty (`VENDOR_IMPORT_ALLOWED` = 0) | [`web-providers.md`](./web-providers.md#what-crosses-it-that-should-not), [*Ratchets*](../reference/verification-inventory.md#ratchets) |

L1, L2, L3 and L6 are fixed; L4 and L5 are decided and stay, which is why the seams table still
reads `L5` for the guards. A row's claim is the page's, not this table's: the page is where a
reopened leak is stated first.
