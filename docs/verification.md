# Verification

How Enso proves a change and holds the boundaries the refactor depends on (#170). The generated
[verification inventory](./reference/verification-inventory.md) is the factual table: every gate,
ratchet and reusable test double, its current count, source and stated limitation. This page explains
how to use it. It does not repeat the inventory.

## One definition of green

`bun run check` (the same script as `check:all`) runs `scripts/gate.ts`. Thirteen gates, in order, stopping
at the first failure (the last only warns):

1. **Format** — `oxfmt --check`: formatting, import order and Tailwind class order, check-only.
2. **Lint** — `oxlint` with `oxlint.config.ts`, type-aware (`oxlint-tsgolint`). It carries the
   repository's naming gate: `scripts/lint/enso-plugin.ts` runs upstream's
   `unicorn/name-replacements` over the word lists in `scripts/lint/naming-policy.ts`. Test rules
   come from `eslint-plugin-jest`, told that `describe`/`test` are imported from `bun:test`.
3. **TypeScript** — `tsc -b --checkers 4`, a project-reference build. It emits: project references
   require `composite`, `composite` requires declaration output, and `tsc -b --noEmit` is refused with
   TS6310, so the declarations land in each package's gitignored `dist-types/`. **The compiler is
   TypeScript 7, the API TypeScript 6.0** (#745): 7.x is the native port and ships no compiler API,
   so every tool that *reads* types rather than checking them — TypeDoc and the four
   `scripts/docs/*` readers — imports `typescript`, which the root manifest aliases to
   `@typescript/typescript6`, while `tsc` comes from `@typescript/native` (`typescript@7`). Measured
   cold over this tree, the 7.0 build takes 2.6–2.8 s against 6.0.3's 18.2–18.4 s; #188 had given
   that up for TypeDoc before the alias existed. `--checkers 4` is 7.0's default, pinned so laptops
   and CI split the program the same way. `test/dependency-gate.test.ts` holds both halves: the API
   against TypeDoc's own peer range, and `tsc` resolving to the 7.x binary.
4. **Dead code** — `fallow dead-code` (#163): fails on any unused file, export, type or dependency.
   **No baseline since #594.** The identity baseline #163 introduced (the backlog as inventory,
   growth as the regression) had been empty since #263, and the last 17 rows were why it should
   stay so: they were the harness barrel's unconsumed exports, carried under a note deferring the
   question to #173's zone rule, which shipped without taking it. A baseline row does not age — it
   reads the same whether the leak is still there or long gone — and re-saving one was the way to
   accept a finding without deciding to. The barrel's surface is derived from what the extensions
   import and held by `test/harness-barrel-gate.test.ts`, which names the lines to delete instead.
   Every dead-code rule that can fire here is an error.
   `.fallowrc.jsonc` names every program fallow cannot see a loader for (the harness extensions, the
   Bun plugin, the direct-run scripts), and `test/fallow-config.test.ts` holds its extension entries
   equal to the harness manifest.
5. **Complexity** — `fallow health` over every function at a cognitive ceiling of 20 (25 until #595). Exceptions are
   per FUNCTION in `.fallowrc.jsonc` (`health.thresholdOverrides`), each pinned at the exact score its
   function measures, and `test/complexity-ratchet.test.ts` refuses a pin that is looser than that
   score, names a function that no longer exists, or covers one already under the ceiling.
6. **New complexity** — `fallow health` again at fallow's default of 15 (#594), against
   `complexity-baseline.json`: an identity baseline of the functions already over 15 when it was
   taken. A function not listed — new, or renamed — must be under 15; a listed one is held by the
   ceiling. The list only shrinks: a listed function that no longer needs its entry fails — the
   gate when its whole file has none left (fallow's `--fail-on-stale-baseline`), and
   `test/complexity-ratchet.test.ts` for the single function, which fallow does not check.
   `bun run complexity:baseline` re-saves it; an entry a re-save ADDS is an exception to review.
   This is what `fallow audit` was going to do on every push; its verdict also counts every new
   clone group and styling finding, and it needs a git base a hook may not have.
7. **Duplication** — `fallow dupes` in semantic mode (#593): fails when the duplicated-line
   percentage rises above `duplicates.threshold` in `.fallowrc.jsonc`, a ratchet that may only fall.
   It was an advisory CI step until #593 and was crossed four times unseen, each time already red; a
   crossing is now the commit that causes it. What the count excludes (vendored components, core's
   schema pairs, the colour palettes, the doc generators' inventory tables) is recorded beside the
   threshold, each with its reason.
8. **react-doctor** — `react-doctor --project packages/web --scope full --no-score --no-supply-chain --blocking warning`
   (#342, #747): the web surface outside the ported `src/components/` (`packages/web/doctor.config.json`
   draws the same boundary as the linter, coverage and fallow), failing on any finding, warnings
   included. Offline flags are part of the command, not options — a pre-commit hook must not phone
   home — which is also why the gate holds no score: react.doctor computes it server-side from an
   upload of the findings, and 85 on that scale measured as "at most four warnings", which this
   holds locally with zero. `--scope full` is part of it too: on a terminal, with changes on the
   branch, react-doctor otherwise asks what to scan and waits. The rule set is upstream's, so
   a bump of the pinned `react-doctor` is a gate change.
9. **Bun test** — the complete test tree, with text and LCOV coverage reporters.
10. **Aggregate coverage** — `scripts/check-coverage.ts` reads LCOV and enforces the total line and
   function floors. The current values are generated under *Ratchets* in the inventory.
11. **API docs** — `typedoc` over both barrels with `treatWarningsAsErrors` (#188). TypeDoc's warnings
   *are* documentation drift — a `{@link}` whose target was renamed, a type a documented signature
   exposes but nothing exports — and none of them is visible to `tsc`. It runs with `--emit none`:
   the step validates, and the site renders the same surface as native pages from the same
   `typedoc.json` (`starlight-typedoc`), so nothing here produces an artifact to keep in step.
12. **Site** — projects `docs/` into the Starlight site, builds it, then crawls every built page for
   dead internal links (#188). **The build is not the check.** `astro build` reported success over 139
   dead links on the first run, because a page's `./routes.md` and `../../packages/…#L47` are both
   correct on GitHub and both 404 as routes; `scripts/docs/site-links.ts` is what notices.
13. **CRAP** — fails on a function at CRAP ≥ 30 (cyclomatic² × (1 − coverage)³ + cyclomatic) from
   measured coverage, unless `crap-pins.json` pins it at exactly its score with the reason it stays
   (#844). After `test`, `scripts/coverage-istanbul.ts` converts the LCOV it wrote into Istanbul and
   `scripts/check-crap.ts` judges fallow's scores: a pinned function may get better, never worse, and
   a pin that is looser than its function or matches nothing fails too, so the list only shrinks. It
   is a step of its own rather than `health.maxCrap` in `.fallowrc.jsonc`: CRAP on in the config
   changes the key of the function `complexity-baseline.json` holds and fails the new-complexity gate
   (#826), and only a step after `test` scores from measured coverage, on CI and laptops alike.

The API reference is part of the site rather than a second site behind a link: `starlight-typedoc`
generates one markdown page per entry point into the Starlight content tree, so the contracts carry
the site's navigation, theme and search instead of TypeDoc's own HTML shell.

Publishing is separate and **manual**: `.github/workflows/docs-site.yml` runs on
`workflow_dispatch`, builds the same two steps, and deploys to GitHub Pages only when the run is
asked to (`deploy: true`); otherwise it uploads the built site as an artifact. Nothing publishes on
a push, because gate 12 has already proved the build on every PR and a second one would buy only
Actions minutes. ⚠ The workflow reads the site's base path and origin from the Pages configuration
(`actions/configure-pages` → `ENSO_SITE_BASE` / `ENSO_SITE_URL` → `scripts/docs/site-base.ts`, the
one reader Astro, the projector and the crawl all share). A project site is served from
`/<repository>` and a custom domain (`enso.engineer`, #506) from `/`, and a wrong base builds valid
HTML whose every internal link 404s with nothing failing — so it is derived rather than written
down, and `test/site-gate.test.ts` holds that.

The local pre-commit hook (`.githooks/pre-commit`) and the blocking CI job
(`.github/workflows/ci.yml`) call that same script. The hook runs it over the working tree as it is
(#807): commit with no code in the tree you do not mean to commit, and CI gates the PR head either way.
CI adds independent jobs — secret scan, automated review — but none replaces the
thirteen-step gate (react-doctor was one of them until #342 promoted it into the gate, the duplication
ratchet until #593, and the advisory `fallow audit` job until #594 replaced it with the new-code gate). A green editor or a
single test is not repository green.

`bun run health:full` (#825) is the other direction, and **not** a gate: fallow with its exemptions
off, written to `.local/health-full.md`. It tables what each exemption in `.fallowrc.jsonc` hides
when removed alone, then shows fallow's dead-code, duplication and health output with every
finding-hiding exemption off, at fallow's own limits, with CRAP on and the findings inside unused
files shown. CRAP is scored from measured coverage when `coverage/lcov.info` exists (#826): the
report converts it first (`bun run coverage:istanbul`, `scripts/coverage-istanbul.ts`) and states the
LCOV's age, since it never runs the suite itself. The gate holds the line; this report is where to
look before moving it.

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
- `source-citation-gate.test.ts` — a `path#Name` citation names a real declaration, and no hand page types a line number into this repository;
- `presentation-gate.test.ts` — ported files name their provenance and import no application state;
- `logging-gate.test.ts` — records use `ensoLogger`; the logging substrate stays behind it;
- `harness-barrel-gate.test.ts` — the harness barrel exports exactly what the extensions import;
- `no-duplicate-paths.test.ts` / `no-duplicate-shapes.test.ts` — roots and schemas have one home.

Read the generated table before editing a gate: its limitation column is the edge the gate does not
cover. Do not strengthen prose and leave the matcher behind it.

## Ratchets move one way

A ratchet pins a measured boundary. The generated [*Ratchets*](./reference/verification-inventory.md#ratchets)
table reads the numbers from source — aggregate coverage floors, global and per-file complexity
ceilings, allowlist and exception counts.

- A coverage floor may rise after the full suite proves the new number; it does not fall to land a PR.
- A per-function complexity pin may fall after the named function shrinks; it does not rise to admit a
  rewrite. `.fallowrc.jsonc` carries the reason beside each exception.
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
- **Logging** — the single `recordEnsoLogs` (`packages/core/src/__tests__/log-recorder.ts`, one for
  every package) replaces the sink while calls still go through `ensoLogger` and its structured
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

**TUI / launcher behavior:** run `scripts/enso.ts` or the relevant CLI and observe its output/state.
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
| dogfood Enso through its UI, recorded | `bun run arena start` ([`packages/arena/README.md`](../packages/arena/README.md)) |
| refresh sourced fences | `bun scripts/docs/refresh-fences.ts docs/seams/<page>.md` |
| regenerate a reference | `bun scripts/docs/<generator>.ts > docs/reference/<page>.md` |
| inspect current gate/ratchet/double inventory | read [`reference/verification-inventory.md`](./reference/verification-inventory.md) |

A command proves exactly what it runs. The full gate does not exercise Playwright or a live provider:
CI runs neither. The model-free Playwright tier runs by hand, `bun run e2e`, before merging a change to
the browser surface (it left CI with #501: a Chromium job on every PR cost more than it caught), and
nothing runs the live
provider. A Playwright run does not prove the TUI; a generated page does not prove its prose. State the receipt
at that granularity.
