# Dogfood Arena

An agent uses Enso through its real UI on an assignment, and a recorder outside Enso keeps the
evidence (#556). The agent is a *user* of Enso: it reaches the page only through one tool, `act`,
by what a reader of the page sees, and is told nothing about Enso's internals.

## Run

```bash
bun run arena start --agent anthropic/<model-id>   # Enso + a recorded browser + the agent under test, UI only
bun run arena start --manual        # the same run with no agent: you act over `arena act`; the boundary is not held
bun run arena brief                 # what the agent under test is told (`--manual`: the act-command version)
bun run arena act '{"action":"read"}'   # one UI action on a --manual run
bun run arena manifest <run dir>    # fold the manifest again from the timeline (after a recorder that died)
```

`start` needs one of `--agent PROVIDER/MODEL` (a model the home is logged in to, through Enso's own
login; `--thinking LEVEL`, `medium` by default) or `--manual`. It also takes `--scenario snake` (the default), `--minutes N` (the budget, 120 by default),
`--home DIR` (the `ENSO_HOME` the stack runs over: yours by default, because the agent's prompts
reach a real model with your login), `--out DIR` (`ENSO_HOME/arena` by default), `--chromium PATH`
and `--headed`. Ports 5178 and 5179 must be free: the arena starts its own stack.

With `--agent`, the run starts the agent under test itself and stops when the agent stops it, ends
without stopping (after three nudges), or runs out of budget. Do not prescribe its features or
script its failures.

## The UI-only boundary (#584)

The agent runner (`agent.ts`) is a pi `Agent` over a bare model call, given the brief and **one
tool, `act`**. It has no shell, no file access and no web: a call to any other tool is answered
"Tool … not found" with nothing run, and is recorded as `agent-tool-refused`. `act` hands the action
to the recorder in the same process. So the agent can't write the project's files itself, can't
reach Enso's API, and can't read Enso's source. The work gets done only by using Enso through its page.

While an agent drives, the control endpoint is **not served**: `bun run arena act` is refused, so
nothing with a shell can act as the agent. Every action and note on the timeline carries `via`
(`agent` or `control`), and a refused action (`goto /api/…`, a selector) is recorded too. The
manifest's `boundary` is computed from the timeline, not asserted: `held` is true only when the
agent was given exactly `act` and every action came through it. A `--manual` run is always
`held: false`.

What it does not bound is Enso's own agent. The agent under test can ask Enso, through the prompt box,
to run anything Enso's permissions allow. That is using the product: it goes through the UI and is
in Enso's records.

## What a run leaves

`<out>/<scenario>-<time>/`:

| Path | What |
|---|---|
| `project/` | the fresh git repository the agent worked in: the application outcome |
| `timeline.jsonl` | one line per event, wall clock + elapsed + URL + the thread the URL names |
| `screenshots/` | one every 30 s (`sample`), plus one per error, dialog, navigation, failed action, Enso exit |
| `trace/trace-NNN.zip` | the Playwright trace in five-minute chunks (`bunx playwright show-trace <zip>`) |
| `enso/stack.log` | Enso's own output, redacted |
| `enso/evidence/` | what the server holds for each thread the UI named, the log bundle, Stats |
| `agent/transcript.jsonl` | the agent under test's own transcript (`--agent`), redacted, image bytes left out |
| `manifest.json` | the fold: what drove the run and whether the boundary held, screenshot index, threads with their time spans, actions, observed signals, the agent's notes, and every piece of Enso evidence as `collected` or `missing` with why |

The thread id on a timeline line is the id `bun scripts/enso-thread.ts`, `/api/logs/bundle?thread=`
and the session file are keyed by: that is the jump from a screenshot to its turn.

## What holds, and where it stops

- **The recorder is not Enso.** Enso is its child; an Enso exit is recorded, sampling continues, and
  the agent may `restart-enso`. The timeline and screenshots are on disk as they happen; a trace is
  lost at most one chunk at a time.
- **Every UI action goes through the recorder**, so each is in the trace (as a named group) and on the
  timeline. There is no selector, no `evaluate`, and `goto` refuses `/api`.
- **The agent has no shell** under `--agent` (above). Under `--manual` it is whatever you give it, and
  the manifest says the boundary was not held.
- **Secrets.** Typed text that looks like a credential is refused, not typed: what is typed is in the
  trace's DOM snapshots and on screenshots, and a PNG cannot be scrubbed. Text the recorder writes
  (timeline, Enso's output, evidence) is redacted with the home's known secret values. A secret Enso
  itself puts on screen is not scrubbed from screenshots or the trace.
- **The agent's notes are observations, not findings.** The manifest keeps them apart from what the
  recorder observed. Verifying a gap, and the triaged findings report, is a reviewer's step after the
  run; the agent under test certifies nothing.
- **Not collected yet:** the Diff Viewer's data (no read route for a run). The snapshot store (#551)
  is recorded when it exists, and marked missing when it does not.
