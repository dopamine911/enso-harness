# Dogfood Arena

An agent uses Enso through its real UI on an assignment, and a recorder outside Enso keeps the
evidence (#556). The agent is a *user* of Enso: it reaches the page only through one tool, `act`,
by what a reader of the page sees, and is told nothing about Enso's internals.

## Run

```bash
bun run arena start --agent anthropic/<model-id>   # Enso + a recorded browser + the agent under test, UI only
bun run arena start --manual        # the same run with no agent: you act over `arena act`; the boundary is not held
bun run arena brief                 # what the agent under test is told (`--manual`: the act-command version, review and bugs included)
bun run arena brief --review --run <run dir>   # the review and bug-filing prompt for after an --agent run
bun run arena act '{"action":"read"}'   # one UI action on a --manual run
bun run arena manifest <run dir>    # fold the manifest again; after a recorder that died, collect Enso's evidence too
bun run arena score <run dir>       # score a run again: its logs read for problems, and whether the UI was used
```

`start` needs one of `--agent PROVIDER/MODEL` (a model the home is logged in to, through Enso's own
login; `--thinking LEVEL`, `medium` by default) or `--manual`. It also takes `--scenario snake` (the default), `--minutes N` (the budget, 120 by default),
`--home DIR` (the `ENSO_HOME` the stack runs over: yours by default, because the agent's prompts
reach a real model with your login), `--out DIR` (`ENSO_HOME/arena` by default), `--chromium PATH`,
`--repo OWNER/NAME` (where bugs are filed: the checkout's GitHub `origin` by default) and
`--headed`. Ports 5178 and 5179 must be free: the arena starts its own stack.

With `--agent`, the run starts the agent under test itself and stops when the agent stops it, ends
without stopping (after three nudges), or runs out of budget. Do not prescribe its features or
script its failures.

## The review and the bugs

After the run, the experience is reviewed against its evidence and the Enso defects it shows are
filed (`arenaReviewBrief` in `src/scenario.ts`):

- **The review**, in `<run>/review.md`. It is written against the run's evidence (manifest,
  timeline, screenshots, Enso's records), and each point cites an `elapsedMs`, a screenshot or a
  thread id. It covers the application outcome, kept apart from Enso; the session; each piece of
  friction, classified as an Enso defect, something undiscoverable, the agent's own mistake, or not
  needed; and recommendations, most valuable first.
- **The bugs**, for the defects only. Existing issues are searched first, and a match gets a comment
  with the evidence. New issues are titled `[dogfood-arena] …` with reproduction, expected, impact,
  observed vs inferred, evidence and workaround, and are marked as not yet verified by a person.

Who does it depends on how the run was driven:

- **`--manual`:** the agent driving `act` has a shell, so `<run>/brief.md` is one prompt in three
  phases: the assignment, then its own review, then the bugs. `start` prints where it is; hand it
  to the agent.
- **`--agent`:** the runner's agent has no files, so it does the assignment only. `start` also
  writes `<run>/review-brief.md` and prints where it is. Once the run stops, hand that to an agent
  with a shell and GitHub access.

The briefs name the run's directory, the exact `act` command (with `--out` when you gave one) and
the repository. `bun run arena brief` prints them without a run (`--run`, `--out`, `--repo` fill
them in).

## The score

Every run ends with a score (`src/score.ts`), written to `score.json` and `score.md`. `start` and
`score` exit 1 when it is FAIL, so a caller can gate on a run. It follows the session eval's rules
(#441): every line traces to a record, and there is **no composite number**. It reports named UI
checks and problems at two severities. One error fails the run, and the score says which.

**The UI checks.** Any check that fails or can't be made (`unknown`) is an error, because the score
won't say the UI was used without evidence. Only the first two come from the recorder. The other
three are checked against Enso's own records and the files on disk:

| Check | Passes when |
|---|---|
| `agent-only-tool` | the manifest's boundary held: the agent's only tool was `act`, and every action came through it |
| `acted-on-page` | the agent made at least one move on the page (click, fill, press, …) through its tool |
| `prompted-enso` | Enso's session evals count at least one prompt (`humanMessages`) |
| `no-thread-outside-ui` | every stored thread of the run's project that has messages was shown in the UI, or is a fork of one that was |
| `enso-did-the-work` | if the project or a thread's tree changed, Enso's sessions ran tool calls |

Enso runs a thread in a tree of its own (#551), so the work is counted across the project *and*
each thread's `cwd`. A live run's `snake.js` was only in the tree.

**The problems**, grouped so a repeated one is one line with a count and examples:

| Read from | Error | Warning |
|---|---|---|
| the run | the recorder died; the runner failed; the agent's model call failed | budget ran out; ended without `stop`; no retrospective |
| the timeline | page crash, Enso exit, uncaught page error, HTTP 5xx, a recorder failure | console error, HTTP 4xx, failed request (not `ERR_ABORTED`), failed action |
| the agent's transcript | a model call that failed | each nudge |
| the agent's own moves | | a tool it wasn't given; an action refused before the page (`goto /api`) |
| Enso's log records (the thread bundles) | `ERROR`, `FATAL` | `WARN` |
| Enso's session evals | a provider refusal | tool errors, failed gates, guard and rule refusals, denied prompts, retry after error |
| the evidence | | each piece not collected |
| the work | | nothing built anywhere |

The score doesn't judge whether the game is good, or whether a wish is a real gap. That is the
findings report's job.

## The UI-only boundary (#584)

The agent runner (`src/agent.ts`) is a pi `Agent` over a bare model call, given the brief and **one
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
| `screenshots/` | one every 30 s (`sample`), plus one per error, dialog, navigation, failed action, page crash, Enso exit; a shot that could not be taken is a `recorder-error` line instead |
| `trace/trace-NNN.zip` | the Playwright trace in five-minute chunks (`bunx playwright show-trace <zip>`) |
| `enso/stack.log` | Enso's own output, redacted |
| `enso/evidence/` | what the server holds for each thread the UI named or the project stores: record, events, session eval, log bundle; plus Stats |
| `enso/evidence/snapshot-store/` | a copy of the project's snapshot store (#551), so pruning the home costs the run nothing |
| `agent/transcript.jsonl` | the agent under test's own transcript (`--agent`), redacted, image bytes left out |
| `score.json`, `score.md` | the score: verdict, UI checks, problems, metrics |
| `manifest.json` | the fold: what drove the run and whether the boundary held, screenshot index, threads with their time spans, actions, observed signals, the agent's notes, and every piece of Enso evidence as `collected` or `missing` with why |

The thread id on a timeline line is the id `bun scripts/enso-thread.ts`, `/api/logs/bundle?thread=`
and the session file are keyed by: that is the jump from a screenshot to its turn.

## What holds, and where it stops

- **The recorder is not Enso.** Enso is its child; an Enso exit is recorded, sampling continues, and
  the agent may `restart-enso`. The timeline and screenshots are on disk as they happen; a trace is
  lost at most one chunk at a time.
- **Enso down at the stop still leaves evidence (#607).** Each server route becomes its own `missing` row
  with the reason, and the rows read from disk (the snapshot store) are taken all the same.
- **A recorder that dies before its stop** (SIGKILL, a closed terminal) leaves `control.json`, which
  names its home and its Enso stack. `bun run arena manifest <run dir>` then collects the evidence:
  - from the stack, if it is still up, and then stops it;
  - else every route `missing` and the disk read.

  `start` refuses while a dead run's stack holds the ports, and names that run; `act` on a dead run
  says so. A stack is stopped only when it is `bun run dev <that run's project>` exactly. Observed
  2026-10-05: a recorder killed with SIGKILL took its stack down within 2 s, so a surviving stack is
  the rarer case.
- **Every UI action goes through the recorder**, so each is in the trace (as a named group) and on the
  timeline. There is no selector, no `evaluate`, and `goto` refuses `/api`.
- **The agent has no shell** under `--agent` (above). Under `--manual` it is whatever you give it, and
  the manifest says the boundary was not held.
- **Secrets.** Typed text that looks like a credential is refused, not typed: what is typed is in the
  trace's DOM snapshots and on screenshots, and a PNG cannot be scrubbed. Text the recorder writes
  (timeline, Enso's output, evidence) is redacted with the home's known secret values. A secret Enso
  itself puts on screen is not scrubbed from screenshots or the trace.
- **The agent's account is not proof.** The manifest keeps its notes apart from what the recorder
  observed; the review must cite the evidence for each point, and every bug filed says it is
  unverified and names the run. Verifying those, and triaging the filed bugs, stays a person's step.
- **Not collected yet:** the Diff Viewer's data (no read route for a run). The snapshot store (#551)
  is copied into the run when it exists, and marked missing when it does not.
