# Verification

How zen-harness proves a change and holds the boundaries the refactor depends on (#170). The generated
[verification inventory](./reference/verification-inventory.md) is the factual table: every gate,
ratchet and reusable test double, its current count, source and stated limitation. This page explains
how to use it. It does not repeat the inventory.

## One definition of green

`bun run check` (the same script as `check:all`) runs `scripts/gate.ts`. Five gates, in order, stopping
at the first failure:

1. **Biome** — formatting, lint, import organisation and the repository naming plugin, check-only.
2. **TypeScript** — `tsc -b`, a project-reference build. It emits: project references require
   `composite`, `composite` requires declaration output, and `tsc -b --noEmit` is refused with
   TS6310, so the declarations land in each package's gitignored `dist-types/`.
3. **Dead code** — `fallow dead-code --baseline fallow-baseline.json` (#163): fails on any unused file,
   export, type or dependency that is *not* in the committed identity baseline. The baseline is the
   backlog as inventory; growth is the regression. `.fallowrc.jsonc` names every program fallow cannot
   see a loader for (the harness extensions, the Bun plugin, the direct-run scripts), and
   `test/fallow-config.test.ts` holds its extension entries equal to the harness manifest.
4. **Bun test** — the complete test tree, with text and LCOV coverage reporters.
5. **Aggregate coverage** — `scripts/check-coverage.ts` reads LCOV and enforces the total line and
   function floors. The current values are generated under *Ratchets* in the inventory.

The local pre-commit hook (`.githooks/pre-commit`) and the blocking CI job
(`.github/workflows/ci.yml`) call that same script. The hook runs it over the snapshot being
committed, not over the working tree: the unstaged remainder is stashed for the duration and
restored afterwards, so a partial commit (`git add -p`) is gated on what CI will see (#259). The
two exceptions are `git commit -a` and `git commit -- <path>`, where git hands the hook a
temporary index; there it gates the working tree and says so on the first line of its output.
CI adds independent jobs or advisory steps — secret
scan, automated review, React Doctor, `fallow audit` over the changed files — but none replaces the
five-step gate. A green editor or a
single test is not repository green.

`test/coverage-manifest.test.ts` closes Bun's denominator hole: Bun reports coverage only for files a
test imported, so an untested module could otherwise disappear rather than count as zero. The test
imports every owned library source file except named program entry points and vendored presentation
code. Adding a source file adds it to the denominator automatically.

## Gates enforce boundaries, not examples

A gate is a test over the source tree: rule + searched roots + named exceptions. The generated
[*Enforcement gates*](./reference/verification-inventory.md#enforcement-gates) table is the index;
each gate's header is the authority for why the rule exists and what it cannot catch.

Three conventions make those tests useful:

- **Offenders are named, never counted.** A failure points to a path (and normally a line); a count can
  go down for the wrong reason and cannot say what to fix.
- **An allowlist is inventory.** Every entry names why the site is not a regression and when it leaves.
  Fixing a leak deletes a line. Adding an entry is review, not maintenance.
- **A gate is shown red.** During the PR that creates or widens it, plant one representative offender,
  run the focused test, record the named failure, remove it, run green. A gate never observed failing
  is a claim, not protection.

The important boundary gates for consolidation:

- `vendor-gate.test.ts` — vendor imports and extension names stay under the host and extension roots;
- `glossary-gate.test.ts` — retired names and vendor-prefixed first-party shapes do not return;
- `docs-gate.test.ts` — sourced fences equal declarations and generated pages equal their generator;
- `presentation-gate.test.ts` — ported files name their provenance and import no application state;
- `logging-gate.test.ts` — records use `zenLogger`; the logging substrate stays behind it;
- `no-duplicate-paths.test.ts` / `no-duplicate-shapes.test.ts` — roots and schemas have one home.

Read the generated table before editing a gate: its limitation column is the edge the gate does not
cover. Do not strengthen prose and leave the matcher behind it.

## Ratchets move one way

A ratchet pins a measured boundary. The generated [*Ratchets*](./reference/verification-inventory.md#ratchets)
table reads the numbers from source — aggregate coverage floors, global and per-file complexity
ceilings, allowlist and exception counts.

- A coverage floor may rise after the full suite proves the new number; it does not fall to land a PR.
- A per-file complexity pin may fall after the named function shrinks; it does not rise to admit a
  rewrite. `biome.jsonc` carries the reason beside each exception.
- An allowlist may shrink as leaks close. Growth needs a boundary decision with a removal condition.

Counts describe reviewed surface, not quality. Four allowlist rows are not four bugs, and 90% coverage
is not 90% correctness.

## Test doubles are the second implementation

A seam with one production implementation is not proven by an interface. Its test double is the
second implementation that proves callers depend on the contract rather than the vendor. The
generated [*Test doubles*](./reference/verification-inventory.md#test-doubles) table names the reusable
ones, the seam each replaces and every consumer test.

Use the narrowest real surface:

- **Thread runtime / host** — the one `ThreadRuntime` fake (`createFakeHostedThread`) and the one
  `AgentHost` fake (`createFakeAgentHost`), both in
  `packages/web/src/server/__tests__/fake-hosted-thread.ts`, drive the real registry, follow handlers
  and HTTP dispatcher; see [the thread-runtime seam](./seams/thread-runtime.md).
- **Browser transport** — `createScriptedFetch` drives the real prompt/follow adapter with a streamed
  body and controlled routes; it is not a mock echo.
- **Follow HTTP** — `openFollow` reads the real SSE endpoint and records frames.
- **Logging** — the single `recordZenLogs` (`packages/core/src/__tests__/log-recorder.ts`, one for
  every package) replaces the sink while calls still go through `zenLogger` and its structured
  properties.
- **DOM** — the shared environment owns process-wide browser globals for mounted component tests.

Do not add a per-file runtime fake. Extend the one builder over its own parts — a consumer replaces
the method it needs and keeps the rest (`FakeHostedThreadOptions.runtime`); #178 closed the
consolidation that made that possible. A double earns its place by driving consumer-visible
behavior — state transitions, frames, rendered output, real errors — not by returning whatever the
test asserts.

## Which proof a change needs

**Bug fix:** reproduce the failure through the narrowest real surface, fix the source, show the same
reproduction no longer triggers. Keep a regression test only when it defends a plausible future bug.

**Contract or seam change:** refresh sourced fences (`bun scripts/docs/refresh-fences.ts <page>`),
regenerate affected references, update every implementation and fake, run the focused contract test,
then the full gate. The fence diff is part of review, not generated noise.

**Generated reference change:** run its generator and review the semantic diff. Then prove the docs
gate red with a stale page once when the generator itself changes; routine data updates need only the
green gate.

**Web behavior:** run the actual web surface. Model-free flows use the Playwright suite; a model path
uses the `@model` slice and its required credentials. Unit tests prove folds and races; they do not
prove layout or interaction.

**TUI / launcher behavior:** run `scripts/zen.mjs` or the relevant CLI and observe its output/state.
Typecheck and unit tests cannot prove process environment, package loading, terminal rendering or
provider access.

**Security rule:** plant a bypass representative of the class, show the focused gate/test red, fix the
classifier or boundary, show green, then run the full gate. Never add a special-case suppression for
the one input.

## Commands

| Intent | Command |
|---|---|
| repository green | `bun run check` |
| docs only | `bun test test/docs-gate.test.ts test/glossary-doc.test.ts` |
| all source-tree gates | `bun test test/` |
| model-free web | `bun run e2e` |
| model-backed web | `bun run e2e:model` |
| refresh sourced fences | `bun scripts/docs/refresh-fences.ts docs/seams/<page>.md` |
| regenerate a reference | `bun scripts/docs/<generator>.ts > docs/reference/<page>.md` |
| inspect current gate/ratchet/double inventory | read [`reference/verification-inventory.md`](./reference/verification-inventory.md) |

A command proves exactly what it runs. The full gate does not exercise Playwright or a live provider;
a Playwright run does not prove the TUI; a generated page does not prove its prose. State the receipt
at that granularity.
