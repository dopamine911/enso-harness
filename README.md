# Enso

**Enso makes it safe to let a coding agent loose on your machine.**

It is a package for [pi](https://github.com/earendil-works/pi), a small, excellent coding agent. pi
runs the conversation: it talks to the model, calls tools, keeps sessions. Enso adds the part pi
deliberately leaves out — a floor of rules about what the agent may actually *do* — plus a web app and
a terminal launcher to work with.

New here? Read this page, then [the architecture](docs/architecture.md). Everything else is linked
from those two, and the whole set is browsable at
**[the docs site](https://dopamine911.github.io/zen-harness-foundation/)**.

---

## The problem

pi ships with an unrestricted `bash` tool and no confinement of any kind. That is a deliberate choice
by its authors, and out of the box it means an agent can:

- read `~/.aws/credentials`, or your SSH keys, and put them in its own context;
- append a line to `~/.bashrc` that runs next time you open a terminal;
- `curl` your repository to any host on the internet.

Nothing in pi distinguishes any of that from fetching a public document. For a tool you leave running
while you make coffee, that is the whole ballgame.

Enso is the layer that makes it survivable:

| | |
|---|---|
| **A floor that is always on** | Every tool call passes a guard before it runs. Deny is final. |
| **Egress you can point at** | Network clients are refused in `bash`; there is one sanctioned way out, with an allowlist you commit to the repo. |
| **An audit trail** | One log, one line per event, redacted as it is written — so *what the agent did* is answerable afterwards. |

What Enso is **not**: a sandbox. It is string analysis over commands, which closes specific,
enumerable holes and says plainly where it stops. More on that under
[Security, honestly](#security-honestly).

---

## Two rules that explain the rest of the design

**1. pi owns the loop. There is no second agent.** Every temptation to build a competing loop — in the
web backend, in a worker, in the chat UI — is refused. Features are written **once**, as pi
extensions, and work in both the terminal and the browser, because they talk to pi's event and tool
APIs and never to a user interface.

**2. A package, never a fork.** Enso composes onto a pinned release of pi. A fork entangles: you
inherit every upstream change and your own features get harder to lift out each month. (The
cautionary tale is `oh-my-pi`, which forked — which is exactly why its features are hard to reuse.)

There is also a third fact that shapes how the code is written: **this repository is built and
reviewed largely by agents**, in sessions that share no memory. So the things that would normally live
in a team's heads live in tests instead — the *gates* — and every landed change carries a real run as
evidence, not just a green suite.

---

## Quick start

```bash
bun install          # links the vendored pi packages into the harness
bun run enso         # start pi in your terminal, with Enso loaded
bun run dev          # the web app: API on :5179, app on :5178
bun run check:all    # the gate — everything CI runs, in one command
bun run logs         # read today's log, rendered
```

### What `bun run enso` actually does

It starts **vanilla pi with only Enso loaded**, and isolates it three ways — each closing a different
hole:

| Mechanism | What it stops |
|---|---|
| `PI_CODING_AGENT_DIR=.enso/pi-agent` | Your global pi packages, settings and credentials are invisible to this run. |
| `--no-extensions` | pi's own discovery, which would otherwise load this repo's package a second time. |
| `--no-skills` | Skills discovered from `~/.agents/skills/`, which the agent-dir redirect does not cover. |

⚠ **An exported `ANTHROPIC_API_KEY` does not reach pi.** Enso deletes every secret-shaped environment
variable before spawning and tells you which on stderr. Provider credentials belong in pi's own
`auth.json`, so run `/login` once inside the scratch agent dir. The rule lives in
[`packages/core/src/secrets.ts`](packages/core/src/secrets.ts).

---

## How the pieces fit

```
     you                                     the model
      │                                          ▲
      ▼                                          │
 terminal (bun run enso)  ──┐            ┌──  pi's loop
                            ├─►  pi  ◄───┤
 browser (bun run dev)    ──┘            └──  Enso's extensions
                                                  │
                                    guards · web_fetch · web_search · logging
                                                  │
                                            .enso/  (state: logs, secrets, pi auth)
```

Both surfaces are clients of the same pi running the same extensions. Nothing in the browser has its
own agent loop.

### The guard suite — the always-on floor

One handler on pi's `tool_call` event. It is **additive**: pi resolves *tools* first-wins, so a guard
written as a tool override is only safe while it loads first — but event handlers all run, and the
first block is final regardless of load order. In precedence order it enforces:

1. **A fail-closed policy floor** — tool names are canonicalised and checked against pi's live tool
   list; a mismatch denies *everything* rather than guessing.
2. **Bash policy**, in two layers: a pinned `cc-safety-net` library, then the network egress deny.
3. **Write confinement** to the workspace, with persistence vectors (shell profiles, autostart) refused.
4. **A read gate by exclusion** — every tool carrying a `path` is treated as a reader, so a new tool is
   guarded on the day it appears rather than the day someone remembers it.
5. **Read-before-write** and **stale-write** detection.

Contract, fakes and gate: [`docs/seams/guards.md`](docs/seams/guards.md).

### The network egress deny — a bar, not a boundary

`curl`, `wget`, `nc`, `ssh` and friends are refused inside `bash`, matched per shell segment at
command position, with quoting resolved to the literal the shell would actually run. The refusal
points the model at the sanctioned path instead of just saying no.

Everything it **cannot** catch — `git` remotes, interpreters, indirection across calls — is a test
that says so out loud. That way the file reads as a record of coverage, never as a promise of
confinement. See the header of `packages/harness/core/network-egress.ts`.

### `web_fetch` and `web_search` — the sanctioned way out

`web_fetch` reads a URL **only if its host is on an allowlist you committed** to
[`enso.config.json`](enso.config.json). The list is empty by default. When a fetch is refused, the
message names the file, shows the exact JSON to add, and says the change is a human's to make.

Why an allowlist and not a prompt? Because the measured record says approval prompts do not carry
policy: in a survey of 1,753 reviews, 99.2 % were approved. A prompt people always accept is not a
control. An allowlist that grows from real denials is.

`web_search` uses the *current model's own* search API, billed to the identity the conversation
already uses, with a Tavily fallback that arms itself only if `TAVILY_API_KEY` is present — a key is a
secret, and secrets never go in the committed file.

Details: [`docs/seams/web-providers.md`](docs/seams/web-providers.md).

### `enso.config.json` — one config file

One committed file, one section per consumer, schema-validated, with a loading contract every future
section inherits:

- parsing fails **closed** — "unreadable" is never treated as "no policy";
- unknown keys are **rejected** — a typo refuses loudly instead of silently configuring nothing;
- it is found from Enso's own tree, never the directory you happen to be in, so another checkout's
  config can never become this session's allowlist.

### The print variant

The permission-modes extension fails closed when it cannot ask a human — so a `-p` (non-interactive)
run under the full package could chat and do nothing else. Enso therefore materialises a **print
variant** under `.enso/print-harness/`: the same package minus that one extension, everything else
symlinked into place. A print run keeps the guard floor; it loses only the interactive permission
model, which cannot function with nobody to ask.

### The web surface

Bun's fullstack server end to end — no vite, no node. The backend hosts pi in-process (one runtime per
thread) and serves a TanStack AI chat client.

**The wire is `EnsoObservation`, not AG-UI.** pi's events become observations, and a browser tab
*follows* a thread: one snapshot, then observations with sequence numbers. A prompt, a stop, a dialog
answer and a mode change are each one POST whose effect comes back on the follow — so a second tab, or
a reload, sees exactly the same thing. AG-UI is derived in the browser for the renderer; it is never
on the wire and never stored.

Working today: streaming chat with tool-call rendering, pi's blocking dialogs answered from the
browser, a thread-stats bar, permission-mode changes as chat lines, the thread id in the URL, and
image attachments. Routes: [`docs/reference/routes.md`](docs/reference/routes.md).

### The log

One file for everything: `.enso/logs/enso-YYYY-MM-DD.jsonl`. Every process appends to it, one JSON
record per line, redacted by field name *before* it is written. Records carry `threadId`,
`generation`, `seq` and `toolCallId`, so one thread's story can be read across layers. The browser
logs to the same file.

```sh
ENSO_LOG_LEVEL=info  bun run dev    # default: runs, tool calls, verdicts, questions, failures
ENSO_LOG_LEVEL=debug bun run dev    # every observation, one compact line each
ENSO_LOG_LEVEL="info,enso.server.events=trace" bun run dev   # one subsystem up, the rest at info

bun run logs                        # today, rendered as the terminal shows it live
bun run logs --follow               # keep printing as records land
bun run logs --thread 6923e6        # one thread, by id or prefix
bun run logs --json | jq …          # the raw matching lines
bun run logs bundle > enso-bundle.md
```

A **bundle** is one markdown file — versions, each live thread's inspection, the day's records, and a
manifest of what was redacted (values become `[REDACTED]`; names stay, so you know what is missing).
Nothing is uploaded anywhere; you attach it yourself.

---

## How this repo proves it works

`bun run check:all` is the only definition of green. The pre-commit hook and CI both run exactly it —
**seven steps, stopping at the first failure**:

| # | Step | What it does |
|---|---|---|
| 1 | `biome` | lint, format, import order, and this repo's naming rules |
| 2 | `typecheck` | `tsc -b` across every package |
| 3 | `dead-code` | unused files, exports and dependencies, against a committed baseline |
| 4 | `test` | the whole suite |
| 5 | `coverage` | line and function floors over *every* source file, not just imported ones |
| 6 | `api-docs` | TypeDoc over the public contracts, with warnings fatal |
| 7 | `site` | builds the docs site and crawls every built page for dead links |

Twenty of those tests are **gates**: tests about the source tree rather than about behaviour — "no
production `console.*`", "every documented export is grouped", "every diagram parses". Each one names
its offenders rather than counting them, so the failure message is the fix.

The practices underneath, which are worth copying:

- **Mutation-test the important assertions.** Break the code, watch the test go red, revert. A test
  that cannot fail proves nothing — and several in this repo were found to be exactly that.
- **Name gaps as tests.** A known limitation is a passing test that documents it, not a comment.
- **Docs are checked, not trusted.** Every page either quotes source and is diffed against it, or is
  generated from source. A code fence that drifts fails the gate.
- **Receipts, not claims.** A change lands with a real run attached.

Full detail: [`docs/verification.md`](docs/verification.md) (how to read it) and
[`docs/reference/verification-inventory.md`](docs/reference/verification-inventory.md) (every gate,
generated).

---

## Security, honestly

Enso's guards are **bars that accrete, not boundaries**.

String analysis can close bounded, enumerable classes of trouble — a new quoting trick gets fixed
cheaply — and every residual hole is a named test rather than a hope. What a bar fundamentally cannot
do is out-parse a shell or survive an interpreter; that is sandboxing's job, and sandboxing is the
agreed direction. A parser claiming confinement would read as coverage without being coverage, which
is worse than nothing.

So: run Enso when you want an agent that cannot casually wander off. Do not run it as though the
machine were isolated. It isn't yet.

---

## Where to read next

In the order that makes sense if you are new:

1. [`docs/architecture.md`](docs/architecture.md) — the founding stance, the seams, the phases.
2. [`docs/glossary.md`](docs/glossary.md) — one word, one meaning. Worth skimming *before* the code.
3. [`docs/seams/`](docs/seams/README.md) — 11 pages, one per contract, quoting the source verbatim.
4. [`docs/flows/`](docs/flows/README.md) — 8 pages: what happens, step by step, when you send a prompt
   or a tool gets blocked.
5. [`docs/reference/`](docs/reference/README.md) — 7 generated tables: routes, observations, exports,
   environment, decisions, verification, flows.

The same content, with search and the generated API reference, is at
**[the docs site](https://dopamine911.github.io/zen-harness-foundation/)**.

---

## Repo layout

```
packages/core/       schemas and shared contracts (@enso/core)
packages/harness/    the pi package: extensions (guards, web_fetch, web_search, logging) + core helpers
packages/web/        the web surface — Bun server hosting pi, plus the browser app
scripts/             launchers, the gate, the docs generators   (all TypeScript, no exceptions)
docs/                architecture, glossary, seams, flows, generated reference
site/                the Starlight docs site — a projection of docs/, never a second copy
test/                repo-wide gates
```

State the agent and the tools use lives in `.enso/` (logs, secrets, pi's auth) and is gitignored.

---

## Where this is going

Phase 0 — the guard floor — is built and hardened. Phases 1–2 are landing now: web chat, dialogs and
stats are working; the context pane, editor, project/CI panes, memory and health are still ahead.
Phase 3 is the backfill, replacing vendored extensions with our own once the feature set is whole.

Work is tracked in issues; the open set is the roadmap.
