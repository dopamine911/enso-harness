# Magpie — harvest record

**Written** 2026-09-02 by Claude (Opus 5) at Daniel's request, for the zen-harness project.

Magpie (repo: `~/Projects/ai-projects/command-center`) is retired. Daniel: *"Magpie is dead and will be.
At a later phase we will harvest some features."* This is the record of what it was attempting, what is
worth taking, and why it stopped — written from the source on 2026-09-02, so the harvest does not begin
with an archaeology pass.

**Status when read:** last data 2026-07-14, last DB write 2026-08-03, service down since. Design plans
run 2026-04-29 → 2026-05-31.

⚠ **`.local/HANDOVER.md` is stale.** It documents a Telegram bridge (`notifier.ts`,
`telegram_handler.ts`, `dash_router.ts`) that **does not exist in the code** — no telegram file anywhere
under `packages/server`. Phase 3 was planned and either removed or never landed. Read the tree, not the
handover.

---

## What it was

Not a dashboard. Four ambitions in one service.

**Architecture.** Bun + Hono, SQLite (34 tables), React dashboard, OpenAPI spec with a Scalar UI at
`/api/docs`. Two ingest paths: OTEL traces posted to `/v1/traces`, and JSONL transcripts swept from
`~/.claude/projects/**`. Twenty-four route modules under `packages/server/routes/`.

### Ambition 1 — Observability

`lib/sync_sessions.ts` (1,525 lines) turns JSONL into sessions and tool_calls; `lib/otlp.ts` receives
the wire. Supporting sweeps for skills (`sync_skills.ts`) and subagents (`sync_subagents.ts`), plus
`live_sessions.ts`, `retention.ts`, and `heartbeat.ts`. Surfaces: an OTEL firehose, a heatmap grid,
unified failures across sources, tool-sequence views.

### Ambition 2 — Diagnosis

`packages/core/src/struggle.ts` — 941 lines of pure extractors over a session's event stream. Eight
signals, each weighted, each with its own doc under `docs/signals/` covering pattern, detection,
windowing, weight rationale, known false positives and negatives, evidence shape, and references.
Dropped signals are kept under `docs/signals/dropped/` **with the reason recorded**. Feeds a per-session
`StruggleCard` and a cross-session `/triage` ranking.

The README is candid in a way most such catalogues are not: *"These weights are guesses. See task #30
(calibration) — they will be retuned against real data when we have enough sessions."*

### Ambition 3 — Cost intelligence

The deepest surface. Under `packages/dashboard/src/components/panels/tokens/`: `CompactionCliffPanel`,
`CacheLeveragePanel`, `EffectiveVsRawPanel`, `NestedTreemapCard`, `PromptDistributionChart`,
`CostByOutcomePanel`, `TopSessionsTable`, tokens by project / model / tool.

### Ambition 4 — Command and control

This is the part that reframes the project. `lib/dispatcher.ts` (384 lines) **runs Claude Code as a
subprocess**. `lib/scheduler.ts` materialises crons. `lib/managed-loop.ts` runs background loops with an
interval floor described in its own comment as *"the footgun guard — a mistaken tiny (or zero)
configured interval can never turn a loop into a CPU-pinning busy-spin."* `lib/terminal_ws.ts` serves a
browser terminal, gated by TOTP (`lib/totp.ts`, `totp-sessions.ts`).

The command panels: `AttentionBar`, `InboxCard`, `DecisionsCard`, `DecisionLatencyCard`, `TaskBoard`,
`SchedulesCard`, `SystemHealthStrip`, `EmergencyStopBanner`.

The phase-2 plan is named `mission-control.md`, and that is what it was: observe the agents, be told when
one needs a decision, dispatch new work, and hit stop.

---

## The design idea worth carrying: two lenses, not one score

Magpie separates **struggle** from **pressure**, and the distinction is good enough to keep independent
of any of the code.

- **Struggle** is *agent behaviour*: duplicate tool calls, retries after stderr, output collapse,
  reaching for recovery commands.
- **Pressure** is *infrastructure strain*: `PressureDataSchema`
  (`packages/core/src/schemas/observability.ts:284`) is `retry_exhaustion_count`, `retry_threshold`,
  `compaction_count`, `recent_api_errors`.

Same session, two questions: is the agent floundering, or is the substrate underneath it straining? Most
tooling collapses these into one health number and then cannot tell a struggling agent from a degraded
API. Keep them as separate axes.

---

## The signals, with field results — the most valuable thing here

Magpie defined the catalogue; **quill-works then ran it against three real sessions**. Combining both
gives a harvest verdict per signal that neither repo has on its own. Do not re-derive this.

| ID | Kind | Weight | Fires (001 / 002 / 003) | Verdict |
|---|---|---:|---|---|
| S20 | `rare-command` | 2 | 0 / **4** / 0 | **Keep.** Only the bad run reached recovery tooling. One fire landed 82 s after a declined menu, inside the friction knee — the strongest cross-channel corroboration in the corpus. |
| S1 | `duplicate-tool` | 3 | 0 / **1** / 0 | **Keep, unproven.** Discriminates correctly but n=1. |
| S3 | `stderr-retry` | 2 | 0 / 2 / 2 | **Keep with caution.** Fires in the bad run *and* the good one. Partial discrimination. |
| S7 | `task-reminder` | 1 | 18 / 42 / 26 | **Drop as a struggle signal.** Fires in 3 of 3 including the good run. quill-works concluded it measures the harness, not the agent. |
| S19 | `time-gap` | 2 | 19 / 37 / 32 | **Demote.** Noisy at a 30 s threshold; a slow Bash, a subagent dispatch and an operator walking away are indistinguishable. Useful as a wall-clock histogram, not as a struggle indicator. |
| S5 | `output-collapse` | 2 | 0 / 0 / 0 | Unfired. Unproven either way. |
| S6 | `plan-mode-no-exit` | 2 | 0 / 0 / 0 | Unfired. Unproven either way. |
| S4 | `thinking-spike` | 1 | — | Never implemented. Needs a session-mean baseline and carries the catalogue's worst false-positive profile. |

### A third, independent line: hand-labelled ground truth

Magpie's `signal_labels` table holds **the only human-judged calibration data in the whole toolchain** —
eleven rows, extracted to [`data/magpie-signal-labels.json`](./data/magpie-signal-labels.json) on
2026-09-02 before the retired database is disposed of.

| Signal | Judgment | Count |
|---|---|---:|
| `time-gap` | **false-positive** | 10 |
| `rare-command` | **correct** | 1 |

Daniel sat down on 2026-05-15 and judged signal fires by hand. The verdict matches, exactly, what
quill-works concluded independently from three sessions four months later, and what the Magpie session
page shows at 123 fires: **`time-gap` is noise, `rare-command` is real.** Three methods, three
occasions, same answer. That is the strongest support any signal in this catalogue has.

⚠ **But weight it honestly, because the shape is narrower than eleven rows suggests.** All eleven labels
come from **one session** (`df9c9a29…`), judged in a **single 45-second sitting**. So it is n=1 session,
not n=11 independent observations, and the ten `time-gap` fires are ten fires *within* that session
rather than ten separate tests. It is a directional seed, not the calibration `docs/signals/README.md`
asks for.

⚠ **And the labelled transcript is gone.** Session `df9c9a29…` is no longer in `~/.claude/projects` — the
60-day `cleanupPeriodDays` cleanup removed it. The `anchor_uuid` on each row points at events that no
longer exist, so the labels cannot be re-examined, only counted. **Preserve transcripts before labelling
anything else**; a judgment whose evidence has been deleted can corroborate but can never be audited.

One detail survives that deletion and is worth keeping: anchor `c7125ec4…` carries **two labels** —
`time-gap: false-positive` and `rare-command: correct`. The same moment in the session, read through two
signals, and only one of them was measuring something real. That is the clearest single illustration of
why per-signal verdicts beat a composite.

⚠ **Do not carry the weighted composite score.** Three lines of evidence now agree and the composite
still contradicts them: `time-gap` carries a weight of **2** in `docs/signals/README.md` while every
assessment of it — hand labels, field results, and the rendered session page — says it is noise. The
calibration task (#30) was partly done on 2026-05-15 and the result never propagated back into the
weights.

Magpie's own README says the weights are guesses pending calibration; quill-works refused the composite
at n=3 as *"false precision of exactly the kind `SCORING.md` refuses."* Harvest the **extractors**, which
are pure functions, and leave the scoring to be earned later.

There is a second, sharper lesson buried in the quill-works run: the tool nearly **confirmed its own
indicator with its own artefact** — harness-injected `<task-notification>` blocks were being counted as
queued messages until they were excluded. Any harvested extractor needs the same audit: is it counting
the agent, or counting the harness?

---

## The architectural bet: a card registry with user-created pages

Not a fixed dashboard. Every panel is a `MagpieCard` wrapping a query (`MagpieQueryCard`); page-level
controls — range, account, project filter — flow down through `usePageContext`, so a card never takes a
`range` prop from a parent that hand-placed it.

The design doc (`.local/plans/card-library-pages.md`, 20 KB, plus two follow-on slices) locks six
decisions before implementation. The ones worth keeping:

1. **Server SQLite persistence, not localStorage** — "must survive cache clears and follow the user
   across devices."
2. **Page-level controls feed every card.** "Every page has the core parts to make all the cards work."
3. **A `dependsOn` attribute** on registry entries, so adding a card auto-pulls the card it relies on.
4. **The schema admits every future card class from day one** — per-instance `params` and entity
   capabilities (`sessionId`, `projectHash`) are in the types immediately, so the staged rollout moves
   by adding registry entries rather than by migrating schema.
5. Interactive resize, and layouts saved as reusable templates with a formal schema.

The discipline is visible in the tree: `cards/project/` and `cards/session/` are **empty directories
containing only a README** explaining that the destination was scaffolded before the contents exist, and
why. That is a good habit and it made this archaeology fast.

---

## Harvest list, ranked

Paths verified 2026-09-02 against the repo.

| # | Artefact | Path | Why |
|---|---|---|---|
| ~~1~~ | ~~**zqlite**~~ — **retired 2026-09-03** | `packages/zqlite/` | Was top of this list. Dropped when zen-harness standardised on **TypeBox** (pi's tool API requires it and it *is* JSON Schema at the HTTP boundary), which makes zqlite's Zod dependency a port rather than a lift. Persistence goes to **Kysely** instead — typed SQL over `Static<>`-derived types, with hand-written migrations. See `../architecture.md` § Persistence. |
| 2 | **The struggle extractors** | `packages/core/src/struggle.ts` | Pure functions over an event stream. Take the extractors and the per-signal docs; leave the weights. Apply the field verdicts above. |
| 3 | **The signal docs** | `docs/signals/*.md` + `dropped/` | The per-doc structure (pattern / detection / window / weight rationale / false positives / evidence shape) is a reusable template for any behavioural indicator, and keeping dropped signals with their reason is the right archival habit. |
| 4 | **Cost-analysis panels** | `packages/dashboard/src/components/panels/tokens/CompactionCliffPanel.tsx`, `CacheLeveragePanel.tsx`, `EffectiveVsRawPanel.tsx` | These measure precisely what [`prompt-cache-architecture.md`](./prompt-cache-architecture.md) says is invisible to an agent. The instrument already exists. |
| 5 | **The Zod schema layer** | `packages/core/src/schemas/` | A typed contract for agent telemetry, independent of any UI. |
| 6 | **The card-registry design** | `.local/plans/card-library-pages.md` | The artefact is the architecture, not the components. Read it before designing any dashboard for the new harness. |
| 7 | **The ingestion layer** | `packages/server/lib/sync_sessions.ts`, `lib/otlp.ts` | The substrate everything else was a view over. Large (1,525 lines) and coupled to Magpie's schema, so a port rather than a lift. |
| 8 | **The managed-loop interval floor** | `packages/server/lib/managed-loop.ts` | Tiny, and the comment states the failure mode it blocks. Worth copying the *idea* into any background loop. |

**Explicitly do not harvest:** the dispatcher, the scheduler, the TOTP-gated browser terminal, or the
command-and-control panels. Not because they are bad, but because they are what turned an observability
tool into a service — see below.

---

## Why it stopped, and the lesson that transfers

Five weeks of dense design (2026-04-29 → 05-31), then roughly six weeks of running and producing data
(to 07-14), then silence. Nothing announced the stop.

**The dispatch half is what made it fragile.** Adding subprocess dispatch, cron scheduling and a browser
terminal turned a thing you *query* into a thing that must be *running*. `cc start` is a `nohup … &` with
a PID file; `install.sh` treats the systemd unit as optional and it was never taken. So the only start
path was a human remembering, and a fifty-day outage produced no signal — the same failure this document
set keeps naming, in the tool built to detect that class of failure.

Two lessons for the next harness:

1. **Separate the query layer from the service layer.** The observability half would still work today as
   a CLI you run when you have a question. It needed no daemon; the dispatch half did, and it took the
   observability half down with it.
2. **The insight outlived the tool, which is the correct outcome.** The signals catalogue was harvested
   into quill-works and field-tested there before Magpie stopped. Judged on the findings it produced
   rather than on whether it is still running, it worked.
