# Enso

**Give agents room to work. Keep the receipts.**

**Enso is an evidence-driven control plane for coding agents.** Built around
[pi](https://github.com/earendil-works/pi), it makes the system behind an agent's work visible: what it
knew, what it did, what changed, what was refused, and what evidence remains afterward.

New here? Read this page, then [the architecture](docs/architecture.md). Everything else is linked
from those two, and the whole set is browsable at
**[the docs site](https://dopamine911.github.io/zen-harness-foundation/)**.

---

## Trust, then verify

Enso starts from a simple assumption: neither the human nor the agent should be treated as automatically correct.

Coding agents are remarkably capable. Give them room to work. But capability is not certainty, and an instruction is not the same thing as shared understanding.

Humans communicate with a great deal left unsaid. When you ask another engineer to “clean this up,” “fix the bug,” or “make this safe,” you bring assumptions about the codebase, acceptable tradeoffs, conventions, and the outcome you intended. An agent may not share those assumptions.

There is an old joke about making a wish to a genie: the wording is satisfied perfectly, just not in the way you meant. Agents can fail in a similar way. They may follow the **letter of an instruction while missing its spirit** — not because they are trying to work around you, but because the instruction and the intended outcome were not actually the same thing.

More prompting does not eliminate that gap. Sometimes the human's assumption is wrong. Sometimes the agent's interpretation is wrong. Sometimes both are reasonable until reality provides contradictory evidence.

Enso is built around making that disagreement visible. Guards constrain known failure paths. Observations and logs show what actually happened. Mechanical checks test claims against reality. History gives you somewhere to look when the outcome and the intent diverge.

**I check your work. You check mine. The system keeps the receipts.**

Trust is useful. Verification is how that trust stays grounded.

---

## The problem

Coding agents are useful because they can act. They read files, edit code, run commands, call tools and make decisions across many steps without requiring the human to approve every movement.

That capability is also where uncertainty enters.

A task can be interpreted differently than you intended. A reasonable command can have effects outside the workspace. An agent can follow the instruction you wrote while missing an assumption you never wrote down. And once enough tools, commands and intermediate decisions are involved, reconstructing *why* something happened becomes difficult without a record.

pi makes this especially visible because it deliberately ships with an unrestricted `bash` tool and no confinement of its own. Out of the box, an agent can:

- read `~/.aws/credentials` or SSH keys and place them in its context;
- append a line to `~/.bashrc` that runs the next time you open a terminal;
- `curl` your repository to a host on the internet.

None of those actions are inherently distinguishable from legitimate work at the tool level. The important question is not only **“can the agent do this?”** but also **“should it, why did it, and can we prove what happened?”**

Enso addresses that problem in layers:

| | |
|---|---|
| **Constrain known failure paths** | Guards refuse specific classes of actions before they run. |
| **Make important boundaries explicit** | Network egress, filesystem access and other behaviors are governed by rules that fail loudly instead of silently guessing. |
| **Preserve evidence** | Logs and observations record what happened so behavior can be inspected instead of reconstructed from memory. |
| **Keep the limits visible** | Known gaps are documented and tested rather than being hidden behind a claim of confinement. |

Enso is not a sandbox, and these layers are not a guarantee of containment. They reduce some classes of risk and increase your ability to understand the rest.

---

## How Enso is structured

Enso is built around a small set of architectural choices. They are less about prescribing a particular implementation style and more about deciding what Enso should own, what it should reuse, and where evidence should come from.

### One loop, multiple surfaces

pi owns the agent loop.

It talks to the model, executes tools, manages the conversation and produces the runtime events Enso observes. Enso does not create a second agent loop in the browser, backend or a worker.

Instead, Enso builds around the same runtime. Guards, observations, logging, web access, permission handling and the browser surface all attach to pi's execution path.

That gives the terminal and browser the same source of truth. A feature should be implemented once against the runtime and then appear wherever the agent is being used.

**One loop. Multiple surfaces.**

### Use what works. Own what is different.

Enso composes onto a pinned release of pi rather than maintaining its own fork.

That is a deliberate ownership boundary, not a statement that forks are inherently wrong. Forking a project means accepting responsibility for more of the stack: upstream changes, integrations, compatibility, fixes and the growing distance between the two codebases. Sometimes that tradeoff is worth making.

Enso chooses to spend its engineering budget elsewhere.

pi already provides a capable agent loop, tool execution, model interaction and session management. Recreating those pieces would increase the amount of software Enso has to understand, test and maintain without addressing the parts of the problem that are still missing.

Enso spends that attention on observation, controls, evidence, verification, human intervention and the interfaces around the agent.

Every part of the stack we own has a cost. The goal is to own the parts where Enso adds something meaningfully different.

**Use what works. Own what is different.**

### The repository carries its own context

Much of Enso is implemented and reviewed by agents working in separate sessions. They cannot depend on the shared memory, unwritten conventions and informal knowledge that gradually accumulate inside a human team.

Important assumptions therefore need somewhere durable to live.

Vocabulary belongs in the glossary. Architectural boundaries belong in rules and gates. Contracts belong at seams. Known limitations become explicit tests. Repository-wide invariants are checked mechanically. Changes carry evidence that the behavior actually ran.

This is not documentation for its own sake. It is an attempt to make the intended shape of the system recoverable by the next person or agent that encounters it.

A change should not depend on someone remembering why a boundary exists. The repository should provide enough context and evidence to rediscover the reasoning.

**The repository carries the context that would otherwise live in people's heads.**

### Prefer evidence over inference

Enso tries not to infer important state when that state can be observed directly.

If a behavior can produce a record, preserve the record. If a claim can be checked mechanically, check it. If a transition matters, make it visible. If a limitation is known, name it rather than allowing the surrounding system to imply that it does not exist.

This principle shapes the observation model, logs, verification gates, runtime state and the way failures are investigated.

It also shapes how humans and agents work together. When their interpretations disagree, the most useful next step is often not more explanation. It is fresh evidence: a test, a log record, a counterexample, a reproduced failure or another mechanical check against reality.

**Prefer evidence over inference.**

### Keep the human close to the system

Enso is not designed around removing the human from the engineering process.

Agents should have enough room to do useful work, but the system should preserve the places where human judgment matters: understanding unexpected behavior, changing conditions, resolving ambiguity and deciding what should happen next.

The goal is not constant approval prompts or a tighter leash. It is to make intervention possible when it is useful and unnecessary when the system already has enough evidence to proceed.

That is why Enso separates observation from control. First understand what happened. Then decide whether anything should change.

The human and the agent are working on the same system from different strengths.

**Give the agent room to work. Keep the human able to understand and intervene.**

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
| `PI_CODING_AGENT_DIR=~/.enso/pi-agent` | Your global pi packages, settings and credentials are invisible to this run. |
| `--no-extensions` | pi's own discovery, which would otherwise load this repo's package a second time. |
| `--no-skills` | Skills discovered from `~/.agents/skills/`, which the agent-dir redirect does not cover. |

⚠ **An exported `ANTHROPIC_API_KEY` does not reach pi.** Enso deletes every secret-shaped environment
variable before spawning and tells you which on stderr. Provider credentials belong in pi's own
`auth.json`, so run `/login` once **in the terminal** (`bun run enso`) — it is one of pi's TUI
commands, and the server refuses any slash command the runtime does not offer rather than passing
it to the model as text. The grant is per agent dir and both surfaces share it: log in once, and
`bun run dev` uses the same credentials. The rule lives in
[`packages/core/src/secrets.ts`](packages/core/src/secrets.ts).

---

## How the pieces fit

Enso sits around pi rather than replacing it. pi remains responsible for the agent loop; Enso adds
layers that make that loop easier to observe, constrain and investigate.

```text
                          model
                            ▲
                            │
                    ┌──── pi runtime ────┐
                    │                    │
             terminal surface      web surface
                    │                    │
                    └──── Enso layers ───┘
                             │
               guards · observations · dialogs
                web access · logging · config
                             │
                          ~/.enso/
                    state · logs · pi auth
```

The terminal and browser are different surfaces over the same architecture, not separate agent
implementations. The web server hosts a pi runtime per thread; the terminal launches pi directly.
Enso-owned behavior attaches to pi's events and tools so the important rules and observations do not
have to be reimplemented for each interface.

The pieces below do different jobs. Some reduce what the agent can do through known paths. Some make
important behavior explicit. Others preserve evidence so a human or agent can understand what
actually happened later. None of them should be mistaken for a complete containment boundary.

### Guards — bounded constraints on known paths

One handler on pi's `tool_call` event applies the guard suite before a tool runs. The guards are
additive: event handlers all run, and the first block is final regardless of extension load order.
In precedence order they enforce:

1. **A fail-closed policy floor** — tool names are canonicalised and checked against pi's live tool
   list; a mismatch denies everything rather than guessing.
2. **Bash policy**, in two layers: a pinned `cc-safety-net` library, then the network egress deny.
3. **Write confinement** to the workspace, with known persistence vectors such as shell profiles and
   autostart refused.
4. **A read gate by exclusion** — every tool carrying a `path` is treated as a reader, so a new tool is
   guarded when it appears rather than when someone remembers to add it.
5. **Read-before-write** and **stale-write** detection.

These guards close specific, known classes of behavior. They are not presented as proof that the
machine is isolated. Contract, fakes and gate: [`docs/seams/guards.md`](docs/seams/guards.md).

### Network access — make the path explicit

Network-capable commands such as `curl`, `wget`, `nc` and `ssh` are refused inside `bash`, matched per
shell segment at command position with quoting resolved to the literal the shell would execute. When
one is refused, the agent is pointed toward Enso's explicit web path instead of receiving only a
block.

The important part is also what this mechanism **does not** claim to catch. `git` remotes,
interpreters and indirection across calls remain known gaps, and those gaps are represented as tests.
The mechanism therefore documents its coverage instead of implying confinement. See the header of
`packages/harness/core/network-egress.ts`.

`web_fetch` reads a URL only when its host appears in the allowlist in your config,
`~/.enso/config.json`. The list is empty by default. A refusal names the file, shows the exact JSON
required to add the host, and leaves that policy change to the human.

That choice is intentional. In a survey of 1,753 reviews, 99.2% of approval prompts were accepted. A
prompt that is almost always approved provides little policy signal; an allowlist in a file makes the
boundary inspectable and durable.

`web_search` uses the current model's own search API, billed to the identity the conversation already
uses, with a Tavily fallback that activates only when `TAVILY_API_KEY` is present. Secrets do not go
in the config file.

Details: [`docs/seams/web-providers.md`](docs/seams/web-providers.md).

### Configuration — fail loudly instead of guessing

Your `~/.enso/config.json` (`ENSO_HOME/config.json`) is the configuration surface: one file, one
section per consumer, schema-validated. Enso ships no config file: without one, every section is its
default — no project roots, nothing fetchable, the default search routing. For example:

```json
{
  "webFetch": { "allowedHosts": ["docs.example.com"] },
  "projects": { "roots": ["~/code"] }
}
```

A project can add its own `.enso/config.json`, read over yours — its lists add to yours, its values
win — but **only once you trust the project**, with pi's own trust decision: the first session in an
undecided project asks (Trust, Trust parent folder, this session only, or not), the answer is saved
in pi's `trust.json`, and the same answer covers the project's `.pi/`. An untrusted project's file is
skipped, and the thread says so. `projects.roots` stays yours: a project cannot set it.

Its loading contract is deliberately strict:

- unreadable configuration is not treated as "no policy";
- unknown keys are rejected so a typo cannot silently configure nothing;
- a checkout never supplies a session's policy on its own say-so — a project's file is read only
  once the project is trusted, and never from its parent folders.

The goal is not more configuration. It is to make the configuration that matters explicit and
inspectable.

### Non-interactive runs — keep the distinction visible

The permission-modes extension fails closed when it cannot ask a human. A `-p` non-interactive run
under the full package could therefore continue chatting while being unable to perform work that
requires interaction.

Enso materialises a **print variant** under `node_modules/.cache/enso/print-harness/`: the same package minus that one
interactive extension, with everything else symlinked into place. The distinction is explicit rather
than silently changing how the permission model behaves when no human is present.

### The web surface — observations are the contract

The web stack is Bun end to end. The backend hosts pi in-process, one runtime per thread, and serves a
TanStack AI chat client.

The wire contract is `EnsoObservation`, not AG-UI. pi events become observations, and a browser tab
*follows* a thread: one snapshot followed by observations with sequence numbers. Prompt, stop, dialog
answer and mode-change requests are POSTs whose effects return through that same observation stream.
A second tab or a reload therefore reconstructs state from the same evidence rather than from a
separate browser-side agent model.

AG-UI is derived in the browser for rendering; it is neither the canonical wire format nor stored
state.

Working today: streaming chat with tool-call rendering, pi's blocking dialogs answered from the
browser, a thread-stats bar, permission-mode changes represented as chat lines, thread identity in the
URL, and image attachments. Routes: [`docs/reference/routes.md`](docs/reference/routes.md).

### The log — keep the receipts

Enso writes one JSONL log per day at `~/.enso/logs/enso-YYYY-MM-DD.jsonl`. Every process appends records
to it, with sensitive values redacted by field name before they are written. Records carry
`threadId`, `generation`, `seq` and `toolCallId`, allowing one thread's behavior to be followed across
layers. The browser writes to the same log.

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

A **bundle** collects versions, each live thread's inspection, the day's records and a manifest of
what was redacted into one markdown file. Redacted values become `[REDACTED]` while their names remain,
so missing evidence is visible rather than silently omitted. Nothing is uploaded automatically; you
choose whether and where to share the bundle.

---

## How this repo proves it works

`bun run check:all` is the only definition of green. The pre-commit hook and CI both run exactly it —
**ten steps, stopping at the first failure**:

| # | Step | What it does |
|---|---|---|
| 1 | `format` | formatting, import order and Tailwind class order (oxfmt) |
| 2 | `lint` | oxlint, type-aware, with this repo's naming rules |
| 3 | `typecheck` | `tsc -b` across every package |
| 4 | `dead-code` | unused files, exports and dependencies, against a committed baseline |
| 5 | `complexity` | every function under a cognitive ceiling of 25, or under its own pin (fallow) |
| 6 | `react-doctor` | react-doctor over the web surface, offline, failing on an error-severity finding |
| 7 | `test` | the whole suite |
| 8 | `coverage` | line and function floors over *every* source file, not just imported ones |
| 9 | `api-docs` | TypeDoc over the public contracts, with warnings fatal |
| 10 | `site` | builds the docs site and crawls every built page for dead links |

Twenty-one of those tests are **gates**: tests about the source tree rather than about behaviour — "no
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

State the agent and the tools use lives in your `ENSO_HOME` — `~/.enso` unless you set `ENSO_HOME` —
not in the checkout: logs, secrets, pi's auth and sessions, the project list. Every checkout and
worktree shares it. A checkout from before #421 has its `.enso/` moved there on the next launch; a
file `~/.enso` already holds is never overwritten, and the launch names what it left behind.

---

## Where this is going

The foundation is about making agent behavior observable, constrained where appropriate, and mechanically inspectable.

The next step is to make that evidence useful while the work is happening.

Enso is moving toward a debugging environment for coding-agent sessions: not just a chat transcript, but a view of the system that produced the result.

Planned areas include:

- **Session dashboards** — thread state, tool activity, timing, cost, denials, retries, failures and other operational signals in one place.
- **Context inspection** — see what context the agent is carrying, where it came from and how much of the session it consumes.
- **Context pruning and replacement** — remove stale, irrelevant or misleading context instead of trying to talk around it.
- **Session diagnostics and alerts** — surface patterns that may deserve attention, such as repeated failures, unusual retries, contradictions, growing context pressure or unexpected behavior.
- **Session lineage** — preserve the relationship between an original run and the attempts that branch from it.
- **Rewind and reattempt** — return to an earlier point, change one or more conditions and rerun from there without losing the history of the original path.
- **Comparative evidence** — compare branches to see how a different model, context, rule, skill or intervention changed the outcome.

The goal is not to decide whether a session was simply “good” or “bad.” It is to make enough of the system visible that you can understand where behavior changed, what conditions were present, and what happened when those conditions changed.

The working loop is:

```text
observe
→ diagnose
→ locate divergence
→ rewind
→ change conditions
→ reattempt
→ compare
```

A coding agent already knows how to produce software. Enso is becoming the place where you debug the system around that agent.

Work is tracked in issues; the open set is the roadmap.
