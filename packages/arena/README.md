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
bun run arena compare <run dir> <run dir>   # two runs side by side; reads only, rewrites nothing
bun run arena report <run dir> [--run-tests]   # the application outcome apart from Enso's findings; the gaps' evidence checked
```

`start` needs one of `--agent PROVIDER/MODEL` (a model the home is logged in to, through Enso's own
login; `--thinking LEVEL`, `medium` by default) or `--manual`. It also takes `--scenario ID` (below), `--minutes N` (the budget, 120 by default),
`--home DIR` (an `ENSO_HOME` to run over, shared with whatever else uses it; by default each run
gets its own, below), `--out DIR` (`$XDG_DATA_HOME/enso/arena`, i.e. `~/.local/share/enso/arena`, by
default; one under a `.enso` directory is refused), `--chromium PATH`,
`--repo OWNER/NAME` (where bugs are filed: the checkout's GitHub `origin` by default) and
`--headed`. Ports 5178 and 5179 must be free: the arena starts its own stack.

Four scenarios, told only what to achieve, never which controls to use:
- **`snake`** (the default): a Snake game with five features of the agent's choosing. One prompt and done: it exercises starting a session, approvals, and seeing what was built.
- **`iterate`**: a to-do CLI in at least three rounds, checking each round's changes, taking one round back for another approach, and finding the work's cost and context. It reaches what Snake doesn't: the Diff view, restore, forks, Stats and Context. Its first run found #650 and #651.
- **`compare`**: a Markdown-to-HTML converter in two approaches kept side by side, compared by what each changed and cost, one kept and the other cleaned up, then exactly what the model was given in its last request. It reaches parallel threads, deleting a thread and its tree, and Context. Its first run found #659.
- **`resume`**: a password generator whose work is interrupted and picked up: one request stopped midway and redirected, the page reloaded and the conversation continued, a branch off an earlier request, and another model for one request. It reaches stopping a run, persistence across a reload, forks and the model control. Its first run found #664 and #665.

**When a run stops (#609).** Besides the agent's own `stop`:
- **The budget (`--minutes`).** Every `act` answer carries `phase` and `remainingMs`. When the budget is
  spent, a one-minute grace window opens in which only a `note` (the retrospective) and `stop` are
  taken; anything else is refused and recorded. The run stops when the window closes.
- **`--idle-minutes N`** (10; `0` turns it off): no action, refused ones included, for N minutes.
- **`--max-restarts N`** (3): a `restart-enso` past N is refused, and the run stops.
- **`--max-cost-usd N`** (10): Enso's own spend, read from the run home's logs, past N. Over a shared
  `--home` the logs hold other spend too, so the bound is off there. The agent under test's own
  model calls are not in Enso's logs and are not counted.

Each bound gives its own `stopReason` in the manifest, and the score warns that the run stopped at a
bound.

A native browser dialog (`alert`, `confirm`, `prompt`) blocks the page until it is answered. `read`
reports it, and `accept-dialog` (with `text` for a prompt) or `dismiss-dialog` answers it. Enso raises
none today.

**Tabs (#675).** A tab the page opens (Preview's **Open preview**, a link) comes to the front, as a
browser shows it, and every action goes to the tab in front. `tabs` lists the open tabs by number
(Enso's is 0, and a number is never reused), `switch-tab` brings one to the front, and `close-tab`
closes one; the last tab stays open. Every tab is watched and traced. A timeline line names its tab
when it is not the first, and event screenshots are taken of the tab in front. What the built page
itself logs in its Preview tab (a console error, a missing file, an uncaught error, a failed action)
is scored under **application**, as a warning: a bug in the game doesn't fail Enso's run. A 5xx
serving that page is still Enso's.

**Each run has its own Enso home, `<run>/.enso` (#610).** It holds the run's projects, threads, logs
and Stats, so the agent under test sees only the run's project, the evidence covers only the run,
and your own Stats and logs are untouched. Your login comes in by symlink:
- `secrets.env`, `pi-agent/auth.json` and `pi-agent/models.json` are linked, and `settings.json` is
  copied.
- Linked, never copied: an OAuth refresh rotates the refresh token, so a copy would leave your own
  login holding a revoked one. pi rewrites `auth.json` in place, and through the link the refresh
  lands in your file.
- **A link can be replaced (#639).** The harness's multi-account extension writes `auth.json` and
  `models.json` by renaming a temp file onto the path, which replaces a link with a plain file. The
  recorder checks the links at every 30 s sample and at the stop, and `arena manifest` checks them
  too. A replaced link's content goes back to your file when it is the newer, and the link is
  restored. If your file changed after the run's, yours stands and the run's change is dropped: the
  timeline says so as a recorder error.
- pi's lock on that file is taken beside the link, so your own pi refreshing the same provider at
  the same instant is not serialized with the run.

The home is named `.enso` because that is the guard's credential fragment: Enso's agent can neither
read nor write under it. The same fragment is why runs are not kept under `~/.enso`: the project would
be under it too, and the agent could not touch its own work.

With `--agent`, the run starts the agent under test itself and stops when the agent stops it, ends
without stopping (after three nudges), or reaches its budget or a bound. Do not prescribe its features or
script its failures.

### In a container (#676)

On the host, a run borrows your own login (above) and Enso's coding agent runs its `bash` on your
machine. `bun run arena container` runs the same thing in a Docker image instead, with a **test
account's** credential injected into it:

```bash
bun run arena container build                                   # the image, from this checkout
bun run arena container credential --api-key-stdin < key.txt    # an Anthropic API key, or:
bun run arena container credential --from test-account-auth.json # a pi auth.json (API key or OAuth)
bun run arena container credential --status                     # which providers it holds, never a value
bun run arena container start --agent anthropic/claude-sonnet-5-5 --scenario iterate [--runs DIR]
```

- **The host is reachable through two mounts and nothing else.**
  - The runs directory (`--runs`, the arena's default otherwise) is mounted at its own host path,
    so the paths a run records (its project, every screenshot) hold on the host too. `score`,
    `report` and `compare` read a containerized run as they read any other.
  - The `enso-arena-credentials` volume is the container's `pi-agent` directory. A Docker volume,
    not a host path, so the container never sees your `~/.enso`.
- **Not mounted:** your home, the Docker socket, the host network. The container gets no added
  privilege.
- **The credential goes in through stdin only**, never an argument or the environment, and is
  stored readable by its owner only. The volume is writable: a token an OAuth refresh rotates is
  kept for the next run, through the run home's link or the #639 reconcile.
- **What runs is the image, not your checkout.** Run `container build` again after pulling changes.
  The manifest's `ensoBuild` names the commit the image was built from. The image is built for
  **your** uid and gid, because the runs directory is a bind mount and a container user of another
  uid couldn't write to it on native Linux Docker. Build it as the user who runs it.
- **Refused in a container:** `--home`, `--out`, `--chromium`, `--headed` (the container decides
  them) and `--manual`, whose `act` could not reach a recorder inside the container.
- The image is Playwright's 1.63.0 image (Chromium at the version the arena drives), with bun 1.4.2,
  git and Python. It is about 6 GB.

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

### Observed friction (#611)

`score.md` also lists **friction the timeline shows**, whatever the agent wrote about it. Each line
cites the seconds it rests on, and none of it changes the verdict (`src/friction.ts`):

| Pattern | Counted from | What it means |
|---|---|---|
| `polling` | 3 fixed-sleep→read cycles | the agent slept a fixed time and looked again; the line says how much of the run went to those sleeps. A `wait` on the page, `"until": "attention"` (#648: Enso asks, or its run ends) or `"until": "change"` (#637), returns when Enso does something, and is not counted |
| `approvals` | 3 taken "Yes / Allow / Approve …" clicks, by role or by text (#641) | the agent had to let Enso's agent go on, call by call |
| `retry` | 1 action tried again within 3 actions of failing | a control that did not work the first time |
| `backtracking` | 2 `back` / `reload` | the agent undid where it went |
| `repeated-navigation` | the same `goto` 3 times | the agent kept returning to one place |

The thresholds are constants in `src/friction.ts`. On the 2026-10-05 reference run, which built Snake
in 6.1 minutes, the detector found 9 polling cycles (5.4 minutes of waiting) and 7 approval clicks.

### Comparing runs

`bun run arena compare <runA> <runB>` scores both runs afresh, so runs folded by different versions
of the score are compared by the same rules. It prints:
- the outcome, metrics and UI checks side by side;
- each problem once, under "Only in A", "Only in B" or "In both" (thread ids read as `<thread>`, so the
  same 404 in two runs is one problem);
- the friction count per pattern.

It writes nothing.

## The report (#624)

`bun run arena report <run dir>` writes `report.md` and `report.json`. It has two parts that never
mix, since #556 asks for the app's completion to be reported apart from Enso's usability:

- **Application outcome:** for the project and each thread's tree: its files (largest first), its
  git history (a tree that is no repository of its own says so, rather than borrowing a parent's),
  and the test files the agent wrote. `--run-tests` runs them: the package's `test` script if there
  is one, else each file under bun (`*.test.*` through `bun test`, others as scripts). They are
  agent-written code run after the run with no approval, so they get `PATH`, a throwaway `HOME` and
  60 seconds each, never your environment. Their output is redacted with the run's secrets.
- **Enso findings,** three kinds under their own headings:
  - **Observed friction:** the score's friction and problems. Each friction moment links the
    screenshot nearest it and the turn that screenshot shows.
  - **The agent's account:** its wish, friction and retrospective notes as written, with the same
    links. These are observations, never promoted to findings here.
  - **Verified gaps:** read from the `findings.json` the review brief asks for. Each gap has a
    classification (`defect`, `undiscoverable`, `agent-mistake`, `not-needed`), reproduction,
    impact, observed and inferred cause kept apart, workaround, the issue that covers it, and its
    evidence (`elapsedMs`, screenshot, thread id).

The report checks every citation in `findings.json` against the run. A second outside it, a
screenshot it did not keep, or a thread it was not in marks the gap **unverified**, with what failed
to resolve. A gap that cites nothing is unverified too, and a defect with no issue is flagged as not
mapped. The judgement stays the reviewer's; the report checks only that the evidence exists.

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
| `.enso/` | the run's own Enso home: its threads, sessions and logs as Enso wrote them (unredacted), and links to your login. Share `enso/evidence/`, not this |
| `timeline.jsonl` | one line per event, wall clock + elapsed + URL + the thread the URL names |
| `screenshots/` | one every 30 s (`sample`), plus one per error, dialog, navigation, failed action, page crash, Enso exit; a shot that could not be taken is a `recorder-error` line instead |
| `trace/trace-NNN.zip` | the Playwright trace in five-minute chunks (`bunx playwright show-trace <zip>`) |
| `enso/stack.log` | Enso's own output, redacted |
| `enso/evidence/` | every read route the server has for each thread the UI named or the project stores, one `thread-<id>-<route>` file each: record, events, session eval, log bundle, history, stats, context, incidents, judge cases, run conditions (`manifest`), git, changes; plus Stats, the about page and the trees' disk use (`trees.json`) |
| `enso/evidence/snapshot-store/` | a copy of the project's snapshot store (#551), so pruning the home costs the run nothing |
| `agent/transcript.jsonl` | the agent under test's own transcript (`--agent`), redacted, image bytes left out |
| `score.json`, `score.md` | the score: verdict, UI checks, problems, observed friction, metrics |
| `review.md`, `findings.json` | the reviewer's account and its gaps, written after the run from `review-brief.md` |
| `report.json`, `report.md` | `arena report`: the application outcome apart from Enso's findings, each gap's evidence checked |
| `manifest.json` | the fold: the build Enso ran from (`ensoBuild`: commit, whether the checkout was dirty, a hash of the uncommitted work), what drove the run and whether the boundary held, the screenshot index (each shot in a thread with the `turn` it shows), threads with their time spans, the filesystem timeline (`filesystem`: the project and each thread tree at every periodic screenshot, file count and a fingerprint), actions, observed signals, the agent's notes, every piece of Enso evidence as `collected` or `missing` with why — or `skipped` for a thread with nothing to collect: deleted during the run, or never run (#671) — and the secret scan |

A shot's `turn` comes from the thread's collected history: its `turnId` is the user message that opened the turn and its
`messageId` the last message at or before the shot, both entry ids of the session file. It is joined after the run from
Enso's own timestamps; a shot before the thread's first prompt has none. A workspace's `fingerprint` hashes each file's
path, size and mtime (`.git` and `node_modules` skipped), so it moves when any file is written and only then.

The thread id on a timeline line is the id `bun scripts/enso-thread.ts`, `/api/logs/bundle?thread=`
and the session file are keyed by: the jump from a screenshot to its thread, where its `turn` names the entry.

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
  (timeline, Enso's output, evidence) is redacted with the run's secret values: `secrets.env`, the
  environment's secret-shaped names, and the OAuth tokens and keys in `auth.json`.
  - The set grows during the run: when a refresh rotates a token, the new one is added and the old
    one stays.
- **At the stop, every file the run keeps is scanned for those values (#610).** That includes each
  trace zip entry by entry, where Playwright keeps the network response bodies.
  - The manifest's `secretScan` names each hit by file and entry, never by value, and any hit fails the
    score.
  - A file or directory it cannot read is an `unreadable` warning, and the rest is still scanned:
    not scanned is not clean.
  - `arena manifest` scans again with the home the run recorded, and keeps every earlier hit whose file
    still exists. A rotated token is a value it can no longer look for, so a hit it cannot re-check stands.
  - Not read: `.enso/` (the links, by design), symlinks, and PNGs. A secret Enso puts on screen is
    still not caught in a screenshot.
- **The agent's account is not proof.** The manifest keeps its notes apart from what the recorder
  observed; the review must cite the evidence for each point, and every bug filed says it is
  unverified and names the run. Verifying those, and triaging the filed bugs, stays a person's step.
- **Not collected yet:** the Diff Viewer's data (no read route for a run). The snapshot store (#551)
  is copied into the run when it exists, and marked missing when it does not.
