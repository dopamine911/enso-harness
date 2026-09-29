# Glossary — one word, one meaning

The vocabulary of Enso, by domain (#161, under #162). This document is the authority for what a
word means here; `architecture.md` → *Nouns* keeps the identity table and defers to this for
everything else.

Two rules built the document, and every edit keeps them:

1. **Sections are domains.** A domain is a question the system answers, not a layer of the code, a
   package, a directory or a vendor. A term lives under the question it belongs to — *run* beside
   *turn* and *thread*, *guard* beside *permission mode* — even when the code that defines it lives
   three directories apart. Where a domain has machinery of its own (a lease, a feed, a sink), the
   machinery is listed under a **Mechanism** heading inside the domain, below the concepts, never as
   their peer.
2. **Definitions are ours.** An entry is *meaning · id · minted by · owner and lifetime*, in prose. No
   copied type, schema, event union or field list from anything we vendor. Where a definition wants a
   shape it points at ours in `@enso/core` by name only, never by body — and never at theirs. Vendor
   names appear in exactly one place, the [vendor map](#vendor-map) at the end; a definition that needs
   the map to be understood is wrong. The one other place a vendor's name appears is the
   [Retired](#retired) table, where a vendor-prefixed identifier is quoted in order to be renamed.
   `test/glossary-doc.test.ts` holds this document to that: no vendor word before the Retired heading.
   The same rule over the source tree is `test/vendor-gate.test.ts`; the retired words applied to the
   source tree are a sibling issue under #162.

One convention makes rule 2 possible. **The runtime** is the vendored agent loop this harness is a
package for: it owns the loop, the model providers, the durable log and compaction; we own tools, guards,
state and the two surfaces. Its name is in the vendor map. Everything below that says "the runtime" means
that, and nothing of ours is defined by its shapes.

The six domains, and the axis they fall on. The control plane's own rule (invariant 2, #144) is that
**a route tells the runtime; the feed says what happened** — control and observation are separate, and
never on one surface. The domains follow that axis outward:

| Domain | The question it answers |
|---|---|
| [Thread](#thread) | what is the unit, and what state is it in |
| [Control](#control) | what a human does to a thread |
| [Permission](#permission) | what may run, and who decides |
| [Observation](#observation) | how state is seen, and by whom |
| [Record](#record) | what is durable, and what is written |
| [Surface](#surface) | where it is rendered |

After the domains: [project vocabulary](#project-vocabulary) (words about how the repository is built,
not about the system — kept apart on purpose), the [Retired](#retired) table, and the
[vendor map](#vendor-map).

How to read an entry: **term** — what it is, in one or two sentences; then, where the term names a thing
with identity, its *id*, who *mints* it, and who *owns* it for how long. Where the code still uses
another word, the entry says so and the Retired table carries the rename.

---

## Thread

One conversation is a **thread**; the runtime keeps its durable log; a **run** is one acquisition of it.
Everything with identity in this system hangs off those three, and the strict rule is what to call
each: `thread` is the noun everywhere the id crosses; `session` is reserved for the runtime's log.

| Term | Meaning | Id | Minted by | Owner, lifetime |
|---|---|---|---|---|
| **project** | a working tree threads run in (#395) | `projectId` (its canonical path, hashed) | the launch directory, or registered from a page strictly under a root the install declares — a request never chooses a path the install did not allow | the registration; a thread's is fixed when its session is created |
| **thread** | one conversation, the user-facing unit: what the rail lists, what the URL names, what a run acquires. `thread` is the noun for the id everywhere it crosses — routes, wire types, the browser | `threadId`, UUID-shaped (`isEnsoThreadId`), validated as a filename component at every entry point | the browser, or reused from a stored thread on resume | the registry's entry while live; the id outlives it |
| **session** | **reserved**: the runtime's durable, append-only log and the runtime's own live object over it. Nothing of ours that means *thread* may say session. *Decision (1):* the one legitimate Enso-owned use is the three fields that locate that log — `sessionId`, `sessionDir`, `sessionFile` on an inspection — because they name the log, not the conversation | the same string as `threadId` (#95) | the runtime, under the browser's id | 1:1 with the thread; the log outlives everything |
| **stored thread** | a thread whose log is on disk and can be resumed: what the rail lists after a restart. Wire: `EnsoStoredThread` | `threadId` | the runtime's first flush — the file does not exist until the first assistant message; a fork's is written when it is made (#433) | the storage seam lists it; the file is the record |
| **entry** | one line of the runtime's log: a message, a tool call, a tool result, a model change, or a custom entry an extension persisted | the runtime's entry id and parent id | the runtime | carried verbatim, read defensively, never modelled above the host — since [leak L2](./seams/README.md#leak-numbers) the branch is read as `EnsoTranscriptEntry`, a type of ours |
| **branch** | the root-to-leaf chain of entries the runtime currently considers the conversation; a stored thread's history is its branch rebuilt as messages on every cold read | entry ids | the runtime | the runtime; moved by tree navigation and by a fork |
| **custom entry** | an entry an extension appended to persist its own state — the permission mode is one, a guard refusal (#387) another, the run context (#435) a third; the host appends one too, the thread's system prompt (#443). The pattern for anything durable that must travel with a fork | `customType` | the appending extension, or the host | the log; a fork inherits it by construction |
| **fork** | a new log whose header names its parent; the branch is copied to the fork point. Made from the browser at a user message (#433): the fork holds everything before it, and its composer opens holding the message's words; the listing names the parent as `parentThreadId` | a new thread id; `parentSession` in its header | the runtime | the runtime |
| **system prompt** | the head of every request the model receives: the runtime's sections (preamble, tools, rules, docs, project context, skills, cwd) and the tool definitions. A thread's is **the runtime's default** unless it started with a library prompt (#443) — chosen before the first request (a later choice before it replaces the earlier one), and from then on **fixed for the thread's life**: a head rewritten per turn throws the prompt cache away. The choice is recorded in the log as the `enso-system-prompt` custom entry, text included, so a resume and a fork run what the thread started with. `EnsoSystemPromptChoice` | the library prompt's id and a sha256 of its text | the Start dialog's `POST …/configure` | the log |
| **fork point** | the position a fork was taken from, and what it ran under (#435): its identity — the thread, the branch's leaf entry, the parent — and its conditions — model, thinking level, mode, cwd, and the latest run context (project revision, config, skills, context files, the mode's rules). `EnsoForkPoint`, served by `GET /api/threads/:threadId/manifest` | the leaf entry id | derived from the branch on read: the runtime's entries and Enso's custom entries | never stored; the manifest route and the debug drawer read it |
| **run** | one acquisition of a thread: from a prompt's admission to *settled*. Not one prompt — prompts during a run queue into it, and steering, follow-ups and retries all land inside one run. The unit a receipt names and a log record belongs to | `generation` | `acquire()` | the lease; ended by the settle observer, never by a route or a click |
| **generation** | the run's number: per thread, monotonic for the server's lifetime, kept across dispose, **reset when the server restarts** — which is what "lost session" means. The stale-lease fence, and the receipt the browser compares against | integer, memory only | the registry | — |
| **turn** | one model request and the tool results it produced, as the runtime marks it (`turn-start` / `turn-end`). *Decision (6):* this is the only meaning; the status bar's "turns" (a count of user messages) is a **prompt** count and is renamed. Several turns make a run | — | the runtime | — |
| **step** | **not a word of ours.** The state layer's stream calls a turn a step; a tool call rendered in the transcript is a *tool call*, not a step (`ToolStep` is renamed). *Decision (6):* turn for one model request, run for the owned interval, nothing called a step | — | — | — |

**States.** A thread has two while live, and a parked question is *busy* — there is no third.

- **busy** — a run holds the thread: streaming, or blocked on a parked question.
- **idle** — no run holds the thread; the idle timer is armed (30 minutes) and the next acquire cancels it.
- **parked** — a dialog is open and the run is waiting on its answer. Parked *is* busy — it is the reason a
  stale handle needs the generation, not a state of its own.
- **live** / **cold** — live: a runtime session exists in memory (a registry entry). Cold: a stored thread
  with none; its history is read from the file.
- **settled** — the run's end as the runtime declares it. Distinct from *run-ended*, after which the
  runtime may still retry; only *settled* ends a run, in the registry and in every browser.
- **resume** — mount a stored thread under its own id: history and mode as recorded, then live. Not a code
  identifier — the history route plus adoption in the browser.
- **dispose** — tear a live thread down: cancel its open dialogs, tell extensions, drop the runtime
  session. Reached only when no run is in flight; the generation counter is kept.

**Mechanism** — how the server holds a thread (`thread-registry.ts`):

- **registry** — the one table of live threads; the serialiser of writers (invariant 4: one live writer
  per log).
- **acquire** — take a thread for a run: build its runtime session if needed, wait out any abort in
  flight, increment the generation, cancel the idle timer. The only way a thread becomes busy.
- **lease** — one run's hold on a thread, bound to its generation; `release` and `stop` through a stale
  lease are inert. Lives in the prompt route's closure.
- **release** — end of a run: busy off, idle timer armed. Called by the settle observer only.
- **peek** — inspect a thread *if* it is live; never builds one. Looking must not build (#86): every read
  route peeks.
- **idle timer** — what turns idle into disposed after 30 minutes without a run.

## Control

What a human does to a thread, and the one shape every act has: **a route tells the runtime; the feed
ends the wait** (invariant 2). Every route is unary — prompt, abort, answer — and answers at admission;
what the act caused arrives on the follow, for every follower alike. Nothing here closes a run.

- **prompt** — what a user sends: text, optional images as bytes, and a streaming behavior. Crosses
  `POST …/prompt` as `EnsoPromptBody`. A prompt is not a run and not a message: it is *admitted*, and
  the follow carries everything after.
- **library prompt** — one markdown file in the **prompt library** (`ENSO_HOME/prompts/<id>.md`, #443): a
  closed frontmatter block (`name`, `description`, `category`) and a body. Its **category** says where
  the body goes: `system` replaces the runtime's preamble, `append` adds to the runtime's — those two are the
  **system-prompt modes**, a thread's system prompt taken from the library — and `session` is a
  **session prompt**, a saved prompt that fills the first message and changes nothing in the system
  prompt. A file the library cannot read or parse is *refused by name*, never skipped. Its
  **preview** is the runtime's own rendering of the system prompt a thread's next request would carry
  with it, section by section, each marked as the library's or the runtime's (`EnsoSystemPromptPreview`,
  `GET …/system-prompt`); its total is what the Context tab prices that first request at. Wire:
  `EnsoLibraryPrompt`, `EnsoLibraryPromptListing`. Not a prompt template: the runtime's templates are slash
  commands, and a library prompt is not one.
- **message** — what the transcript holds and the model sees: a user message, an assistant message, a
  tool call and its result. Rebuilt from the branch on every cold read.
- **messageId** — one prompt admission; how a rejection names its prompt. *Id:* UUID. *Minted by:* the
  prompt route. *Owner:* one receipt.
- **admission** — the prompt route's job: validate, acquire or queue, answer. The run is not an HTTP
  response (#112).
- **receipt** — what admission answers with: the `messageId` and the generation the prompt took or
  queued behind, at 202. The browser opens its run from it; the follow delivers the rest. (The project
  method also says *receipt run* for a repeatable verification with evidence — see project vocabulary.)
- **prompt-rejected** — an observation, not an HTTP error: the runtime refused a prompt after admission,
  named by `messageId`, with its reason.
- **admission** — what a prompt asks for when a run is already in flight: **interrupt** (enter at the
  next turn boundary) or **enqueue** (wait for settle). Required then; rejected otherwise. Enso's two
  words since #216; the runtime's own pair is produced under `host/` and nowhere else.
- **queue** — the prompts waiting behind the run in flight: the interrupting ones first, then the
  enqueued. An observation every follower sees; the list above the composer.
- **abort, stop** — by thread, not by lease (#116): "whatever runs now". Clears the queue first and hands
  the texts back — **clear-and-restore** (#75): to the tab that stopped, never delivered unasked on the
  next turn, never dropped. Settle still ends the run.
- **image** — bytes with a mime type, never a URL: the schema has no field for one, so a server-side
  fetch cannot be asked for (#68). Caps live where the bytes are counted.
- **dialog** — a question an extension asked that blocks the run until answered: a choice, a yes/no, a
  line of text, or an editor. *Id:* from the asking extension. *Owner:* the runtime's open-dialog list;
  the browser holds one card slot (#114). Every settle path emits *dialog-settled* so every follower
  drops the card; the snapshot lists every open question so a reconnect renders it at once.
- **dialog kind** — `select`, `confirm`, `input`, `editor`. *Decision (5):* these four are **ours by
  adoption**: they are the right set of primitives for a surface, `EnsoDialogSpec` names them, and an
  answer is validated against the question's kind. They are not renamed and not mapped. A fifth,
  `questionnaire`, is **ours outright** (#12): the agent's `ask_user` questions, asked as one card and
  answered as `{ answers }`. The runtime has no such method; the host lifts it from the tool's component.
- **answer** — the response to one dialog, `POST …/dialog`, validated against the question; 204 when
  the question was spent.
- **outcome** — how a dialog stopped waiting: `answered` (a human's value), `cancelled` (the browser's
  cancel or the thread's teardown), `timeout` (the extension's own), `aborted` (the run's abort).
- **notify** — a one-way notice from an extension (`info`, `warning`, `error`), shown as a transcript
  line; nothing waits on it. Status-bar text addressed to a terminal is dropped, not shown.
- **command palette** — the chat page's `/` menu (#338): every slash command the thread can run,
  grouped by source (extension, prompt, skill — and `host` once ours land), filtered as you type.
  Its list is `GET …/threads/:id/commands`, which says whether it came from the live session, the
  last built one (`remembered` — this thread has no live session; every session builds the same
  set from the same sources, as they stood at that build), or nowhere yet — looking must not
  build (#86). Selecting an
  extension command sends it as a prompt; a template or skill is inserted for its arguments; a
  **host command** runs through `POST …/threads/:id/command`.
- **host command** — a slash command that is ours, not the runtime's (#338 slice 2): `source: 'host'`,
  declared by **kind** — `select` (one of many options, filtered in a second step: `/model`),
  `level` (one of a few, chosen in place: `/thinking`), `flow` (chosen like a select, but the choice
  STARTS something: `/login`, `/logout` — the route answers 202 and the flow's questions arrive as
  dialogs, its progress as notify lines, its end as a `model` observation), `action` (runs with no
  value: `/compact`, a model call that starts like a flow and ends with a notify line), `view`
  (the page does it: opens what it names over the chat — `/context`, #361 — or forks at the last
  prompt — `/fork`, #433 — through its own route; nothing is posted to `…/command`). The palette
  renders by kind; nothing is per-command UI. Running one builds the thread if
  it has no session: choosing the model BEFORE the first prompt is the point (#341, the control half
  of #44).
- **model state** — `EnsoModelState`: the session's model (`provider`, `id`, `name`; `null` when
  the runtime has none it can run), its thinking level and the levels the model offers. On the
  snapshot frame at run start and as the `model` observation whenever it changes — by the palette,
  by an extension's failover, or by a resumed session. The composer chip reads nothing else.

## Permission

What may run, and who decides. Two things decide today and they are one domain: the **permission
mode** says what the run may do without asking; the **guards** refuse what no mode may allow. Both
answer before a tool runs; nothing after it does.

- **permission mode** — the policy under which tools run: `default`, `acceptEdits`, `plan`,
  `bypassPermissions`, plus any mode an extension registers. Persisted as a custom entry; the last one
  on the branch wins, uncached because tree navigation moves the leaf (#84). Named in the run receipt;
  shown as **mode lines** in the transcript and a select in the status bar that says `unknown` when it
  is unsure (invariant 5). The mode *concept* is ours; today's implementation is a vendor extension
  read below the seam since [leak L3](./seams/README.md#leak-numbers) closed it (#162 workstream 4).
- **mode** — the permission mode, and nothing else. *Decision (3):* the runtime's own interface setting
  (interactive, non-interactive, driven in-process) is **not given a word of ours**: no Enso code
  tracks it, and `surface` — the candidate — already means TUI-or-web. It stays under the host and in
  the vendor map.
- **guard** — the extension that answers the tool-call hook before a tool runs. What startup asserts is
  that the policy's gated names are **registered** (`verifyPolicyToolNames`, presence), never that they
  resolve to our implementation: identity is unasserted, and the veto does not depend on it. A guard
  *decides*; nothing else on the path does.
- **verdict** — a guard's answer: a **denial with its reason**, or nothing — the call passes. There is
  no third value today. *Cannot vouch* (an unparseable construct at command position) is refused with
  the construct named, so the rewrite is obvious; routing it to a human instead is the ask channel's
  job (#12) and a freeze-review decision. Every verdict is a log record: a denial at `warn`, an allow
  at `debug`, never silent.
- **policy** — what a guard reads: write roots, secret path fragments, protected write fragments,
  denied network binaries. `GuardPolicy` in `@enso/core`: `DEFAULT_GUARD_POLICY`, in code.
- **rule** — the refusal site a denial names, from the closed vocabulary `ENSO_GUARD_RULES` in
  `@enso/core` (`network-egress`, `secret-read`, `stale-write`, …): the word beside a verdict's prose
  reason that a day's stats count by (#144). The command analyzer's own `ruleId`, when it has one, is
  quoted inside the reason, not promoted to a rule of ours.
- **participant** — one handler on the tool-call hook. Handlers are additive: every participant's handler
  runs and the first denial ends the call, so a denial is final whatever the load order. First-wins
  resolution applies to registered *tools*, not to handlers, and the guard registers none — see
  [architecture](./architecture.md), *Ownership boundary*.
- **arbiter** — the one handler that would own the verdict, with participants as libraries beneath it
  (#4). Designed, deferred: two participants with aligned fail direction are tolerable. A design word,
  not a code identifier.
- **boundary** vs **bar** — a boundary is enforced where it cannot be argued with (a sandbox, a network
  namespace); a bar is a classifier that raises the cost of the easy cases. The network egress guard is
  a bar and says so; a bar's content comes from incidents.
- **workspace boundary** — the tree a write may touch: the project plus declared write roots. Follows
  the worktree, once threads have their own (#147).
- **tool identity** — the canonical name a tool resolves to, once, centrally, case-insensitive: the
  reason `Write` and `write` are the same guard's business.
- **read-before-write** — the guard that refuses an edit to a file the run has not read as it currently
  is (#10), and a whole-file `write` to one it has read only part of (#57 S2).
- **egress** — a network call at command position, or a device that makes one. Denied by name, and by
  construct when the name cannot be resolved.
- **secret** — a value that must not reach the model or the log: quarantined from the process
  environment, read per call by the extension that needs it, and **redacted** by field name at write
  (see Record).

## Observation

How state is seen, and by whom. Three words for three hops, on purpose: the runtime emits **events**;
the host maps them to **observations**; the follow carries **frames**. There is no fourth word of ours
(see *chunk*, Retired). And one rule for every surface that looks (#144): **observation reads, writes
nothing, records nothing, controls nothing** — the drawer, the dashboard and the inspection routes are
observation; stop, answer and prompt are Control, and never share a surface with it.

- **event** (runtime event) — the atomic thing the runtime emits about a thread: a text delta, a tool
  call starting, a turn ending, a question asked. Never on our wire, never stored by us. Minted by the
  runtime; seen only under the host.
- **observation** — one semantic fact about a thread, in our vocabulary, derived from an event by the
  host's mapper: `EnsoObservation` in `@enso/core`. The wire between server and browser (#112), and the
  thing a log record at `debug` describes. Derived in memory, never written. Each has a **kind**
  (`text-delta`, `tool-call`, `tool-result`, `queue`, `settled`, …); one kind, **unmapped**, carries an
  event the mapper has no word for yet, so nothing is dropped silently.
- **seq** — an observation's position on its thread: monotonic per thread, the identity a browser and
  the server compare. *Id:* integer. *Minted by:* the registry, at publish.
- **frame** — one unit the follow transmits: a **snapshot**, an **observation** with its `seq`, or a
  **status**. `EnsoFollowFrame`.
- **snapshot** — the first frame of every follow: the thread as of `asOfSeq` — history, open dialogs,
  queue, mode, busy and generation. **The snapshot is the resync** (invariant 3): nothing is replayed
  by cursor; a reconnect opens a new follow and gets a new snapshot.
- **asOfSeq** — the `seq` a snapshot is complete through; the observations that follow start after it.
  The watermark that lets a browser say which boundary it diverged at.
- **status** — the frame that says whether the thread is live, busy, and at which generation. Closes a
  run in every browser alike; a status that says busy with no run to match opens an *external* run.
- **follow** — one browser's subscription to a thread: snapshot, then frames, until the page or the
  server drops it. A dropped follow is said (`follow-ended`), never silent. *Id:* none — per page,
  per thread. *Minted by:* the follow route. *Owner:* the page.
- **tail** — the recent events kept for inspection (#97). Two per thread: the **emitted tail** (what
  the host received from the runtime, with how) and the **sent tail** (what the server put on the
  wire). A **mismatch** between them, or between the page's belief and the server's, is named, never
  hidden (invariant 5).
- **provenance** — how an event reached its subscriber: `live`, `held` (buffered until the first
  subscriber), `replayed`, `dropped`, `sent`. Tagged at the source, never inferred; the axis an ordering
  bug lives on.
- **timeline** — one thread's two tails and its log records, as one list ordered by each row's own
  stamp: `threadTimeline` in `@enso/core`, shown at `debug.html?thread=<id>` (#144). The join keys
  are uneven — a log record carries `generation`, `seq`, `toolCallId`; a tail event only its own
  `sequence` — and the page says so rather than guessing.
- **origin** — where a dialog request was raised: during thread start (`session-start`, before any run)
  or inside a run. Tagged at the source.
- **inspection** — one live thread in full, as a read: its ids, busy and generation, the branch, the
  mode, what it may run. `EnsoThreadInspection` on `GET …/threads/:id`; a **summary** is the same at a
  glance, for the list. Peeks, never builds.
- **custom event** — in the browser, an observation that is not part of the transcript proper — mode,
  queue, dialog settled, follow ended — routed to its store by the name it already has: the
  observation's `kind`, or the frame's `type` for a snapshot or status (#162 workstream 5). The
  browser's word for these is *custom event*, not chunk.

**Mechanism** — how observations move:

- **mapper** — the one function that turns a runtime event into an observation (`map-events.ts`); the
  place a new event kind gets a word, and the only place the runtime's event shapes are read.
- **feed** — the server-side fan-out for one thread: its observers, its `seq` counter and its sent
  tail, independent of whether a run is in flight. One per live thread; owned by the registry.
- **adapter** — the browser's side of the follow: opens it, hands the snapshot to the stores, and
  derives the state layer's stream from observations in memory — never on the wire, never stored.

## Record

What is durable, and what is written. Two things are written and they are not the same: the runtime's
**log** (entries; the record of the conversation) and our **log file** (records; the record of what the
harness did). The first is canonical and never rewritten by us; the second is the export.

- **entry** — see Thread. One line of the runtime's log; a *branch* is a chain of them; a *custom
  entry* is an extension's. Not a record.
- **record** — one line of *our* log file, `ENSO_HOME/logs/enso-YYYY-MM-DD.jsonl`: a message that is an
  *event* with placeholders, and properties that stay structured (`threadId`, `generation`, `seq`,
  `toolCallId`) so a file can be filtered, not grepped. Written unbuffered and **redacted at write**.
  Not an entry.
- **level** — five: `trace`, `debug`, `info`, `warn`, `error`. Tiers on one knob: `info` is the
  **spine** — what happened; `debug` is every observation, one compact line; `trace` is the same with
  the payload. `trace` is a level, never a noun for an execution trace.
- **layer** — the region of our code a record came from, by logger category: `server`, `host`,
  `extension` (our code inside the runtime's process), `browser`. *Decision (4):* **kept**, with this
  one meaning — a layer is a region of our code behind a seam, the same sense as *state layer* and
  *presentation layer* under Surface. It is not the process, and it is not "who to blame".
- **process** — which launcher's operating-system process wrote the record, stamped on every line
  because the file is shared. A browser's records arrive at `POST /api/logs` and are re-emitted by the
  server as process `browser`, into the same file, through the same redaction.
- **redaction** — by field name, at write, before anything reaches the file; the **redaction
  manifest** in a bundle lists which field names and value markers were redacted, so a reader knows
  what is missing without seeing it.
- **bundle** — the export: a markdown file with the `about` block, the live threads' inspections, the
  day's records fenced as JSONL, the redaction manifest, and the browser's ring. What a user hands over.
- **about** — the process's own facts: versions, checkout, knobs, pid. The same block heads the bundle
  and answers `GET /api/about`.
- **log tail** — the day's file read forward as it grows, filtered by the reader's question: what
  `bun run logs --follow` prints and what `GET /api/logs/tail` streams to the debug page, over one
  filter (`logLineMatches`) and one decoder. A **backlog** frame is the file as it stands and
  replaces the reader's view; a **records** frame is what has landed since. Never a second store:
  the log tail reads the same file the bundle exports (#144). Not the event *tail* under
  Observation, which is a thread's recent events kept in memory.
- **day stats** — the day's file folded into figures: spend per thread and per model, run and turn
  durations, time to first token, tool durations, denials by rule, and who wrote. `dayStats` in
  `@enso/core`, answered by `GET /api/logs/stats` and shown at `debug.html?stats` (#144). Every
  figure is derived from records; if one cannot be, the file gets the record, never a counter.
- **event name** — a record's message TEMPLATE, values unrendered: what a bundle filters on and
  what a stat folds over. Declared once in `ENSO_LOG_EVENTS` and imported by the producers.
- **config** — the user's `ENSO_HOME/config.json` (#59, #421): absent is the defaults in code, and a
  file that is there is read once per session and fails closed when unreadable. A trusted project's
  `.enso/config.json` merges over it for that project's sessions.
- **project trust** — the runtime's decision that a project's own files may change a session: the
  runtime's project directory, and the project's `.enso/config.json` (#421). One store, the
  runtime's `trust.json`; asked once per session when undecided; untrusted, the project's config is
  skipped and the session is told. Secrets are not config: `ENSO_HOME/secrets.env`, read per call, quarantined.
- **ENSO_HOME** — the user's Enso directory, `~/.enso` unless the variable says otherwise (#421): the
  runtime's agent dir, the secrets file, the logs and the project list, shared by every checkout. A checkout's
  old `.enso/` is moved into it on launch, never overwriting.
- **run provenance** — what a fork point records beyond the runtime's own entries — project revision, context
  files, the mode's rules, skills, configuration — as the `enso-run-context` custom entry in the
  runtime's log, never a side file (#435, #126). Hashes and paths, never contents.
- **session eval** — a thread's mechanical scorecard and event timeline (#441), computed from what the
  session recorded and nothing else: `EnsoSessionEval`, served by `GET /api/threads/:threadId/eval`
  and printed by `bun run eval`. Named metrics, never a composite; a *signal* is one agent-side
  metric of it, reported per kind and unweighted. Ported from `session-timeline.py`.
- **friction** — what the operator *types* against the run: corrections, queued prompts, confusion,
  interrupts. The eval's `f=` counter. Kept apart from the *refusal channel* because the two move at
  different times.
- **refusal channel** — where a refusal came from, never mixed: a guard's (policy, the
  `enso-guard-denial` entry), the operator's (a person: a declined ask, or an *operator denial*), the
  provider's (#381). The eval counts each on its own; only the operator's is the `r=` counter, what
  the operator *clicks*.
- **operator denial** — the operator pressed No on a permission prompt. Recorded by the host as the
  `enso-operator-denial` custom entry (#441), because the permission extension turns it into an
  ordinary error result and nothing else keeps which button was pressed.

**Mechanism** — where the bytes go:

- **storage seam** — `AgentHost`: the only file that touches the runtime's session manager or its
  file layout. Nothing above it sees a path except as debug text. Keeping it so is what makes a later
  store a one-file change (#102 §1).
- **sink** — the writer at the end of the log pipeline: the file, and optionally a console.
- **ring** — the browser's in-memory recent records, at every level, that the drawer appends to a
  bundle; the server sees only what the browser ships at `info` and up.

## Surface

Where it is rendered. Two **surfaces** over one loop; in the web surface, two layers with a fixed seam,
and the regions of the page.

- **surface** — one of the two clients of the one agent loop: the terminal UI and the web app. A feature
  is written once and rendered per surface.
- **state layer** — the vendored client that holds messages and runs in the browser and connects through
  a send/subscribe adapter that is exactly prompt/follow. Its stream vocabulary is derived in memory from
  observations by our adapter, never on the wire, never stored.
- **presentation layer** — components ported file by file from an upstream component library under a
  provenance header, with upstream's types retyped as they cross. Port before you build; a hand-rolled
  component names its reason in its header (#31, #121).
- **pane** — the active thread's view; the URL names it (#142) and the page follows the URL.
- **transcript** — what a pane shows of a thread: its messages, mode lines, notices and tool rows, in
  order. Not the branch (the runtime's) and not the log file (ours).
- **rail** — the list of threads: live ones with a pulse, stored ones by title and age. Says *threads*.
- **composer** — where a prompt is written: text, attachments, the queue list above it, and two buttons
  of ours — send and stop — because a prompt in flight and a stop are different acts.
- **card** — the one dialog rendered at a time, from the snapshot or from a dialog observation, dropped
  on *dialog-settled*.
- **drawer** — the debug pane beside the transcript: this tab's belief, its ring, the two tails, and a
  named mismatch. An observation surface — reads only.
- **dashboard** — the separate debug page over the log file, the threads and the processes (#144):
  reads, writes nothing, records nothing, controls nothing.
- **tool result descriptor** — the part of a tool's result that says how to render it: a `kind` and
  serialisable props, optional, beside a textual form that is always present. One payload, a
  **renderer** per surface, keyed by kind; an unknown kind still renders its text (#18).
- **indicator** — persistent state on the surface — model, mode, activity — as opposed to a transcript
  line, which is an event. Honest about staleness between runs (#44).
- **mode line** — a transcript line saying the permission mode changed, and to what.
- **row** — one rendered line of anything: a stored thread in the rail, an event in the drawer, an entry
  in the debug listing. Rendering only — an *entry* is the runtime's and a *record* is ours (see Record);
  a row is neither.

---

## Project vocabulary

Not a domain of the system: words about how the repository is built. They appear in test headers and
issues, so they are defined once, here, and kept apart from the product nouns above.

- **gate** — a test that enforces a boundary over the source tree rather than a behaviour: walk the
  roots, match, compare offenders to an allowlist, expect none. One row each in the generated
  [*Enforcement gates*](./reference/verification-inventory.md#enforcement-gates) table — twenty-two
  today, a count `test/glossary-doc.test.ts` reads off that table. Removing a root is a design
  conversation.
- **allowlist** — a gate's named exceptions, each with its reason and the leak it maps to. The list *is*
  the inventory; fixing a leak deletes a line, adding a dependency adds one and must say why.
- **ratchet** — a number or a list that may only move one way: a complexity ceiling that may go down,
  an allowlist that may shrink. Weakening one is visible by construction.
- **receipt run** — a repeatable, scripted verification with evidence — screenshots, runtime output —
  attached to the issue or PR that claims the behaviour (#103's method). Distinct from the wire
  *receipt* under Control.
- **freeze** — the state since 2026-09-10 (#103): correctness and security blockers and enforcement
  only; no feature work until the consolidation (#162) and hardening receipts are taken.
- **seam** — a contract with one implementation on each side and a fake for tests, named and fenced.
  One page each under [`seams/`](./seams/README.md) and one row each in the generated
  [*Seams*](./architecture.md#seams) table — ten today, a count `test/glossary-doc.test.ts` reads
  off that table. A seam is proven by the second implementation, not designed against the first.
- **leak** — a place where a vendor's name or shape crosses a seam it should not; each is one
  allowlist line until fixed. The six are numbered `L1`–`L6` and defined in
  [`seams/README.md` → *Leak numbers*](./seams/README.md#leak-numbers), with the page that states
  and checks each. All six are fixed or decided (#162): the vendor gate's import allowlist is empty,
  and the seams table on the architecture page reads each seam's own statement of what crosses it.

---

## Retired

Words this document takes out of circulation, and what replaces each. Applied by LSP in #165, and
held by `test/glossary-gate.test.ts`: a retired identifier or file name may not come back in code
outside the two vendor roots. *Legitimate* names where the old word may still appear: vendor code under
`packages/web/src/host/` and `packages/harness/extensions/`, the vendor map, the three log-locating
fields, and the gate that spells the words in order to refuse them. The `Pi*` names of the thread
runtime's own shapes (`PiPromptRequest`, `PiRpcEvent`, …) went with them — goals L1 — to `PromptRequest`,
`RuntimeEvent`, `RuntimeCommand`, `DialogAnswer`, `EnsoPromptAdmission`, `PromptImageContent`,
`EnsoPermissionModeState`. `RuntimeEvent` and `EventDelivery` left `@enso/core` with L2 (#162
workstream 4): the runtime's event and stored-entry shapes are read only under `host/`
(`runtime-event.ts`, `map-events.ts`, `transcript.ts`), where the `Pi*` prefix is allowed to say so.

| Retired | Meant | Replacement | Was at | Legitimate |
|---|---|---|---|---|
| `PiSession` | the runtime contract for one thread the host implements (prompt, abort, answer, subscribe, dispose) | **`ThreadRuntime`** — the seam has a name that says whose it is. *Decision (2):* not `HostSession` (session is reserved) and not `EnsoSessionRuntime` (same reason) | `packages/core/src/pi-rpc.ts` | — |
| `HostedSession`, `HostedSessionInspection` | the host's side of a live thread: the runtime plus inspect and the emitted tail | **`HostedThread`**, **`HostedThreadInspection`** | `packages/web/src/host/agent-host.ts` | — |
| `StoredSession` | a thread whose log is on disk, as the host lists it | **`StoredThread`** — the wire already says `EnsoStoredThread` | `packages/web/src/host/agent-host.ts` | — |
| `EnsoCustomSessionEntry` | a custom entry observation | **`EnsoCustomEntry`** | `packages/core/src/observation.ts` | — |
| `session-inspection.ts` | the thread inspection module | **`thread-inspection.ts`** | `packages/core/src/` | — |
| `describeSessionEntry` | the formatter for one entry of a transcript | **`describeTranscriptEntry`**, in `transcript.ts` — the entry is the transcript's, so the formatter moved there with it | `packages/core/src/` | — |
| `pi-rpc.ts` | the module holding the runtime contract and its wire shapes | **`thread-runtime.ts`** — the name says a transport it no longer is (#69) | `packages/core/src/` | — |
| `enso-session.mjs` | the thread inspection CLI | **`enso-thread.ts`** | `scripts/` | — |
| "sessions" (rail heading, prose in the browser) | threads | **threads** | `packages/web/src/threads-rail.tsx` | — |
| `sessionId`, `sessionDir`, `sessionFile` | where the runtime's log is | **kept** — they name the log, which is what session means | inspections, the CLI | yes |
| `chunk` in Enso-owned names (`RecordedCustomChunk`, "said as a chunk") | a custom event the browser recorded | **custom event** (`RecordedCustomEvent`) — chunk is the state layer's word and stays in its adapter | `packages/web/src/custom-event-router.ts`, comments | the adapter that derives the state layer's stream |
| `turns` as a count of user messages | prompts | **prompts** | `packages/web/src/thread-status.tsx` | — |
| `ToolStep`, "step" | a tool call rendered as a row | **tool call** (`ToolCallRow`) | `packages/web/src/selected-message-part.tsx` | the adapter that emits the state layer's step events |
| `HostedThread.session` (was `hosted.session` at every call site) | the thread's runtime handle | **`HostedThread.runtime`** — found by the gate: a field that said session and held the runtime | `packages/web/src/host/agent-host.ts` and the server | — |
| `describePiRpcEvent` | the event tail's one-line description of what arrived | **`describeObservation`** — it describes an OBSERVATION, which is what the tail holds now (L2) | `packages/web/src/host/event-tail.ts` | — |
| `data-enso-tool-step` | the tool-call row's status attribute | **`data-enso-tool-call`** | `packages/web/src/selected-message-part.tsx` | — |
| `conversation`, `chat` as nouns for the unit | a thread | **thread**; *transcript* for what it shows | prose | `chat` for the state layer's object, in the adapter |
| `layer` meaning "who wrote it" in the log sense | the process | **process** for the OS process; **layer** keeps its code-region meaning | comments in `packages/core/src/log.ts` | — |
| `surface` as a word for the runtime's interface setting | — | **none** — see *mode*, Decision (3) | not in code | — |
| `abstain`, `allow` as verdict values | — | **none** — a verdict is a denial or nothing; the three-valued verdict is #4's design, not today's code | `.local/refactor/goals.md` §4 | — |

---

## Vendor map

The only place a vendor is named. One row per term of ours; a column per thing we vendor or compare
against. Read it to find our word when coming from theirs — never to define ours.

**Columns.** *runtime* — pi (`@earendil-works/pi-coding-agent`), the agent loop this harness is a
package for. *dsh* — deepseek-harness, the reference harness the #109 spike read. *state layer* —
TanStack AI in the browser, and the AG-UI stream vocabulary its processor consumes. *mode extension* —
picc (`picc-permission-modes`), which implements the permission mode today. *analyzer* —
cc-safety-net, the command analyzer the bash guard wires as a library. *log substrate* — LogTape.

| Ours | runtime (pi) | dsh | state layer (TanStack / AG-UI) | other |
|---|---|---|---|---|
| thread | the session id (`sessionId`) | `SessionId` | `Chat` (the client object) | — |
| session (reserved) | `AgentSession` + `SessionManager` + the JSONL log | `Session` (log) + `Agent` (live handle) — ours fuses both under one id, deliberately | — | — |
| `ThreadRuntime` (was `PiSession`) | `AgentSession`'s surface, driven in-process (#69) | `Agent` | — | — |
| entry | session entry (`SessionEntry`: message, tool-call, custom, …) | event in the log | — | — |
| branch | `getBranch()`: root→leaf | — | — | — |
| custom entry | `appendEntry` with a `customType` | — | — | mode extension's `modes` entry |
| fork | `/fork`; `SessionHeader.parentSession` | fork manifest (proposed) | — | — |
| run | no counterpart — the interval from `prompt` admission to `agent_settled` | `Run` (owned interval, admission → idle); dsh's *turn* | `sessionGenerating` (a flag, not an id) | — |
| generation | — | connection generation / `openGeneration` (three counters; ours is one) | — | — |
| turn | `turn_start` / `turn_end` | *step* | `STEP_STARTED` / `STEP_FINISHED` | — |
| settled | `agent_settled` | `idle` | `RUN_FINISHED` | — |
| busy / idle | — | `AgentStatus`: `idle` or `running` | — | — |
| parked | — | no counterpart: nothing parks when prompt is unary and follow is a stream | — | — |
| peek / acquire | — | observation never activates; *promotion* after a cold follow | — | — |
| event | the RPC event union (`message_update`, `tool_execution_*`, `extension_ui_request`, …) | — | — | — |
| observation | — | — | never on the wire; AG-UI `StreamChunk` is derived from it in the adapter | — |
| frame / snapshot / asOfSeq | — | `follow()` snapshot frame; `asOfSeq` projection watermark | — | — |
| follow | — | `follow(address)` | `SubscribeConnectionAdapter.subscribe` | — |
| prompt / receipt | `prompt()` | `prompt()` unary → `{ messageId }` | `SubscribeConnectionAdapter.send` | — |
| admission (#216) | `streamingBehavior`: `steer` or `followUp`; `steer()` / `follow_up()` | inbox `next-step` / `next-turn` | — | — |
| queue | `queue_update`, `clearQueue()` | inbox `claimed` / `discarded` | the browser queue we do **not** use | — |
| dialog / dialog kind | `extension_ui_request`; `ctx.ui.select / confirm / input / editor` | approval `request()` inside a turn | — | mode extension's `FilePermissionDialog`, lifted to `select`; `ask_user`'s questionnaire component, lifted to `questionnaire` (ours) |
| notify | `ctx.ui.notify`; `setStatus` is dropped. One `ctx.ui` for every extension, so the host tags each extension's context with the extension pi loaded (`extensionsOverride`, `host/notice-sender.ts`) and a notify carries its `sender` (#387) | — | — | — |
| permission mode | — | `permission/preset` + knobs; `custom` derived | — | mode extension's modes (`default`, `acceptEdits`, `plan`, `bypassPermissions`), persisted as `customType: "modes"` |
| (no word) — the runtime's interface setting | `ctx.mode`: `tui` / `rpc` / `json` / `print` | — | — | — |
| verdict | `ToolCallEventResult`: `{ block, reason }` or `undefined` | — | — | analyzer `checkCommand` → `kind` `allow` or `deny`, with `ruleId`; a throw is a deny |
| participant / arbiter | `pi.on("tool_call")`, additive: every handler runs, the first block ends the call | — | — | — |
| tool identity | tool names `bash`, `write`, `edit`, `read` | — | — | the `picc-*` packages register `Bash` / `Edit` |
| record / level / sink | — | — | — | log substrate's `LogRecord`, categories, sinks |
| layer | — | — | — | log substrate category segment two |
| state layer / presentation layer | — | — | TanStack AI / `vercel/ai-elements` (ported) | — |
| tool result descriptor | `{ content, details, isError }` + `renderCall` / `renderResult` | — | `ToolCallPart`, `state: "output-error"` | `pi-dashboard-extension`'s `PromptComponent` (the shape's origin, MIT) |
| custom event | — | — | CUSTOM chunk, `onCustomEvent` | — |
| about | `VERSION`, exported by the host as `AGENT_RUNTIME_VERSION` | — | — | — |

What ours has that the columns do not: *parked* (dsh's design never blocks the stream), *receipt* as
a 202 body (dsh returns `{ messageId }` and nothing else), *provenance* on the tail (#97), the
*generation* as a single fence rather than dsh's three counters. What theirs has that ours does not
yet: dsh's `TurnEndReason.interrupted` for a log whose last turn never settled (ours is
`EnsoInterruptedTail`, read-only), the inbox's `claimed` / `discarded`, and runtime invariant
companions — all noted in #109.
