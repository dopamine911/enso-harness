# Distribution — what it would take to ship Enso outside this checkout

**Written** 2026-10-13 by Claude (Opus 5.5) at Daniel's request, for the Enso project.

A research record, not a decision. It answers "how could someone who has not cloned this repository
run Enso?", lists what stops that today, and ends with the decisions that have to be made before any
packaging work starts.

Evidence is this repository at `1c284345` (`origin/main`, read in the worktree
`../zhf-distribution`, branch `design/distribution`). The `web_search` client-identity row was re-read
at `f3cb9e17`, after #925 merged. Also read: its installed `node_modules` after `bun install`,
pi's own packaging guide (`@earendil-works/pi-coding-agent@1.1.0`, `docs/packages.md`), issue #7, and
the npm registry as queried on 2026-10-13. Where a claim rests on reasoning rather than on a file read
or a command, it says **[inference]**. Nothing was built, packed or published.

---

## The one thing that blocks before anything else: `pi-multi-account`

`pi-multi-account` ships inside the harness package (`packages/harness/package.json`, the `pi.extensions`
list and `dependencies`). Issue #7 records that it is **load-bearing for Anthropic Pro/Max access**:
with it suppressed, requests fail with Anthropic's "Third-party apps now draw from extra usage" 400;
with it loaded they succeed. It does that by rewriting the request body: it removes pi from the system
prompt and prepends a Claude Code billing attestation (`x-anthropic-billing-header: cc_version=…;
cc_entrypoint=…; cch=…`) derived from a pinned Claude Code version (#7, "The mechanism").
[`provider-auth-and-client-identity.md`](./provider-auth-and-client-identity.md) already argues that the
plan is not the honest route for a third-party harness.

Running that on your own machine is one thing. **Redistributing it is distributing the mechanism**, to
people who did not choose it and may not know it is there.

- **Confidence 0.8** that shipping it by default puts the distributor at odds with Anthropic's consumer
  terms. Caveat: this is a reading of the mechanism, not legal advice, and the terms were not re-read
  for this page.
- **Confidence 0.9** that it is fragile for users regardless: #7 says there is no version-checkable pin,
  and the failure signal is a 400 that does not mention versions. A distributed copy breaks on
  Anthropic's release cadence, for people who cannot see why.

It is not the only place. Enso's **own** `web_search` code also presents itself as Claude Code on the
OAuth path (see *The extensions Enso loads* below). Leaving `pi-multi-account` out does not, on its own,
remove the client-identity question from a distributed build.

The options, for Daniel to choose (see *Decisions* below): ship without it (API keys, and providers that
do not need the attestation), ship it as a separate, opt-in package the user installs knowingly, or ship
it as today and accept the liability. Every packaging route below inherits whichever is chosen.

---

## Two surfaces, two hosts — the fork everything hangs off

"Redistribute Enso" is two problems, because the two surfaces are run by different programs.

| Surface | Who loads it | Runtime it needs | Natural distribution shape |
|---|---|---|---|
| **Terminal** (`bun run enso`) | pi itself, from `PATH`, via `-e packages/harness` (`scripts/enso.ts` header) | whatever pi runs on (Node ≥ 22 per root `engines`); pi loads TypeScript extensions through its own jiti loader (`pi-coding-agent/dist/core/extensions/jiti-loader.js`) | a **pi package**: `pi install npm:<name>` |
| **Web** (`bun run dev`) | Enso's own server processes | **Bun** — `Bun.serve` with an `HTMLBundle` (`packages/web/src/server/dev-web.ts`, which imports `index.html`), `Bun.resolveSync` (`packages/web/src/server/font-files.ts#createFontFileRoute`), Tailwind through `bun-plugin-tailwind` read from the process cwd's `bunfig.toml` (`dev-web.ts` header) | an npm package with a `bin` that needs Bun, a `bun build --compile` binary, or a container |

Receipt that the harness and core do not need Bun: `grep -rn "Bun\." packages/harness packages/core`
(non-test) finds one hit, inside a comment (`packages/harness/core/shell-secret-paths.ts`).
**Confidence 0.9** that the pi-package route is not blocked by the runtime. Caveat: a grep for `Bun.`
does not catch `bun:` module imports; none was looked for.

---

## The extensions Enso loads

Both surfaces load the same list: the `pi.extensions` array in `packages/harness/package.json`, in
that order. The terminal gets it through `-e packages/harness`, the web host through
`additionalExtensionPaths` (`packages/web/src/host/hosted-thread.ts#buildHostedThread`). The order matters: logging
is first by invariant, and `incident-report` has to load after the permission engine (its header says
why). Two variations:

- A **non-interactive** terminal run (`-p`, or piped stdin) loads a print variant with the permission
  engine filtered out (`scripts/print-harness.ts`, #20).
- The web host's **model list** loads only the extensions that register a provider
  (`providerExtensionsOnly`, `packages/web/src/host/session-models.ts#providerExtensionsOnly`). In practice that means
  `pi-multi-account`.

| # | Extension | Owner | What it does | Distribution concern |
|---|---|---|---|---|
| 1 | `extensions/logging` | Enso | Configures LogTape for the pi process, and records the provider's request id (#132, #144). | none found |
| 2 | `extensions/guards` | Enso | The guard suite on `tool_call`: policy floor, bash policy (through the `cc-safety-net` library, MIT, pinned 2.4.6), egress deny, write confinement, read gate, incidents, the command judge. | Calls `findRepoRoot` at load (blocker 1). Imports `@earendil-works/pi-classifier`, an alias of `pi-ai` (blocker 3). |
| 3 | `extensions/web-fetch` | Enso | `web_fetch`: the sanctioned web access, with an empty-by-default host allowlist (#54). | none found |
| 4 | `extensions/web-search` | Enso, partly ported | `web_search`: the current model's native search, with a Tavily fallback (#63). Ported from `pi-web-search` 1.4.0 (© ttttmr, MIT), which its header says. | ⚠ **Client identity, on searches and on conversations.** A search made with a Claude login sends `claude-cli/<version>`, `x-app: cli`, Claude Code's beta flags, and "You are Claude Code, Anthropic's official CLI for Claude." as the first system block (`packages/harness/core/web-search/providers/anthropic.ts#applyOAuthHeaders`, `#ANTHROPIC_OAUTH_IDENTITY`). The comment says the block is load-bearing: without it, Anthropic answered 429. Since #925 the extension also hooks `before_provider_headers` and replaces pi's user agent on **conversation** requests with the version the user sets in `claudeCode.version` (`packages/harness/extensions/web-search/index.ts#claimClaudeCodeVersion`). The version comes from `packages/core/src/claude-code.ts#CLAUDE_CODE_DEFAULT_VERSION` (`2.1.280`, pi's own) unless that setting overrides it. So the version Enso claims is now Enso's own setting, not something it only inherits from pi. MIT also requires the ported notice to ship with the code. |
| 5 | `@gotgenes/pi-permission-system` | third party, 40.0.2, MIT | The permission engine: allow/ask/deny rules, the authorizer chain. | Must be bundled (blocker 3). |
| 6 | `extensions/permission-modes` | Enso | Modes over the engine: `/default`, `/acceptEdits`, `/plan`, `/bypassPermissions`, `/auto` (#496). | Depends on #5's service. |
| 7 | `pi-multi-account` | third party, 1.24.0, MIT | Multi-account failover and rotation across Anthropic, OpenAI Codex, Kimi, Cursor, Qwen and Ollama. On a quota or rate limit it switches to the next logged-in account. It also has a Cursor bridge (a loopback proxy), which Enso turns off by default (`includeCursor: false`, `packages/web/src/host/multi-account-seed.ts#MULTI_ACCOUNT_INCLUDE_CURSOR_KEY`, #341). | ⚠ **The blocking concern** (top of this page). Its `before_provider_request` hook removes pi from the system prompt and adds a billing attestation built from `CLAUDE_CODE_VERSION = "2.1.288"` and a fixed salt (`node_modules/pi-multi-account/index.ts:3409-3428`, `3525-3531`). Its own comment says that pin "must track the current Claude Code release". Separately, **rotating several subscription accounts to get past each one's quota** is itself something a provider's terms may forbid [inference, terms not read]. Must be bundled (blocker 3). |
| 8 | `extensions/ask-user` | Enso | The `ask_user` tool: one card on the web, one prompt at a time in the terminal (#12). Replaced the adopted `@d3ara1n/pi-ask-user`. | none found |
| 9 | `extensions/system-prompt` | Enso | Applies a thread's library system prompt at each run start, on every surface (#443). | none found |
| 10 | `extensions/run-context` | Enso | Records what a run starts under (git, config hash, skills, context files, mode) as an `enso-run-context` entry when it changes (#435). | none found |
| 11 | `extensions/incident-report` | Enso | When a halting incident opens, puts the agent through one bounded `file_incident_report` turn (#467). | none found |

The manifest also loads one third-party **theme**, `@mammothb/pi-tokyonight-storm` 0.2.1 (MIT), through
a `node_modules/` path, so it has to be bundled too (blocker 3).

"None found" means no distribution concern beyond the shared blockers below (license, `@enso/core`,
the pi version pin), which apply to every Enso extension. It does not mean the extension was reviewed
for anything else.

**The concern, in one line:** two of the eleven make requests that claim to be Claude Code. One is
third-party (`pi-multi-account`, which also forges a billing attestation). The other is Enso's own
`web_search` extension. It sends the identity line and Claude Code's user agent on searches, and since
#925 it sets the claimed Claude Code version on conversation requests too, from the `claudeCode.version`
setting. Those sit on top of pi's own Anthropic OAuth provider, which also sends the identity block
(`provider-auth-and-client-identity.md`). A distributed build that should not claim to be Claude Code
has to drop the subscription path completely:

- API keys only for Anthropic;
- `pi-multi-account` left out or opt-in;
- `web_search`'s OAuth branch, its `before_provider_headers` hook and the `claudeCode` setting
  disabled.

**Confidence 0.75** that pi-ai's OAuth provider, `pi-multi-account` and `web_search` are the only
parts that claim Claude Code's identity. Caveat: I grepped Enso's packages for `claude-cli` and
`claudeCodeUserAgent`, and read `pi-multi-account`'s hook. I did not audit `pi-permission-system` or
the Cursor bridge's requests.

---

## What stops either route today

### 1. Runtime code finds itself by walking up to the repository root

`findRepoRoot` (`packages/core/src/paths.ts#findRepoRoot`) walks up to the first `package.json` with a
`workspaces` key and **throws** `RepoRootNotFoundError` when there is none. An installed package has no
such ancestor. Runtime callers (not scripts, not tests), and what each one uses the root for:

| Caller | Uses the root for | Replacement shape [inference] |
|---|---|---|
| `packages/harness/extensions/guards/index.ts#GuardDependencies` (`harnessRoot`, filled by the default export) | `harnessRoot`: one of the "existing" credential places a directory search above it is refused for (`packages/harness/core/guard-session.ts#createGuardSession`, #160 §4) | the harness package's own directory, from `import.meta.url` — no walk |
| `packages/web/src/host/agent-host.ts#createAgentHost` → `quarantineSecrets` | `repoRoot` for `rootDotenvPath` — the checkout's `.env`, read so its keys are quarantined (`packages/core/src/secrets.ts#quarantineSecrets`) | optional: an installed copy has no checkout `.env`; skip when absent |
| `packages/web/src/server/bundle-route.ts#thisCheckout` | `describeCheckout` reads `.git/HEAD` and `packed-refs` for the log bundle's version line | the package version from its own `package.json`; `.git` does not exist in an install |
| `packages/web/src/server/dev-web.ts#fontFiles` | `webPackageDir` for `public/`, the fonts and the web `package.json` | package-relative paths |
| `packages/web/src/server/dev.ts` → `harnessPackageDir`, passed into `startEnsoServer` | the harness directory handed to pi as `additionalExtensionPaths` (`packages/web/src/host/hosted-thread.ts#buildHostedThread`) | resolve the harness package by name, not by `packages/harness` |

The guards extension is the one that matters for **both** routes: it is loaded by pi, so the pi-package
route fails at extension load until `packages/harness/extensions/guards/index.ts#GuardDependencies` stops calling `findRepoRoot`. **Confidence
0.85.** Caveat: I read the call sites, I did not install a packed tarball and watch it throw.

`scripts/enso.ts`, `scripts/dev.ts` and `scripts/link-vendor-packages.ts` also call it; they are the
launchers and would be replaced, not ported.

### 2. `@enso/core` is private and ships as TypeScript source

`packages/core/package.json`: `"private": true`, `"main": "./src/index.ts"`, and its `exports` include
three entries under `src/__tests__/` (`flow-trace`, `log-recorder`, `observation-kinds`). The harness
imports it (`packages/harness/extensions/guards/index.ts`). For any route it either:

- is **published** in its own right (`@enso/core` returned E404 on npm on 2026-10-13, so the name is
  free — but the `@enso` scope's ownership was not checked), or
- goes **inside the harness tarball** through `bundledDependencies`.

⚠ Core's own `dependencies` include `typebox` (`^1.3.34`), next to four `@logtape/*` packages.
`typebox` is one of the packages pi supplies to extensions, and pi says a physical copy of one "can
bypass Pi's extension module mapping … and create duplicate classes" (`docs/packages.md:90`). So
bundling core as it stands puts a second `typebox` inside the harness tarball. Core's `typebox` has to
become a `"*"` peer, as the harness already treats it (a devDependency there), before either option
is safe.

TypeScript source is acceptable to pi, which loads extensions through jiti. It is not acceptable to a
plain Node consumer [inference]. Bundling is the smaller change and keeps one version line; publishing
makes sense only if a third party should build on core.

### 3. The vendored pi packages must be bundled, as pi requires

pi's guide (`docs/packages.md:78-92`): runtime imports go in `dependencies`; pi-provided packages
(`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) go in `peerDependencies` with `"*"`;
and "other Pi packages used as dependencies must be included in the published tarball and referenced
through their `node_modules` resource paths." The manifest already references three that way
(`node_modules/pi-multi-account/index.ts`, `node_modules/@gotgenes/pi-permission-system/src/index.ts`,
`node_modules/@mammothb/pi-tokyonight-storm/themes`), and `scripts/link-vendor-packages.ts`'s header was
written anticipating a tarball built from `bundledDependencies`. Missing today: the
`bundledDependencies` list itself, and a `"*"` peer range (the manifest says `~1.1.0`).

**Done in #952.** `bundledDependencies` lists the three vendored pi packages and `@enso/core`.
`pi-ai` is now a peer too: the harness imports it at runtime but declared it nowhere, so it resolved
only because the workspace hoisted a copy. The peers are pi's `"*"`. pi's installer never reads a
peer range (`--legacy-peer-deps` under npm, `--omit=peer` under bun, measured in pi 1.1.0's
`package-manager.js`), so a tested bound there was a contract nothing enforced. The bound a
`pi install` user gets is the guard's, at load (#953). The manifest states it on the workspace
devDependency on pi, the copy the guard's corpus is run against.

The harness also declares `@enso/core`'s runtime dependencies (`@logtape/file`, `@logtape/pretty`,
`@logtape/redaction`, beside `@logtape/logtape`), at core's own ranges. An installer does not install
a bundled package's own `dependencies`, and #949 measured the logging extension failing on
`@logtape/file` for that reason.

Tests in `test/dependency-gate.test.ts` hold these rules:
- the harness bundles exactly the packages pi reads by path, plus the workspace packages it depends on;
- every package its runtime imports is a dependency or a peer, and every peer is `"*"`;
- every runtime dependency of `@enso/core` is one the harness declares, at the same range;
- a `files` allowlist covers every top-level directory and keeps the harness's own tests out of the
  tarball.

⚠ **#949 measured that this is necessary but not sufficient.** Packed from the hoisted workspace:
- `bun pm pack` bundles the wrong package;
- `npm pack` writes the bundled packages' own dependencies as `../` entries, which npm refuses on
  install;
- so `zod` and others never arrive, and 3 of the 11 extensions fail to load. (`@logtape/file`, core's,
  is now declared by the harness itself, above.)

Producing a working tarball needs a packing step of its own, filed separately.

`@earendil-works/pi-classifier` (an npm alias of `pi-ai@1.1.0` in `dependencies`) looks like it breaks
the "no physical copy of a host package" rule, but it is deliberate: pi's loader rewrites
`@earendil-works/pi-ai` subpath imports onto its `compat` entry, which failed the guards extension
(`docs/seams/guards.md:447-451`, #535). Whether pi's duplicate-copy warning fires on the alias was
**not tested**. It needs a packed install to find out.

### 4. pi's version was pinned by the launcher, and `pi install` bypassed the launcher — resolved by #953

`packages/core/src/supported-pi-versions.ts#SUPPORTED_PI_VERSIONS` accepts pi `>= 1.1.0, < 1.2.0`,
because the guard carries a replica of pi's path resolver (#217). Before #953 only the launcher checked
it, before the spawn. `pi install npm:<name>` loads the package into **whatever pi the user has** and
never runs the launcher, so an installed harness was correct only by luck.

**Since #953 the guard checks it too.** It reads the running pi's own `VERSION`, and under a pi outside
the range it refuses every tool call and says why at `session_start` (`docs/seams/guards.md`). The
launcher and the guard read the same constant. What stays open: nothing at **install** time stops an
unsupported pi, because pi's installer ignores peer ranges. The refusal happens when the harness loads.

### 5. `bun run enso`'s isolation does not come with a pi package

The launcher's four isolation mechanisms (`PI_CODING_AGENT_DIR`, `--no-extensions`, `--no-skills`, and
the `permissions.json` link, README "What `bun run enso` actually does") are flags and environment on
**a spawn**. A user who runs `pi install npm:<name>` and then `pi` gets Enso loaded **alongside** their
own packages, skills and settings, under their own permission config. The guards still run; the "only
Enso" guarantee does not. So either the pi package ships its own `enso` bin that does what
`scripts/enso.ts` does, or the docs have to say plainly that the terminal surface becomes "Enso plus
whatever else you have."

### 6. The web surface has no production build

`dev-web.ts` is the only thing that serves the page, and it is Bun's development server with HMR. The
page and API run as two processes on `:5178` and `:5179`, with the page proxying `/api`. Shipping the
web surface is **new work, not packaging**: a build step for `index.html` and `debug.html`, static
serving from the API process (or keep the proxy), and font resolution that does not depend on
`webPackageDir`.

`bunfig.toml` pins `linker = "hoisted"` because the isolated linker gave `@ag-ui/core` two module
identities and broke the build (header comment). A user's package manager will not read that bunfig.
That argues for **pre-bundling the frontend** at publish time rather than shipping its source tree to be
resolved on the user's machine. **Confidence 0.7** that the dual-identity problem would recur in a user
install. Caveat: it was observed for the type build, and was not tested at runtime.

### 7. There is no license file

There is no `LICENSE` at the root or in any package. `packages/harness/package.json` says `"MIT"`;
`@enso/core`, `@enso/web` and the root manifest say nothing. MIT requires the notice to travel with the
copies, and an unlicensed package is "all rights reserved" by default. This needs a decision from the
copyright holder before any copy leaves the repository. **Confidence 0.9.**

### 8. The name

`enso` on npm is taken (`npm view enso`: maintainer `kossnocorp`, modified 2025-12-12), and the harness
manifest is named `enso`. `enso-harness` and `enso-agent` returned E404. Enso is also an existing
programming language (enso.org). Naming is not resolved here.

⚠ `packages/harness/package.json` had no `"private": true` (core and web do). A stray `bun publish`
from that directory would try to publish under the taken name. **Done in #952:** the manifest is
`"private": true` until #948 decides the name.

---

## Licenses of what would ship — clear

Sweep of every installed `package.json` (two levels of nesting): 902 MIT, 83 Apache-2.0, 72 ISC,
52 BSD-2/3, plus a tail. Direct runtime dependencies, each checked by name:

- **Harness:** all MIT — `pi-*` 1.1.0, `pi-multi-account`, `@gotgenes/pi-permission-system`,
  `cc-safety-net` (its manifest and `LICENSE` both say MIT), `@mammothb/pi-tokyonight-storm`,
  `@logtape/logtape`.
- **Web** (every key of its `dependencies`): 22 MIT, 9 OFL-1.1 (the `@fontsource` fonts; OFL permits
  bundling), `class-variance-authority` Apache-2.0, `lucide-react` ISC, plus `@enso/core` (unlicensed —
  blocker 7).

No patched dependencies exist on `main`: the #758 patch to `pi-multi-account` was dropped when 1.24.0
ran unpatched (`51da1c0a`, #761).

The copyleft and unusual licenses all trace to the docs site or dev tooling (`bun pm why`):

| Package | License | Reached through |
|---|---|---|
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | `sharp` ← `astro` ← `@enso/site` |
| `elkjs` | EPL-2.0 | `mermaid` ← `@enso/site`, root devDependency |
| `lightningcss` | MPL-2.0 | `vite` ← `astro`; `react-doctor` (dev) |
| `caniuse-lite` | CC-BY-4.0 | build tooling |
| `react-doctor`, `oxlint-plugin-react-doctor` | "SEE LICENSE IN LICENSE" | root devDependency |

**Confidence 0.8** that nothing a distributed harness or web build would ship is copyleft. Caveat: the
sweep stopped at two levels of `node_modules` nesting, and a real check is `bun pm ls` over the packed
tarball's production tree, which does not exist yet.

---

## The routes

| Route | Ships | Needs first | Cost [inference] | Keeps "only Enso" isolation |
|---|---|---|---|---|
| **A. Source** — clone + `bun install` | everything | a license, and the multi-account decision | near zero: document it | yes |
| **B. pi package** — `pi install npm:<name>` | terminal surface only | blockers 1 (guards), 2, 3, 7, 8 (4 is done, #953) | small to medium | no, unless it ships its own launcher bin (5) |
| **C. npm CLI needing Bun** — `bunx <name>` | both surfaces, frontend pre-built | everything in B, plus 1 (all rows) and 6 | medium to large | yes, the bin is the launcher |
| **D. Single binary** — `bun build --compile` | both, plus pi itself | everything in C, plus proof that pi's jiti loader can load extensions from Bun's embedded filesystem | unknown, needs a spike | yes |
| **E. Container image** | both, with pi and Bun pinned | the multi-account decision; a story for host git credentials and the project mount | medium | yes, and confinement as a bonus (#896) |

D is the only route whose feasibility is unknown. pi loads the harness **by directory path**
(`additionalExtensionPaths`, `packages/web/src/host/hosted-thread.ts#buildHostedThread`; `-e <dir>` in the terminal), and whether that path
can point into a compiled binary's embedded files was not tested. Treat it as a spike, not a plan.

E is worth a second look because #896 (a sandbox seam) is open: a container moves Enso from "not a
sandbox" (README) towards one. It also changes the product, so it is not just a packaging choice.

**Recommendation (confidence 0.6, because it depends on the audience decision below):** do A now. It
needs only a license and a multi-account answer, and it is what every other route also needs. Then do
the shared refactor that B and C both require: one "where is this package installed" resolver replacing
the five runtime `findRepoRoot` calls, `@enso/core` bundled, and `bundledDependencies` declared (the pi
version check already moved into the extension, #953). Choose between B and C after that, depending on whether the
audience wants the web surface. Spike D only if a one-file install is a requirement.

---

## Decisions this needs (Daniel's)

1. **`pi-multi-account` in a distributed build:** leave it out, ship it as a separate opt-in package,
   or ship it as today. This blocks everything else.
2. **Audience:** a few known people (a git-URL install or route A is enough), or the public (npm, a
   name, support load)? This decides between A and B/C more than any technical fact here.
3. **License** for the repository and each package, and who the copyright holder is.
4. **Which surface ships:** terminal only (B), or both (C/D/E).
5. **Name** on npm, given `enso` is taken.

## Not looked at

- Windows and macOS. Everything here was read on Linux; the guards' path logic and the launchers were
  not checked against other platforms.
- Whether `pi install` honours `bundledDependencies` in practice. That needs a `bun pm pack` and an
  install into a scratch `PI_CODING_AGENT_DIR`. It is the cheapest next experiment, and it would turn
  blockers 1–3 from read to measured.
- The docs site (`site/`, deployed manually per `docs/verification.md`). It is already distributed, and
  it is out of scope.
