# Durable — making room, not building to it

**Written** 2026-10-01 by Claude (Sonnet 5.5) at Daniel's request, for the Enso project.

A decision record and a pivot account. The decision: Enso will not write contracts shaped like pi
Durable's, and it will keep a move to Durable cheap enough to make later, on evidence. This page says
what that costs today, what keeps it cheap, and the ways a move could be done.

Evidence is the source of pi 1.0.0 (`earendil-works/pi`, release commit `a13d35a74`, read from a local
checkout) and this repository at `c53bb39`. Where a claim rests on reasoning, not on a file read, it
says **[inference]**. Nothing here was run: no Durable code was executed, and nothing was built against it.

**Decided 2026-10-12** (Daniel, #767 → #860): build toward Durable now, as **way B** below — a Durable
thread kind beside pi, opt-in behind `ENSO_EXPERIMENTAL_DURABLE`, implemented under the existing seams as
rule 7 asks, with Durable's imports in one gated directory and an exact pin. The rules under *What keeps
the move cheap* stand; *Why not now* is the epic's work list rather than a reason to wait. The #767 spike
ran Durable 1.1.0 (a guard through `beforeTool`, OAuth through pi-coding-agent's `ModelRuntime`, resume
after SIGKILL) and found two hazards Durable leaves to its host, #863: a tool's process outlives a killed
host, and a second opener of one store runs live work twice.

---

## What Durable is

`@earendil-works/pi-durable` 1.0.0, shipped 2026-10-01 with pi 1.0. Its README opens with
"Experimental. The API changes without notice between releases."

A harness over a storage backend (memory, SQLite, JSONL). Conversations are transcripts of immutable
entries. Every model request and every tool call is a task that checkpoints before it moves on, so a
restarted process continues from the last checkpoint. State beyond the transcript lives in typed
documents committed atomically with it. A fork shares its parent's history without copying it. An
extension is a bundle of tools, system-prompt sections, hooks, wraps and tasks, installed in a registry
the host process owns.

It is **not** the pi coding agent's new core. pi 1.0's `coding-agent` is still `AgentSession` plus
`ExtensionAPI`. `packages/coding-agent/src/experimental/` (about 10k lines: the durable demo, the
vacation planner, and the server, worker, coordinator and client TUI) is built on Durable, and a search
of it for `core/extensions`, `ExtensionAPI`, `discoverAndLoadExtensions` and `AgentSession` finds
nothing. It is gated behind `PI_EXPERIMENTAL=1` and source-only. So the two have separate extension
models with no bridge between them, and the new surface work (remote clients, multiple steerers) is on
Durable's side. That last clause is **[inference]** from where the code is; no document states the
direction.

## Why it fits

| What Enso needs | What it does today | In Durable |
|---|---|---|
| A torn thread continues from exactly its stored state (#436) | `host/continuation.ts` restates `agent.continue()`'s rules and writes one synthetic `isError` result per open call | per-tool `replay: "safe"`; otherwise the model gets an `interrupted` result with the output so far; checkpoints at every step |
| Run provenance that a fork inherits | `active_agent`, `enso-run-context`, `enso-guard-denial`, `enso-incident-*`, `enso-system-prompt` as custom entries in pi's JSONL | documents with `fork: "asOf"`, committed atomically with the transcript |
| Subagent transcripts in one place (open question 3 in `architecture.md`) | separate files, collected at two levels | a subagent is a conversation in the same store, owned by the call that made it |
| An unattended render target (open question 2) | not built | headless by design |
| A live view for the web follow | `follow.ts` and `map-events.ts` over pi events | `viewState()` / `watch()`; `watchEvents()` for coding-agent-style events |
| Context view and edit (the Context pane) | projections over `SessionEntry` | `ContextEdit` omit and replace, plus `head` |
| Snapshots and worktrees (#146, #147) | open | forks and rewindable documents cover #146's shape; #147 is not covered |

## Why not now

1. **The TUI.** `bun run enso` spawns real `pi` (`scripts/enso.ts`) and the terminal page says "You use
   pi's own interface, keys and commands." Durable has no TUI of its own. The experimental one is a
   655-line demo that borrows pi's components; it has no `/login`, no skills UI, no `/tree`, no
   extensions. The end state asks the TUI to reach parity with pi, Claude Code and omp. So a move means
   building and owning a terminal surface, or running two runtimes that cannot share a store.
2. **Tools and resources.** Durable's `CodingTools` are `read`, `write`, `edit`, `bash`; its README says
   reading images is not supported. No `grep`, `find`, `ls`, `powershell`. No MCP or codemode. Provider
   login and OAuth stay in coding-agent's `ModelRuntime`, which the experimental app imports as a
   library.
3. **No dialog primitive.** A grep of Durable's README for UI and dialog terms finds none. `ask_user`,
   the questionnaire card and `extension-ui-context.ts` (585 lines) have nothing to map to. It would be
   built from `memo`, a document and a route.
4. **Re-execution and concurrency.** A Durable hook can run again after a crash and must be idempotent
   (`memo`: the first write wins). Tool rounds run in parallel by default (`toolExecution: "parallel"`;
   `"sequential"` exists). `harness/core/session-security.ts` states that pi prepares a batch's calls one
   at a time, and the guard depends on it.
5. **Maturity and the freeze.** Released the day this was written and experimental; the source shows no
   third-party user of it. A runtime swap is the opposite of the feature freeze.

## What a pivot touches today

The repository already states a pivot cost per seam, and those sections are the source for this table:
[`thread-runtime.md`](../seams/thread-runtime.md#pivot-cost), [`storage.md`](../seams/storage.md#pivot-cost),
[`guards.md`](../seams/guards.md#pivot-cost) and [`permission-mode.md`](../seams/permission-mode.md#pivot-cost).
The vendor gate allows `@earendil-works/*` in two roots only, `packages/web/src/host` and
`packages/harness/extensions` — 27 non-test files, about 9k lines (whole files, 17 in `host/` and 10 in `extensions/`), counted on 2026-10-01 — and
`.fallowrc.jsonc` checks the same rule on the import graph. `packages/core` imports nothing from the
vendor. Everything above the host runs against fakes.

A generic runtime swap is the cost those pages state. A move to **Durable** has four more, which they do
not:

1. **The custom-entry envelope was read in `core`** (closed by #557). The folds
   `recordedPermissionMode`, `sessionIncidentsOf`, `incidentEntriesOf` and `riskEventsOfEntries` took
   `readonly unknown[]` and matched pi's `{ type: 'custom', customType, data }` shape. L2 closed the
   transcript side (`core/src/transcript.ts` is ours), but these folds still read the runtime's
   envelope. A Durable store has `{ kind, data }` entries and documents. The fold *logic* ports; the
   envelope does not. Now the folds take `EnsoTranscriptEntry[]` and the envelope is read in
   `core/src/runtime-entries.ts` alone (rule 4 below says why there).
2. **All eleven declared extensions load through pi's manifest.** `packages/harness/package.json`
   `pi.extensions` lists them, including two third-party ones (`@gotgenes/pi-permission-system`,
   `pi-multi-account`). Durable installs extensions in a registry, and the permission engine talks over
   pi's event bus. Each of the nine first-party extensions is `(pi: ExtensionAPI) => void`.
3. **Guard state is closures.** The files-read set, stale-write stamps and session risk live in a
   session-scoped closure — since #861 a runtime-free guard session in `harness/core`
   (`guard-session.ts`), which any runtime's hooks call through a port; the pi extension is glue.
4. **The terminal is a spawn of pi**, not a surface Enso owns.

## What keeps the move cheap

Rules for new work. None needs a new abstraction, and none is Durable-shaped; each is correct on pi today.

1. **Policy goes in `core` or `harness/core` as pure functions over our own records. The extension is
   glue.** The repository already does this (`harness/core/` takes strings, paths and a cwd; `decide`
   returns a `GuardDenial` and the handler converts it). Keep that direction.
2. **New session-scoped state is derived from records, not held in a closure.** It then survives a
   restart, a fork and a different runtime alike.
3. **A gate is pure, idempotent and independent of the order calls arrive in.** pi does not need it. A
   hook that reruns after a crash, or runs beside its sibling, does.
4. **Hand folds our record type, not `unknown[]`.** The host decodes the runtime's entries into
   `{ kind, data }` of ours before the folds run, the way it already decodes the transcript. This is the
   one concrete change the account above calls for; it removes the envelope from the folds (item 1).
   **Done in #557.** Every fold takes `EnsoTranscriptEntry[]`. The decoder is ONE module,
   `core/src/runtime-entries.ts` (`transcriptOf`) — in `core`, not the host, because three zones
   need it and `core` is the only one all three reach: the host (which adds the vendor-typed
   refusal and descriptor on top), the extensions on `ctx.sessionManager.getBranch()`, and the
   corpus scripts over the omp corpus. So the envelope is named in one swappable file in `core`
   rather than in no file in `core`; a move replaces that file and the folds do not move.
5. **Key new features to our ids and our records.** #146 as written keys a snapshot to "pi's session
   entry id". Key it to an Enso thread and entry id held in an Enso record, so `/tree` is not the
   mechanism. Same for #147.
6. **No new importer of the runtime outside the two roots, and a baseline that only shrinks inside
   them.** The vendor gate holds both halves. Outside the roots, `VENDOR_IMPORT_ALLOWED`; inside
   them, `VENDOR_IMPORTERS_ALLOWED_INSIDE_ROOTS` (#558), the files under `host/` and `extensions/` that may
   import the vendor. A new importer fails by name, and a file that stops importing leaves the list in
   the same PR, so the pivot cost can no longer grow without a gate noticing.
7. **Do not add a port that copies Durable's contracts.** Designing against a runtime that changes
   without notice, from one implementation, gets the shape wrong in both directions. The seams exist;
   use them.

## Ways to do it

Each is a way, not a plan. None is chosen.

**A. Swap behind the seams.** A `ThreadRuntime` over a Durable `Harness`; the storage seam over its
SQLite or JSONL store; `session-events` and `map-events` fed from `watchEvents()`; the nine extensions
re-expressed as Durable extensions; the continuation logic deleted in favour of replay. The server,
routes, browser and every fake-driven test stay. This is the cost in *What a pivot touches today*,
plus the four extras, plus whatever the terminal decision is. It is the largest and only one-way move.

**B. Side by side, new surfaces first.** pi stays the interactive runtime. Durable runs the surface pi
cannot serve well: unattended and factory runs (open question 2), where there is no TUI to lose. Both
runtimes share what is already runtime-free: `core` folds, `harness/core` matchers, the wire schemas.
The cost is two stored-thread readers behind `live-or-stored`. The first half of A (a Durable
`ThreadRuntime`) is built under B, so B does not close A off. Of the four, this is the one that earns
evidence at the least risk **[inference]**.

**C. pi as a library under Durable.** What the experimental app already does: Durable's harness, pi's
`ModelRuntime`, auth, settings, system prompt and TUI components. It keeps the login and credential
flow shared with `bun run enso` and keeps pi in the dependency tree. Compatible with A or B.

**D. Durable's own transport.** `pi-server`, `pi-client` and `pi-protocol` (CBOR frames over a Unix
socket, Chord facets) route clients to Durable sessions. Enso's server already has the shape these
solve: one process owns the state, clients attach. Not adopting this is the default; it would matter
only if Enso wanted pi's own remote clients to attach to Enso sessions. No evidence yet that it does.

**Stored threads, for any of them.** No importer from pi session files into Durable storage exists. I
searched `durable/src`, `durable/docs` and `experimental/` and found none **[inference: absence of a
search hit]**. Two ways: replay-import a pi branch into Durable entries (one-way, lossy at the
envelope), or leave old threads readable through the cold path that already exists
(`readStoredThread` → our transcript). The second needs no import and no new code. It is the one I
would take.

## How to find out

A spike, in a worktree, thrown away after the answer is written down. Pass criteria, written first:

1. Kill the process mid-`bash`, reopen, and see the model get the interrupted result. The result
   replaces `host/continuation.ts`.
2. `secret-read` and `read-before-write` as `beforeTool` hooks with state in a document, run once
   sequentially and once in parallel, with the same verdicts.
3. A fork keeps a run-context document as of its fork point.
4. `ask_user` as a document plus a route, answered from the web.
5. `viewState()` driving the existing follow through `watchEvents()` into `map-events`.
6. The effort to put a terminal on it, measured against the 655-line demo.

If 1 to 5 pass and 6 is acceptable, A or B is justified. If 4 or 6 do not, B is the whole of it.

## Revisit when

- the server and client path no longer needs `PI_EXPERIMENTAL`;
- an `ExtensionAPI` bridge exists, or the coding agent itself runs on Durable;
- Durable has `grep`, `find`, `ls`, `powershell` and image reads, and a session import;
- a second external adopter has run it for longer than a release.

## Not verified

- How many threads a single `Harness` carries, and whether the web host wants one store per project, per
  thread or one overall. The experimental app uses one SQLite per session with a lock.
- Durable's JSONL storage format, and whether it is greppable the way pi's session log is.
- How a third-party pi extension would be re-hosted, if it can be at all.
- Real cost. The "about 9k lines" is a count of the files that name the vendor, not an estimate of
  work, and the four extras are unsized.
