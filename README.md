# zen-harness

A **pi package** that provides **two surfaces over one agent loop**. [pi](https://github.com/earendil-works/pi)
owns the loop, the providers, sessions, and compaction; zen-harness adds guards, tools, and state as pi
extensions, and presents them through a terminal launcher and a web application. Neither surface has its
own brain — both are clients of the same package running against the same pi.

The founding stance and end-state design live in [`docs/architecture.md`](docs/architecture.md); every
contract is a page under [`docs/seams/`](docs/seams/README.md); the research behind the early decisions is
[`docs/concepts/`](docs/concepts/). This README is the map of what is **built and running today**, and
why each piece is shaped the way it is — the *how* lives at the code and on those pages, once.

## Why this exists

pi is a deliberately minimal coding agent: a superb loop, 60+ providers, sessions, branching,
compaction — and **no confinement at all**. Out of the box, an agent with repository read access and an
unrestricted `bash` tool can read `~/.aws/credentials`, append to `~/.bashrc`, and post the repository
anywhere, and nothing in pi distinguishes any of that from fetching a public document
([`docs/concepts/pi-immediate-needs.md`](docs/concepts/pi-immediate-needs.md) catalogues the gaps,
ranked). zen-harness is the layer that makes running agents on pi *survivable*: a guarded floor that is
always on, an egress story that is a committed policy instead of an absence, and enough observability
that what an agent did is auditable after the fact.

Two decisions shape everything else:

- **pi owns the loop; there is no second agent.** Every temptation to build a competing loop — in the
  web backend, in a worker, in the chat framework — is refused. Features are written once as pi
  extensions and work in both surfaces, because they talk to pi's event and tool APIs, never to a UI.
- **A package, never a fork.** A package cannot entangle; extensions compose onto pinned vendor
  releases and can be replaced piecemeal. (The cautionary tale is oh-my-pi, surveyed in
  `.inspiration/` — it forked pi, which is exactly why its features are hard to lift.)

A third fact colors the engineering style: **this repo is built and reviewed largely by agents**, in
sessions with no shared memory. So conventions that would elsewhere live in tribal knowledge are
enforced by tests (the gates), gaps are recorded as *pinned tests* rather than prose, and
every landed change carries live receipts — a real run, not just a green suite.

## Quick start

```bash
bun install            # postinstall links the vendor packages into the harness
bun run zen            # a VANILLA pi with only zen-harness loaded (isolated agent dir)
bun run zen -p "..."   # non-interactive print run (loads the print variant — see below)
bun run dev            # both web surfaces: API server on :5179, app on :5178
bun run check:all      # THE gate: biome → tsc → fallow → bun test → coverage floor
```

`bun run zen` launches pi with three isolation mechanisms, each closing a different hole:
`PI_CODING_AGENT_DIR` points pi at `.zen/pi-agent` (a scratch config dir — none of your global
packages, settings, keybindings, or credentials are visible), `--no-extensions` suppresses discovery
(including this repo's own `.pi/settings.json`, which would otherwise load the package twice), and
`--no-skills` (pi discovers skills from `~/.agents/skills/` too, which the agent dir does not
redirect). The scratch dir has no credentials, so `/login` once inside it (or a
[`pi-multi-account`](https://www.npmjs.com/package/pi-multi-account) slot) is how they get there.
⚠ An exported `ANTHROPIC_API_KEY` does NOT reach pi: `#89`'s quarantine deletes every
secret-shaped environment variable before the spawn, and says which on stderr (`zen: secrets kept
out of pi's environment`). Provider auth lives in pi's own `auth.json`, by design —
[`packages/core/src/secrets.ts`](packages/core/src/secrets.ts) holds the rule, and
[`docs/reference/env-and-config.md`](docs/reference/env-and-config.md) the environment it leaves.

---

## The guard suite (`packages/harness/extensions/guards/`)

The always-on floor: one `tool_call` handler, **additive** by design — pi resolves *tools* first-wins,
so a guard implemented as a tool override is only safe while it loads first, but event handlers all
run and the first `block` is final, whatever the load order. What it enforces, in precedence order:
the fail-closed policy floor (#4: tool names canonicalised, the policy checked against pi's live tool
list, a mismatch denies *everything*); bash policy in two layers (#9: `cc-safety-net` as a pinned
*library*, then the network egress deny); write confinement inside the workspace with persistence
vectors refused (#21); the read gate by *exclusion* — every other tool carrying a `path` is a reader;
read-before-write (#10) and stale-write detection (#11).

Each of those is a paragraph in the extension's own header comment — the one statement kept at the
code, with the incident that motivated it — and the contract, its fakes and its gate are
[`docs/seams/guards.md`](docs/seams/guards.md). This README does not restate them.

## The network egress deny

A **bar, not a boundary**: string analysis that closes bounded, enumerable classes and says so. The
denied clients (`curl`, `wget`, `nc`, `ssh`, …) are matched per shell segment at command position,
with quoting resolved to the literal the shell would run, wrappers unwrapped, word-synthesis refused
outright, and unparseable input escalated to a coarse scan. Its deny message points the model at the
sanctioned path (`web_fetch`), and every stated non-coverage — `git` remotes, interpreters, cross-call
indirection — is a pinned test, so it reads as a record and never as confinement. The match modes and
the five rounds of adversarial hardening that shaped them (PR #55) are the header of
`packages/harness/core/network-egress.ts`.

## `web_fetch` and `web_search` (`packages/harness/extensions/`, #54, #63)

The sanctioned web access that replaces what the egress deny took away. The design premise for
`web_fetch`: the measured record (a 1,753-review survey, 99.2 % approvals) says human approval prompts
cannot carry egress policy — a **committed allowlist that accretes from real denials** can. So the host
allowlist lives in [`zen.config.json`](zen.config.json), **empty by default**, read once at session
start, and the refusal message is the product: it names the file, shows the JSON to write, and says the
change is a human's to make. Redirects are reported, never followed; every body arrives behind an
untrusted-content banner; one stderr audit line per call, refusals included.

`web_search` is provider-native search — the *current* model's own search API, billed to the identity
the conversation uses — with a Tavily retrieval fallback armed solely by `TAVILY_API_KEY` being present
(a key is a secret; secrets never enter the committed file). Outcomes are keyed on the wire's search
activity, **never on source count**: an answer the model produced without searching is labelled as
such and carries no banner, because it is not web content. Consumed from
[pi-web-search](https://github.com/ttttmr/pi-web-search) (MIT), retyped to this repo's rules, behind
one provider seam so a split into packages is mechanical.

The gates, limits, wire facts (the OAuth identity line) and recorded non-coverage are the two
extensions' headers and [`docs/seams/web-providers.md`](docs/seams/web-providers.md); every config
field and environment variable is [`docs/reference/env-and-config.md`](docs/reference/env-and-config.md).

## `zen.config.json` and the path helpers (`@zen/core`, #59)

**One committed config file**, one section per consumer, TypeBox-validated with a loading contract every
future section inherits: parse fails **closed** (`unreadable` is never "no policy"), and the schema is
**strict on unknown keys** — a typo refuses loudly instead of configuring nothing. The config belongs to
the zen-harness *install*: located from the harness's own tree, never from the session cwd, so a foreign
checkout's `zen.config.json` cannot become this session's allowlist. `packages/core/src/paths.ts` is
the one place that walks the filesystem for roots — realpath-first, because bun does not resolve
`import.meta.url` through the print harness's symlink mirror — and an anchor test names any file that
walks on its own. Fields and defaults: [`docs/reference/env-and-config.md`](docs/reference/env-and-config.md).

## The print variant (#20)

`picc-permission-modes` fails closed when it cannot prompt — every mutating tool denied, no escape
hatch — so a `-p` run under the full package could chat and do nothing else. Non-interactive runs
(explicit `-p`, or stdin that is not a TTY) therefore load a **print variant** materialized under
`.zen/print-harness/`: the harness manifest minus that one extension, with every other package-root
entry symlinked in place so relative imports keep resolving. Guards, web_fetch, web_search, skills, prompts and
themes all still load — a print run has the harness's own floor, minus the interactive permission
model that cannot exist without a human to ask. The mirror is rebuilt idempotently on every launch, so
a moved repo heals and a renamed sibling does not leave a dead link pi would skip in silence.

## The web surface (`packages/web/`)

Bun's fullstack dev server end to end — no vite, no node. The backend hosts pi in-process (one runtime
per thread, #69) and serves a TanStack AI chat client. Neither half has its own loop; the browser is a
client of the same harness the TUI runs.

**The wire is `ZenObservation`, not AG-UI (#112).** pi's events become observations (`@zen/core`) and
cross as a per-thread *follow* — one snapshot, then observations with a sequence number — while a
prompt, a stop, a dialog answer and a mode change are each one unary POST whose effect arrives on the
follow like any run's. The browser derives AG-UI in memory for TanStack's renderer; it is never on the
wire or stored. Every route is [`docs/reference/routes.md`](docs/reference/routes.md); the nouns,
lifecycles and invariants are `docs/architecture.md` → *The control plane*.

What that buys, built and running: streaming chat with tool-call rendering over one structured
payload; pi's blocking dialogs answered from the browser (#27, #112, #114) with no run parked for them
— the question and its settling both cross on the follow, so a second tab or a reload gets the same
card; a thread-stats bar (#45); mode changes as chat-adjacent lines; the URL names the thread (#142);
images on a prompt (#68), stored in the session and rendered back from the snapshot.

The dev entry (`bun run dev`) starts the API server first, then the web surface with an `/api` proxy —
deliberately ordered, since the proxy does not retry a refused connection.

## The log (#132)

One file for the harness: `.zen/logs/zen-YYYY-MM-DD.jsonl`, every process appending, one JSON record
per line, redacted by field name before it is written. Every record names what it knows —
`threadId`, `generation`, `seq`, `toolCallId` — so one thread's story reads across layers. The browser
logs to the same file (`process: browser`). The contract is [`docs/seams/logging.md`](docs/seams/logging.md);
the variables are in [`docs/reference/env-and-config.md`](docs/reference/env-and-config.md). Levels are
the knob:

```sh
ZEN_LOG_LEVEL=info    bun run dev   # default: the spine — runs, tool calls, verdicts, questions, failures
ZEN_LOG_LEVEL=debug   bun run dev   # every observation, one compact line each
ZEN_LOG_LEVEL="info,zen.server.events=trace" bun run dev   # one subtree up
```

Read it back rendered the way the terminal shows it live:

```sh
bun run logs                     # today, info and up
bun run logs --follow            # keep printing as records land
bun run logs --thread 6923e6     # one thread, by id or prefix
bun run logs --level debug --since 10m
bun run logs --json | jq …       # the matching lines raw
bun run logs bundle [--thread ID] > zen-bundle.md   # what a user hands over; reads back with --file
```

**The bundle** is one markdown file — versions, each live thread's inspection, the day's records for
the thread as JSONL, and a manifest of what was redacted (a value becomes `[REDACTED]`; the name stays,
so the reader knows what is missing). Never uploaded anywhere: the user attaches it.

## The vendored pi packages

Declared explicitly in `packages/harness/package.json` → `pi.extensions`, guards first — pi resolves
tools first-wins, so **load order is a security property** and a directory glob (which orders by
filename) is not acceptable. Riding along at exact-pinned versions:
[`@ladbabynpm/picc-permission-modes`](https://www.npmjs.com/package/@ladbabynpm/picc-permission-modes)
(Claude-Code-style permission modes — default / acceptEdits / plan / bypass — interactive runs only),
[`pi-multi-account`](https://www.npmjs.com/package/pi-multi-account), and a theme. pi loads packages
with separate module roots, so `scripts/link-vendor-packages.mjs` (postinstall) symlinks every harness
dependency into the harness's own `node_modules` — a missing one is a *silently skipped* resource, so
`zen.mjs` refuses to launch when it detects the gap.

## Repo layout

The tree, annotated, is `docs/architecture.md` → *Package structure* — and the docs gate checks that
every path it names exists. `docs/` itself: `architecture.md` (why), `glossary.md` (what a word means),
`seams/` (one page per contract, source verbatim), `reference/` (generated tables),
`verification.md` (what green means), `concepts/` (the live design notes; `concepts/archive/` the
pre-build ones).

## How this repo verifies itself

`bun run check:all` is the single source of "green" — the pre-commit hook and CI both run it: biome,
tsc, fallow (dead code against a committed baseline and the architecture boundaries as zones, #163,
#173), `bun test`, then a coverage floor over a **full denominator** — bun measures coverage only over
files a test imported, so `test/coverage-manifest.test.ts` imports every library source file to close
that hole. Every gate with its rule and allowlist, every ratchet's value, every test double and its
consumers: [`docs/reference/verification-inventory.md`](docs/reference/verification-inventory.md);
how to read it, and which proof a change needs: [`docs/verification.md`](docs/verification.md).

The working practice beneath the gate: security-relevant assertions are **mutation-tested** (break the
code, watch the test go red, revert — a test that cannot fail proves nothing); every landed change
carries **live receipts**; known gaps are **pinned as tests that identify themselves as records**;
offenders are **named, never counted**; and a doc either quotes source and is checked against it, or
is generated from source and is diffed against it (`test/docs-gate.test.ts`).

## Security posture, honestly stated

Guards here are **bars that accrete, not boundaries**. String analysis closes bounded, enumerable
classes — a new quoting trick gets fixed, cheaply — and every residual is a named test, not a hope.
What a bar cannot do (out-parse a shell, survive an interpreter) is sandboxing's job, which is the
agreed direction; a parser that claimed confinement would read as coverage and not be coverage. The
review workflow is built for this: a fresh-eyes nitpicking reviewer against a broad-scope builder,
where multiple "needs work" rounds on a security PR are the system working.

## Where this is going

The phases in [`docs/architecture.md`](docs/architecture.md): Phase 0 (the guard floor) is built and
hardened; Phase 1–2 features are landing (web chat, dialogs, stats — with the context pane, editor,
project/CI panes, memory and health still ahead); Phase 3 is the backfill, replacing vendored
extensions with our own once the feature set is whole. Work is tracked in issues; the open set is the
roadmap.
