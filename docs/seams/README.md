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

| Seam | Domain | Second implementation today | Gate | Leak |
|---|---|---|---|---|
| [thread runtime](./thread-runtime.md) | Thread, Control | three fakes | vendor, glossary | L2 (event side) |
| [storage](./storage.md) | Thread, Record | — (one file, pinned) | `no-duplicate-paths` | L2 (entries) |
| [observation](./observation.md) · [kinds](./observation-kinds.md) (generated) | Observation | `observation-kinds.ts` | — | parallel `zen.*` names |
| [dialog](./dialog.md) | Control | extension-UI-context tests | — | L4, decided: keep |
| [permission mode](./permission-mode.md) | Permission | — | vendor allowlist | **L3** |
| [guards](./guards.md) | Permission | injected verdicts; analyzer contract test | — | L5 |
| [tool result](./tool-result.md) | Surface | — | — | — |
| [presentation](./presentation.md) · [ported files](./ported-provenance.md) (generated) | Surface | — | presentation | — |
| [logging](./logging.md) | Record | — | logging | substrate, by decision |
| [web providers](./web-providers.md) | Permission (egress), Control | five providers | vendor allowlist | L6 |

The leak numbers are `.local/refactor/goals.md` §2's; fixing them is #162 workstream 4. A page states
its leak; it does not fix it.
