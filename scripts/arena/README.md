# Dogfood Arena

An agent uses Enso through its real UI on an assignment, and a recorder outside Enso keeps the
evidence (#556). The agent is a *user* of Enso: it reaches the page only through `bun run arena act`,
by what a reader of the page sees, and is told nothing about Enso's internals.

## Run

```bash
bun run arena start                 # Enso over a fresh project + a recorded browser; runs until a stop condition
bun run arena brief                 # the agent's prompt (also written to <run>/brief.md by start)
bun run arena act '{"action":"read"}'   # one UI action on the live run, as the agent
bun run arena manifest <run dir>    # fold the manifest again from the timeline (after a recorder that died)
```

`start` takes `--scenario snake` (the default), `--minutes N` (the budget, 120 by default),
`--home DIR` (the `ENSO_HOME` the stack runs over: yours by default, because the agent's prompts
reach a real model with your login), `--out DIR` (`ENSO_HOME/arena` by default), `--chromium PATH`,
`--repo OWNER/NAME` (where the agent files bugs: the checkout's GitHub `origin` by default) and
`--headed`. Ports 5178 and 5179 must be free: the arena starts its own stack.

## The agent's prompt

`start` writes `<run>/brief.md` and prints where it is: hand that file to the agent under test.
It names this run's directory, the exact `act` command (with `--out` when you gave one) and the
repository, and asks for three phases, in order:

1. **The assignment**, through `act` only: no reading Enso's source, calling its API or opening its
   files. Wishes and friction are noted as they happen; a retrospective and `stop` end it.
2. **A review** in `<run>/review.md`, written against the run's evidence (manifest, timeline,
   screenshots, Enso's records), each point citing an `elapsedMs`, a screenshot or a thread id: the
   application outcome kept apart from Enso; the session; each piece of friction, classified as an
   Enso defect, something undiscoverable, the agent's own mistake, or not needed; recommendations,
   most valuable first.
3. **Bugs** for the defects only: existing issues searched first (a match gets a comment with the
   evidence), new ones titled `[dogfood-arena] …` with reproduction, expected, impact, observed vs
   inferred, evidence and workaround, and marked as not yet verified by a person.

`bun run arena brief` prints the same prompt without a run (`--run`, `--out`, `--repo` fill it in).

Do not add to the prompt what to build or where it should fail: the features, the approach and
the trouble are the agent's.

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
| `manifest.json` | the fold: screenshot index, threads with their time spans, actions, observed signals, the agent's notes, and every piece of Enso evidence as `collected` or `missing` with why |

The thread id on a timeline line is the id `bun scripts/enso-thread.ts`, `/api/logs/bundle?thread=`
and the session file are keyed by: that is the jump from a screenshot to its turn.

## What holds, and where it stops

- **The recorder is not Enso.** Enso is its child; an Enso exit is recorded, sampling continues, and
  the agent may `restart-enso`. The timeline and screenshots are on disk as they happen; a trace is
  lost at most one chunk at a time.
- **Every UI action goes through the recorder**, so each is in the trace (as a named group) and on the
  timeline. There is no selector, no `evaluate`, and `goto` refuses `/api`.
- **Not held here: the agent's own shell.** An agent that can run `curl` can reach the API on
  loopback. The prompt forbids it; nothing enforces it, so the review's evidence is what shows a
  run that left the UI.
- **Secrets.** Typed text that looks like a credential is refused, not typed: what is typed is in the
  trace's DOM snapshots and on screenshots, and a PNG cannot be scrubbed. Text the recorder writes
  (timeline, Enso's output, evidence) is redacted with the home's known secret values. A secret Enso
  itself puts on screen is not scrubbed from screenshots or the trace.
- **The agent's account is not proof.** The manifest keeps its notes apart from what the recorder
  observed; its review must cite the evidence for each point, and every bug it files says it is
  unverified and names the run. Verifying those, and triaging the filed bugs, stays a person's step.
- **Not collected yet:** the Diff Viewer's data (no read route for a run). The snapshot store (#551)
  is recorded when it exists, and marked missing when it does not.
