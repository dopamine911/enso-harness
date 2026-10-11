# Dogfood Arena

An agent uses Enso through its real UI on an assignment, and a recorder outside Enso keeps the
evidence (#556). The agent is a *user* of Enso: it reaches the page only through one tool, `act`,
by what a reader of the page sees, and is told nothing about Enso's internals.

## Run

```bash
bun run arena login                 # once: the arena's own login, which every run's Enso uses (#763)
bun run arena start --agent anthropic/<model-id>   # Enso + a recorded browser + the agent under test, UI only
bun run arena start --agents <model>,<model>       # the same scenario once per agent model, one after another
bun run arena start --manual        # the same run with no agent: you act over `arena act`; the boundary is not held
bun run arena brief                 # what the agent under test is told (`--manual`: the act-command version, review and bugs included)
bun run arena brief --review --run <run dir>   # the review and bug-filing prompt for after an --agent run
bun run arena act '{"action":"read"}'   # one UI action on a --manual run
bun run arena manifest <run dir>    # fold the manifest again; after a recorder that died, collect Enso's evidence too
bun run arena score <run dir>       # score a run again: its logs read for problems, and whether the UI was used
bun run arena compare <run dir> <run dir>   # two runs side by side; reads only, rewrites nothing
bun run arena compare --by-model <run dir>…   # any number of runs, grouped by agent model and perception
bun run arena report <run dir> [--run-tests]   # the application outcome apart from Enso's findings; the gaps' evidence checked
bun run arena prune --keep 10 --dry-run   # what old runs would free: their trace, their projects' node_modules, dist and build
```

`start` needs one of `--agent PROVIDER/MODEL` (a model your own Enso is logged in to: the agent under
test is the arena's driver, which uses your login; `--thinking LEVEL`, `medium` by default) or `--manual`, and an arena login (`bun run arena login`, below). It also takes `--scenario ID` (below), `--minutes N` (the budget, 120 by default),
`--home DIR` (an `ENSO_HOME` to run over, shared with whatever else uses it; by default each run
gets its own, below), `--out DIR` (`$XDG_DATA_HOME/enso/arena`, i.e. `~/.local/share/enso/arena`, by
default; one under a `.enso` directory is refused), `--chromium PATH`,
`--repo OWNER/NAME` (where bugs are filed: the checkout's GitHub `origin` by default),
`--headed`, `--memory-max SIZE` and `--no-scope` (both below), and `--action-gap-ms N` (below).

**How fast the agent acts (#848).** The agent runner runs a turn's actions back to back, each a few
tens of milliseconds, so without a gap a page that runs in real time is only ever used at machine
speed: a snake run's agent sent Play Again, a key and `p` within 12 ms, saw them land inside the
game's first 100 ms tick, and reported a game that dies at human speed as fixed. So each action
starts at least `--action-gap-ms` after the previous one ended: 250 by default in `play` and
`arcade`, whose apps run in real time, and 0 elsewhere, where fast input can find a real race in
Enso. Between turns the model's own call is longer than any gap, so only a turn's later actions
wait. The brief tells the agent the gap in force and to put a `wait` between steps a person would
space out; `agent-start` and the manifest's driver record carry it. A `--manual` run has no runner
to pace, so the flag is refused there.

### Launch and cleanup (#742)

`start` launches the run and cleans up after it, so a run neither competes with what launched it nor
leaves anything behind:

1. **What an earlier run left is taken back.** A run whose recorder died (SIGKILL, an OOM, a closed
   terminal) gets its evidence collected and its stack stopped, as `arena manifest` would. A temporary
   directory whose run is gone is removed.
2. **It refuses rather than collides.** It refuses while a run is live (naming it and its recorder),
   while anything else holds 5178 or 5179 (naming the pid and command), and when there is less than
   3 GB of memory available, 2 GB free in the temporary directory or 5 GB free under `--out`.
3. **The run gets its own scope.** Where `systemd-run --user` works, the run (the recorder, Enso and
   Chromium) runs as the transient scope `arena-<time>.scope`, its memory capped at `--memory-max`
   (`6G` by default, plus 1 GB of swap; any value systemd's `MemoryMax=` takes, such as `4096M`, `50%`
   or `infinity`, and a value systemd refuses is refused before anything starts). A run that overruns is killed inside its scope, and nothing
   else on the machine is touched. `start` itself waits outside the scope. `--no-scope`, or a machine
   without systemd, runs it unscoped, and `start` says there is no cap.
4. **It gets its own temporary directory.** Every process of the run has `TMPDIR` set to
   `<tmp>/enso-arena-XXXXXX`: Playwright's artifacts, Chromium's profile, Enso's and the agent's
   temporary files. The trace's working files go to `trace/.work` in the run, on disk rather than in
   a tmpfs.
5. **Afterwards, whatever ended the run:** a recorder that died has its run collected; Enso's stack is
   stopped as a whole tree (SIGTERM to its root, then to anything left, then SIGKILL); what remains in
   the scope is stopped; the ports are waited for; the temporary directory and `trace/.work` are
   removed. One line says what was found:

   ```text
   arena: cleaned up — 0 process(es) left in arena-<time>.scope stopped; ports 5178/5179 free; its TMPDIR removed (0 MB)
   ```

   It names a run that hit its memory cap.

`bun run arena prune --keep N | --older-than DAYS [--dry-run]` frees what an old run can do without:
its `trace/`, and the `node_modules` (and the `dist` or `build` beside a `package.json`) in its project
and its thread trees. Both options together prune only runs that meet both. It never touches a live run,
or what `publish` and a review read: the reports, findings, score, manifest, screenshots, timeline,
`enso/` and the run home's sessions and snapshots. `arena report --run-tests` on a pruned run needs its
packages installed again.

**Perception (#680): `--perception tree` (the default) or `visual`.** How the agent under test sees
and acts on the page:
- **`tree`** reads the page's accessibility tree (`read`, a region at a time: below) and acts on controls by name: each
  target names one way, role (and accessible name), text, label or placeholder, and a target naming two is refused
  (#850). A screen-reader user who also has a list of every control. It finds broken flows, errors, wrong state, and
  unnamed or ambiguous controls well. It can't judge what a sighted user sees, and it finds controls a sighted user
  might not notice.
- **`visual`** sees a **1024×640 screenshot** of the tab in front after every action, and nothing else:
  no tree, no control by name. It acts like a mouse and keyboard: `click` at `x`,`y` (also
  `"double": true` or `"button": "right"`), `move`, `scroll` (`dx`, `dy`), `drag` (`toX`, `toY`),
  `type` into whatever has focus, `press`, plus `goto`, the tabs, `wait`, `note` and `stop`.
  - The view is 1024×640, not the 1440×900 window: GPT's image pipeline would shrink 1440×900 to
    1229×768, and its points would land about 15% short. The recorder maps a point back to the window.
  - Each pointer action's timeline line records what was under the point, by its accessible role
    and name (`button "Start session"`). That's for the review only; the agent never sees it.
  - A native dialog never shows in a page capture, so every visual answer says when one is open.
  - It needs a model that takes images. Each mode refuses the other's moves, so the two stay comparable.
  - **Its cost, as measured so far:** one view per action, which in GPT-6.1 Sol runs was 59–67 views
    in 10–15 minutes (4.5–6.8 MB of PNG). The money isn't measured yet: those runs were on a
    subscription, where Stats shows $0.0000 (#692).

**A model call carries at most twice `ARENA_IMAGE_STEP` screenshots (#724; `src/agent.ts`)**, in either mode.
Up to that, all go; past it, the oldest are dropped a whole step at a time, each replaced in the request by a line
saying one was there, so a call then carries 4 to 7. In steps, so the request's start stays the same for several calls and the provider's prompt
cache holds (PR #725 review). Before, every screenshot stayed, and an Opus tree run that took 68 (about 41 MB in
base64) died at 43 minutes when the API refused the request (413 `request_too_large`).

**`read` takes one region of the page, and after the first read only what changed (#740; `src/read-regions.ts`).**
Every read used to be the whole page: in Opus's snake run 16 reads were 313 KB, about 80% of the text sent
back to the model, and the second half of the run cost 1.9× the first. Now:
- **`"region"`** is one of `transcript` (the thread view, whichever tab is selected, plus the composer), `dialog`,
  `threads` (the rail), `status` (the status bar), `header`, or `page` (everything). Each is found by role and
  accessible name, never by a class: `banner`, `navigation "threads"`, `contentinfo "thread status"`, any
  `dialog`/`alertdialog`. `transcript` is whatever is left, and exists only when a `tabpanel` is there. Without a region
  a read takes the open dialog, else `transcript`, else `page` (another site's tab). Every answer names its `region`
  and lists the `regions` on the page. A region that isn't there is refused, with the list.
- **The first read of a region is whole (`snapshot`). Later reads say what changed since the previous read of that
  region (`against`):** `changes` holds the added (`+`) and removed (`-`) lines, each under the unchanged lines it is
  indented under, or `unchanged: true`. A navigation, a reload or a tab switch makes every region whole again, and so
  does `"full": true`. A region also reads whole when its changes since its last whole read would be longer than
  the region itself, or when the change is too big to compare.
- **The agent's model call keeps a region's reads from its newest whole read on (`withCurrentReads` in
  `src/agent.ts`).** Older ones are replaced in the request by a line saying a later read has the region whole.
  This works the way #724 replaces screenshots: it shapes each request and leaves the conversation alone. A diff
  needs the read it is against, so a diff and its chain stay until the next whole read, and the chain is short
  because the length rule above forces one. Another region's reads are never touched. A `--manual` operator keeps
  their own context: if it loses an earlier read, `"full": true` gets the region whole.

Run each scenario in both modes and put the two side by side with `arena compare`, which shows each
run's perception and agent: they find different things.

Six scenarios, told only what to achieve, never which controls to use:
- **`snake`** (the default): a Snake game with five features of the agent's choosing. One prompt and done: it exercises starting a session, approvals, and seeing what was built.
- **`iterate`**: a to-do CLI in at least three rounds, checking each round's changes, taking one round back for another approach, and finding the work's cost and context. It reaches what Snake doesn't: the Diff view, restore, forks, Stats and Context. Its first run found #650 and #651.
- **`compare`**: a Markdown-to-HTML converter in two approaches kept side by side, compared by what each changed and cost, one kept and the other cleaned up, then exactly what the model was given in its last request. It reaches parallel threads, deleting a thread and its tree, and Context. Its first run found #659.
- **`resume`**: a password generator whose work is interrupted and picked up: one request stopped midway and redirected, the page reloaded and the conversation continued, a branch off an earlier request, and another model for one request. It reaches stopping a run, persistence across a reload, forks and the model control. Its first run found #664 and #665.
- **`play`** (#675): a small browser game, then played by the agent the way a player would: it finds something wrong or missing, has it changed, and plays again, at least twice. It is never told there is a preview; whether it finds a way to play is the finding. It reaches Preview, iteration on a running application, and what only using it shows. Its agent's actions are paced 250 ms apart (#848).
- **`arcade`** (#740): a retro arcade cabinet in the browser, a page a player picks games from, with five classic arcade games recreated in a retro style and one new game of the agent's own design. A long build in many parts: the others are done in minutes, and this is where what grows with a run's length shows (context and reads, samples and trace, threads and trees, compaction). Paced like `play` (#848).

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
reports it, and `accept-dialog` (with `text` for a prompt) or `dismiss-dialog` answers it. An action
that opens one answers at once, with the dialog in its answer (#691), rather than waiting out its
timeout for a dialog nobody has answered. Enso raises none today; the pages it builds do.

**Tabs (#675).** A tab the page opens (Preview's **Open preview**, a link) comes to the front, as a
browser shows it, and every action goes to the tab in front. `tabs` lists the open tabs by number
(Enso's is 0, and a number is never reused), `switch-tab` brings one to the front, and `close-tab`
closes one; the last tab stays open. Every tab is watched and traced. A timeline line names its tab
when it is not the first, and event screenshots are taken of the tab in front. What the built page
itself logs — in Preview's tab, served on the thread's own origin (#713), or on any page of another
origin, such as a dev server the work started — is scored under **application**, as a warning: a
bug in the game doesn't fail Enso's run. A 5xx serving the page is still Enso's.

**Each run has its own Enso home, `<run>/.enso` (#610).** It holds the run's projects, threads, logs
and Stats, so the agent under test sees only the run's project, the evidence covers only the run,
and your own Stats and logs are untouched. **A run never uses your login (#763):**
- The arena has a login of its own. Run `bun run arena login` once: it opens pi over
  `$XDG_DATA_HOME/enso/arena-login/.enso/pi-agent` (else `~/.local/share/…`), where you `/login`, to a
  test account or your own. Your own account gets a **separate** grant, so a refresh in a run never
  revokes yours. A run with no arena login stops at launch and says to run it.
- `<run>/.enso/pi-agent` is a link to that directory. A directory, not files: a rename onto
  `pi-agent/auth.json` (how the multi-account extension writes) replaces the real file, so nothing
  breaks the link, and every run takes pi's lock on the one real file.
- Never a copy of your login: an OAuth refresh rotates the refresh token, so the run refreshing a copy
  would revoke yours (#610). And never links to your files: a rename onto a linked file replaced the
  link, and a run's refresh logged you out (#639).
- From your home a run takes `secrets.env`, linked (only you write it), and your `settings.json`,
  copied into the arena login at each run's start, so a run starts on your default model unless
  `--enso-model` sets one. Runs share the login directory safely because they run one at a time.
- The arena's own driver model (`--agent`) still reads your `~/.enso/pi-agent` directly, without a
  link: it is your process, like any pi you run.

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
  stored readable by its owner only. The volume is mounted as the image user's arena login directory
  (#763), and is writable: a token an OAuth refresh rotates is kept for the next run.
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
- the outcome, metrics and UI checks side by side, with the model Enso's sessions ran on and the
  agent's own cost;
- each problem once, under "Only in A", "Only in B" or "In both" (thread ids read as `<thread>`, so the
  same 404 in two runs is one problem);
- the friction count per pattern.

It writes nothing.

### Across models (#674)

`bun run arena start --agents A,B` runs the scenario once per agent model, one after another (the
ports are one stack at a time). Every model resolves before the first run, and each one's likely
cost is printed first: the mean of the earlier runs under `--out` with that agent and perception.
Then `bun run arena compare --by-model <run>…` groups runs by agent model and perception. Each
column says how many runs it has, since one run per model can't tell a model's difference from
noise. It shows:
- how many passed, the models Enso's sessions ran on, and the means of the agent's cost, minutes,
  actions, failed actions and notes;
- the problems that appear under one model only;
- each friction pattern's mean per run.

**What a run costs.** The agent's own cost is its calls at the model's listed price: what an API
key would be billed, whatever account ran it. A model with no listed price shows "unpriced". Enso's
spend is separate and bounded by `--max-cost-usd`. Measured so far (the agent's calls only):

| agent · perception | runs | mean per run |
|---|---|---|
| `anthropic/claude-sonnet-5-5` · tree | 12 | $0.12 |
| `openai-codex/gpt-6.1-sol` · tree | 6 | $1.12 |
| `openai-codex/gpt-6.1-sol` · visual | 3 | $2.41 |

**Enso's model.** `--enso-model PROVIDER/ID` sets the model Enso's sessions start on, in the run
home's own copy of the settings (`defaultProvider`/`defaultModel`; yours are untouched, so it's
refused over a shared `--home`). The Start dialog preselects it when its list offers it. The
manifest records the model set, and each thread's record names the model its session ran on; the
score and both comparisons show it, and the score warns when Enso never ran on the model set.

## The report (#624)

`bun run arena report <run dir>` writes `report.md` and `report.json`. It has two parts that never
mix, since #556 asks for the app's completion to be reported apart from Enso's usability:

- **Application outcome:** for the project and each thread's tree: its files (largest first), its
  git history (a tree that is no repository of its own says so, rather than borrowing a parent's),
  and the test files the agent wrote. `--run-tests` runs them: the package's `test` script if there
  is one, else each file under bun (`*.test.*` through `bun test`, others as scripts). They are
  agent-written code run after the run with no approval, so they get `PATH`, a throwaway `HOME` and
  60 seconds each, never your environment. Their output is redacted with the run's secrets.
- **What playing found** (#675), part of the application outcome: the moves made on the
  application's own page (Preview's, or another origin's) and their span, what that page logged, and
  the notes written while it was in front. A run that never used the application says so.
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

## Publishing a run (#677)

`bun run arena publish <run dir>` puts a reviewed run in the corpus, the private
[`dopamine911/enso-dogfood-corpus`](https://github.com/dopamine911/enso-dogfood-corpus) (`--corpus OWNER/REPO` names
another). `--dry-run` prints what would go, the issue's body included, and touches nothing.

- **Files:** `report.md`, `review.md` when there is one, `findings.json`, `score.md`, `manifest.json`, and the
  screenshots they cite, committed under `runs/<run id>/`. The trace and the other screenshots stay with the run.
- **One issue for the run:** its scenario, the agent's model and perception, Enso's model, the build and the verdict,
  then each finding with its screenshots shown inline (the ones it cites, else the nearest to each second it cites),
  pinned to the commit that holds them, and the product issue it maps to. Bare `#123`s in a finding's words are
  written as the product repository's: in the corpus they would link to its own run issues.
- **Labels:** `scenario:`, `model:`, `perception:`, `verdict:`, and `finding:` for each class of finding the run has.
  `gh issue list -R dopamine911/enso-dogfood-corpus --label finding:undiscoverable` is every run with one.
- **Backlinks:** each product issue a finding maps to gets a comment linking the run issue. Product defects stay in
  this repository: the corpus is the evidence.

It refuses, naming every reason at once, until the run can go:

- the run is reviewed: `findings.json` is there and reads;
- every finding's evidence resolves, and every `defect` names a product issue;
- `report.md` is newer than `findings.json` (run `arena report` again after a review changes);
- the secret scan finds nothing: a fresh scan of the documents it publishes, plus every hit the manifest's
  scan recorded, the trace's included. A trace hit refuses too: the page showed it, and a published
  screenshot may. A manifest that records no scan at all (a run from before #610) is refused until
  `arena manifest` scans it. A screenshot cannot be scanned, so a secret on screen would be published:
  run with the run home's own credential.

A run already in the corpus is refused with its issue. A publish cut short after its commit resumes from that commit.
The corpus is cloned over HTTPS into `~/.local/share/enso/arena-corpus/`, signed in by gh's credential helper, as
this checkout is.

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
| `project/` | the fresh git repository the run opened in Enso. It usually stays empty: each Enso thread works in its own tree (below), not in this checkout |
| `.enso/projects/<project id>/trees/<thread id>/` | **the application outcome**: what each thread built, one tree per thread (a compare or a fork has several). Open its `index.html`, or use the thread's Preview. The history of each tree is the snapshot store beside it, `…/snapshots/` |
| `.enso/` | the run's own Enso home: its threads, sessions and logs as Enso wrote them (unredacted), and links to your login. Share `enso/evidence/`, not this |
| `timeline.jsonl` | one line per event, wall clock + elapsed + URL + the thread the URL names |
| `screenshots/` | JPEG (quality 80, #740): one every 30 s (`sample`), plus one per error, dialog, navigation, failed action, page crash, Enso exit. A sample is not written when neither the page's picture nor the workspaces' fingerprint changed since the last sample: the timeline has a `sample-skipped` line naming that sample instead. A shot that could not be taken is a `recorder-error` line instead. The run's browser asks for reduced motion, so Enso's status dots stand still |
| `trace/trace-NNN.zip` | the Playwright trace in five-minute chunks (`bunx playwright show-trace <zip>`): actions, DOM snapshots and the network. No screencast (#736): the viewer's filmstrip is empty, and `screenshots/` is the run's picture. A wait until change snapshots the page's accessibility tree only when the page's own count of its changes moved (#740), and reads that count over DevTools, which the trace does not record. While the run is live, `trace/.work` holds the chunk being written; it is removed at the stop |
| `enso/stack.log` | Enso's own output, redacted |
| `enso/evidence/` | every read route the server has for each thread the UI named or the project stores, one `thread-<id>-<route>` file each: record, events, session eval, log bundle, history, stats, context, incidents, judge cases, run conditions (`manifest`), git, changes; plus Stats, the about page and the trees' disk use (`trees.json`) |
| `enso/evidence/snapshot-store/` | the project's snapshot store (#551), each file hard-linked (#740; copied where the run directory is on another filesystem), so pruning the home costs the run nothing |
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

  `start` collects such a run itself before it starts another (#742), and `act` on a dead run says
  so. A stack is stopped only when it is `bun run dev <that run's project>` exactly, and then as a
  whole tree. Observed 2026-10-05: a recorder killed with SIGKILL took its stack down within 2 s, so a
  surviving stack is the rarer case; under a scope, the launcher stops what is left either way.
- **Every UI action goes through the recorder**, so each is in the trace (as a named group) and on the
  timeline. There is no selector, no `evaluate`, and `goto` refuses `/api`.
- **The agent has no shell** under `--agent` (above). Under `--manual` it is whatever you give it, and
  the manifest says the boundary was not held.
- **Secrets.** Typed text that looks like a credential is refused, not typed: what is typed is in the
  trace's DOM snapshots and on screenshots, and a screenshot cannot be scrubbed. Text the recorder writes
  (timeline, Enso's output, evidence) is redacted with the run's secret values: `secrets.env`, the
  environment's secret-shaped names, and the OAuth tokens and keys in `auth.json`.
  - The set grows during the run: when a refresh rotates a token, the new one is added and the old
    one stays.
- **Every file the run keeps is scanned for those values (#610, #741).** That includes each trace zip,
  entry by entry, where Playwright keeps the network response bodies. A zip is read one entry at a time
  from its central directory, so a whole run takes under a second and under 200 MB.
  - Each trace chunk is scanned as it is written; the stop scans what changed since. The manifest's
    `secretScan.scanned` stamps each file it read (path, size, mtime), and a later scan reads only files
    that changed, or that it now knows more values to look for.
  - The manifest's `secretScan` names each hit by file and entry, never by value, and any hit fails the
    score.
  - A file or directory it cannot read is an `unreadable` warning, and the rest is still scanned:
    not scanned is not clean.
  - `arena manifest` scans again with the home the run recorded, reading only changed files, and keeps
    every earlier hit whose file still exists. A rotated token is a value it can no longer look for, so
    a hit it cannot re-check stands.
  - Not read: `.enso/` (the links, by design), symlinks, and pixels: screenshots, the trace's screencast
    frames and image resources, and fonts. A secret Enso puts on screen is still not caught in a
    screenshot.
- **The agent's account is not proof.** The manifest keeps its notes apart from what the recorder
  observed; the review must cite the evidence for each point, and every bug filed says it is
  unverified and names the run. Verifying those, and triaging the filed bugs, stays a person's step.
- **Not collected yet:** the Diff Viewer's data (no read route for a run). The snapshot store (#551)
  is copied into the run when it exists, and marked missing when it does not.
