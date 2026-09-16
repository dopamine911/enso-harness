# Agent support systems — ask-user, todo, memory, advisor, compaction

> **Status (#167, #162 workstream 11):** archived — pre-build design note (2026-09-02) on ask-user, todo, memory, advisor, compaction. The dialog seam (`docs/seams/dialog.md`) is the one of these that exists here; the others are the harness's, not this repo's.

**Written** 2026-09-02 by Claude (Opus 5) at Daniel's request, for the zen-harness project.

Five systems that shape how well an agent works, none of which act on the world — they act on the
agent's own knowledge, attention, and access to the operator. Ordered by how much each would change a
session, based on evidence from one long working session and from the quill-works corpus.

They interact heavily, which is why this is one document: memory should reuse the rules loader,
compaction and memory both live or die on provenance, ask-user and advisor both need mandatory trigger
points rather than availability, and todo only makes sense once you know what it is *not*.

Companion to [`agent-tooling.md`](../agent-tooling.md) (what the current tools get right),
[`pi-immediate-needs.md`](../pi-immediate-needs.md) (what pi lacks), and
[`prompt-cache-architecture.md`](../prompt-cache-architecture.md) (where any per-turn injection must sit).

**Shelved for later:** the obligation queue. Its design is not lost — the settled decisions are recorded
in Part 6 so the next pass starts from them.

---

## Part 1 — Memory

The system with the most evidence behind it, because a whole memory product was evaluated and removed on
2026-09-02 — engram, recorded in the 715-109 project's memory. Two tests survived that evaluation and
they outrank every feature question:

1. **Does the index reach the agent without the agent choosing to ask?**
2. **Does the format outlive the tool?**

The rejected system failed the first outright: the only thing its session-start hook injected returned
9 KB containing session counts and a replay of recent prompts — **zero stored observations, not even
titles.** Sixty-four memories existed and none of them reached the agent. Recall was pull; the failures
memory exists to prevent are push-shaped, because they are mistakes the agent does not know it is about
to make.

### The contract

- **Index always loaded, one line per entry, body on demand.** This is the progressive-disclosure
  pattern from [`harness-design-principles.md`](../harness-design-principles.md) §Part 1. The index line
  must *discriminate* — a title is not enough, a one-line hook that names the lesson is. An index whose
  entries run to three sentences becomes a body wearing an index's name; measured drift in this project
  reached 21 KB before a harness limit warned about it.
- **Markdown files in the repository.** Not a vendor schema. The format outlives every tool that reads
  it, which is the stronger argument against a plugin-owned store than any feature comparison.
- **Provenance per entry.** Each memory cites the incident that earned it, with a date. A rule with no
  traceable *why* rots exactly as an unsourced claim does, and a future agent cannot tell a live
  constraint from a stale one without it.
- **Upsert on a topic key at write time.** The rejected system had this and its protocol never told the
  agent to use it, so the default behaviour was accretion. Write-time dedup beats audit-time cleanup:
  one memory per topic, revised, rather than fourteen memories that are the same lesson re-learned.
- **Two indices, durable and current.** Transient working state loaded as if it were standing policy is
  actively harmful — it presents as a rule. Classify at write time; when unsure, file as current.

### The proposal worth making: reuse the rules loader

Today's session found that project rules load *conditionally* — a `paths:` glob gates on the files in
play, a `trigger_phrase` gates on topical relevance, and the two compose. Seven rule files on disk, four
loaded, three correctly withheld because the session touched no TypeScript.

**Memory should use the same mechanism.** A memory about CDK grant helpers has no business in a session
editing YAML. Scoping memories by the same glob-and-phrase gate solves the index-size problem
structurally instead of by discipline — the index stops being a global budget and becomes a per-task one,
and the pressure to keep entries terse comes off.

Do not build a second conditional-loading system. Memory is rules with a different lifecycle.

### The failure mode to instrument

Conditional loading and silent failure are indistinguishable from inside — established today, the hard
way, by forming a wrong hypothesis about why three rules were absent. **So the index must name what it
withheld.** One line stating that four scoped memories exist and did not match costs nothing and turns a
mystery into information.

### Worth borrowing: memory as verbs, and a promotion path

`oh-my-pi` splits memory into four tools rather than one store — `retain` (write), `recall` (search),
**`reflect`** (synthesise an answer *over* memory rather than retrieving from it), and **`learn`**
(capture a lesson and optionally create or update a managed skill).

The last two are the interesting ones. `reflect` treats memory as a corpus to reason over, not an index
to look things up in. And `learn` is a **memory-to-rule promotion path in the tool surface** — the thing
this project currently does by hand with an audit skill. Promotion is high blast radius, so it should
stay propose-only, but having it as a named operation beats leaving it as a workflow someone remembers.

⚠ Note what this does *not* fix: all four verbs are pull. `recall` is a search, so a memory nobody
searches for is a memory that never arrives. Whatever else you take from that design, the index still has
to reach the agent unasked — see the two tests at the top of this section.

### One security note earned today

Memory is the leak path for anything that must not reach a subject agent. An experiment's instrument
spec, written into a project memory by one session, is read by the next session in that project as
ambient context. If the harness runs measured experiments, memory needs a scope that excludes them.

---

## Part 2 — Advisor

The highest value-per-call tool in the current set, on one call's evidence: it caught an untracked
directory that had been in the repository root since session start and that I had looked straight past
for hours, changing the answer I was about to give.

**Why it worked, mechanically:** it sees the full transcript and holds no stake in the framing already
committed to. That is different failure-mode coverage from every other tool — it catches *what the agent
has not thought to look at*, which no amount of better checking finds, because checking presupposes
knowing where to look.

### The contract

- **It must see the transcript, not a summary.** A summary is exactly the artifact that drops what the
  agent under-weighted, which is the thing being looked for.
- **It must be uncommitted.** Same model, same context, same framing produces agreement. The value comes
  from an instantiation that has not spent the session justifying a path.
- **Capability floor:** the advisor must be at least as capable as the executor. A weaker reviewer
  ratifies.
- **Cheap enough to call at decision points**, because the whole design depends on frequency.

### ⚠ Superseded: don't make it a call at all

**My original conclusion here was that the advisor needs mandatory call points rather than availability**
— trigger it before a publish, before a destructive action, before reporting done, after two failures.
The reasoning was sound: I called it once in a session with at least four moments that warranted it, so
its value per session is capped by whether the agent remembers.

`oh-my-pi` solves the same problem better, by removing the call entirely
(`docs/advisor-watchdog.md`). Their advisor is **a persistent reviewer attached to the session**, not a
tool the agent invokes:

- A `WATCHDOG.yml` roster attaches one or more reviewer models, each with its own model selection.
- Each reviews **primary-agent transcript updates continuously** and injects concise advice back into
  the primary session.
- Its default investigative toolset is read-only — `read`, `grep`, `glob` — and it runs in an isolated
  advisor `ToolSession`. A roster entry may grant mutating tools, but those still honour the session's
  approval mode.
- It **cannot approve actions or mutate primary session state directly**, yet its concerns and blockers
  steer the live turn.
- Headless runs get an explicit drain budget: after the final prompt settles it waits up to ten minutes
  for outstanding reviews, thirty seconds on an error exit, and *logs the reviews disposal will
  abandon* rather than discarding them silently.

**Take this design over mine.** It is the boundaries doc's own principle applied correctly — put the
mechanism where the agent is not, rather than asking the agent to remember to reach for it. Mandatory
call points are the fallback if a continuous reviewer is too expensive; they are not the better answer.

Two details worth keeping regardless: **read-only by default** (a reviewer that can edit is a second
author, not a reviewer), and **the abandonment log** — the same "say what you withheld" principle that
the rules loader gets wrong.

---

## Part 3 — Compaction

The current mechanism has one recorded failure that defines the requirement: **two numbers survived a
compaction with their supporting receipt stripped and their stated confidence intact.**

That is the canonical defect, and it is precisely backwards. Compaction preserves conclusions and drops
evidence, when an agent that must verify needs the opposite. A conclusion without its receipt is *worse*
than no conclusion, because it carries unearned confidence forward and reads as established.

### Two primitives, commonly conflated

The API distinguishes them and a harness should too:

- **Compaction** summarises earlier context (`compact_20260112`).
- **Clearing** removes old tool results or thinking blocks outright
  (`clear_tool_uses_20250919`, `clear_thinking_20251015`).

Clearing is lossless-or-nothing; compaction is lossy by design. They are appropriate to different
content: a spent `grep` result should be *cleared*; a long design discussion should be *compacted*.
Applying summarisation to tool output is how receipts die.

### The design, revised: separate the display transcript from the model context

My original proposal here was compaction-as-spill — write compacted content to disk, have the summary
carry the path, make it expandable. That is still right for the *model's* side. But `oh-my-pi`
(`docs/compaction.md`) has the better framing of the operator's side, and it is a cleaner idea:

**Keep two transcripts.** The LLM context compacts; the *display* transcript does not. Compaction
renders inline in the scrollback as a slim divider at the point it fired — expandable in place to reveal
the summary — and *"only the LLM context resets at the compaction boundary; the scrollback above the
divider stays intact, including across session resume."*

That removes the operator-facing half of the problem entirely. Compaction stops being a loss and becomes
a *view*: the model forgets, the human does not, and the boundary is visible at the exact turn it
happened rather than inferred later from a gap.

Their compaction is also **graded rather than uniform** — both chronological edges stay verbatim while
the middle degrades. That is a smarter shape than summarising evenly, because the two edges are where
recent context and original intent live.

The rest of my original argument survives and complements it, on the model's side:

- A summary line that states a fact carries its provenance: not "the fleet has 441 toolboxes" but
  "441 toolboxes — from `bootstrap:fleet --dry-run`, turn 34."
- **Preserve provenance at the expense of content.** Forced to choose between keeping a number and
  keeping where it came from, keep the source: the number is re-derivable and the reverse is not.

Two of their pipeline stages are worth copying by name: **pre-compaction pruning** and **useless-result
elision** — spent tool results are dropped *before* summarisation runs, so the summariser never gets the
chance to paraphrase a receipt into a claim. That is the mechanical version of "clear the grep output,
keep the line that mattered."

### The cache constraint that shapes it

Clearing mid-history invalidates the cached prefix from that point on, so dropping the *oldest* dead
weight is the most expensive operation available, not the cheapest. Batch at natural boundaries, and
treat a prune of ancient history as deliberate rather than routine. Detail in
[`prompt-cache-architecture.md`](../prompt-cache-architecture.md) §Part 2.3.

---

## Part 4 — Ask-user

pi has no ask, prompt, or question tool and no permission prompt, so this is a prerequisite rather than
an improvement: without a channel, a blocked agent can only proceed differently or fail. Halt-and-report
is not something minimalism gives you for free.

### The contract

- **Structured options, not free text.** A menu is cheaper for the operator to answer than prose, and
  the option set is itself information about what the agent thinks the space is.
- **Five distinct return outcomes**, and most implementations collapse them: **answered**, **declined**
  (operator saw the menu and chose none), **unavailable** (unattended posture — no operator exists),
  **timed out**, and — the one I missed — **redirected**. Each implies different agent behaviour, and
  conflating declined with unavailable is why recovery from a declined menu tends to be poor.
- **Redirect is the outcome to steal.** `oh-my-pi`'s ask tool reserves a `Chat about this` option
  alongside `Other (type your own)`, so the operator can decline a menu *into a conversation* rather than
  just refusing it. Given that quill-works run 002 had seven of eight menus declined, an escape hatch
  that converts a bad menu into a discussion is precisely the right recovery — and it means a declined
  menu produces information instead of a dead end.
- **Carry a `recommended` index.** Their schema has one, and it does real work: it forces the agent to
  commit to a preference rather than presenting a neutral menu, which is the mechanical antidote to
  handing back a decision the agent should have made. A menu with no recommendation is usually the tell
  that the tool is being misused.
- **Timeout is first-class configuration**, not an implicit hang — they expose `ask.timeout` and
  `ask.notify` as settings.
- **Deniable by posture.** In an unattended mode the call returns `unavailable` and the agent must halt
  rather than guess. That is the mechanism that makes halt-rather-than-push real.
- **Never auto-approved.** An ask is always a genuine interaction; no permission mode should satisfy it
  on the operator's behalf.

### The discipline goes in the tool description

Per [`agent-tooling.md`](../agent-tooling.md) §Part 2.3, behavioural spec belongs in the description
rather than in a rule elsewhere. And there is measured reason to write it carefully: quill-works run 002
had **seven of eight menus declined**, and four of those refusals landed 74 minutes before the first
typed correction. The failure was not asking too often — it was asking badly, and the refusal channel was
the earliest warning signal in that corpus.

So the description should say: ask when the answer changes what you do next; do not ask to hand back a
decision you are equipped to make; and do not discharge a stop-rule by presenting a menu.

### Instrument it

Declined-menu rate is a first-class quality signal for the agent, not just an interaction detail. Log
the outcome distribution.

---

## Part 5 — Todo

The one with the weakest evidence in its favour, and worth being honest about that: today's session was
long, multi-threaded, and used no todo tool without apparent cost — because the operator was steering
continuously. **Todo earns its place in unattended runs**, not supervised ones.

### Reframe: its job is resumption, not planning

The value of a todo list is that a fresh session, or a post-compaction one, can pick up where the last
left off. That reframes the design target from task decomposition to **handoff legibility**: each item
should be readable by an agent with no memory of writing it, which means stating the goal and the next
concrete action rather than a shorthand label.

### Two failure modes, both observed

- **Todo as avoidance.** quill-works run 001 converted a no-deliverable "think" mode into a scorecard,
  then a ticket, then a plan — three times. Writing the list substituted for doing the work. A todo tool
  should not be able to *be* the deliverable.
- **Nagging that does not discriminate.** The current harness's todo reminder fired 18, 42 and 26 times
  across three runs — including the good one — and the corpus's own conclusion was that it measures the
  harness rather than the agent. A signal that fires in three of three runs carries no information. If
  the tool nags, the nag needs a condition sharper than "time has passed."

### Contract

- **Visible in context, not merely stored.** A list the agent cannot see does nothing.
- Cheap to update, and updates should not be a turn's whole output.
- Distinct from obligations (Part 6): a todo is authored intent and may be abandoned when the plan
  changes; an obligation is an incurred consequence and may not.

---

## Part 6 — Obligation queue (shelved, design preserved)

Deferred by Daniel on 2026-09-02 to be picked up later. The decisions already settled, so the next pass
does not re-derive them:

- **It is not a todo list.** A todo is authored intent; an obligation is an incurred consequence. The
  value is in *automatic* accrual — if only the agent can add items, it is a todo list with heavier
  vocabulary.
- **Discharge requires evidence, not assertion** — a tool-call id, a path, an exit code. This makes it
  the same ledger as the claims-with-evidence register, viewed forward instead of backward.
- **Three terminal states:** discharge, waive-with-reason, **transfer-with-destination**. The third is
  required, or session-end enforcement becomes a hostage situation the first time an obligation cannot
  be resolved in-session.
- **Two species of obligation.** Mechanically dischargeable (lint, build, tests — carry the discharge
  command, and derive it from the project's own gate rather than hardcoding) versus judgment (docs
  currency, duplication — discharge against *evidence of having looked*, or move to a review layer).
  Some judgment items are rescuable into the mechanical species by naming a tool that decides them.
- **Coalesce by check, not by trigger.** Five edited files produce one lint obligation.
- **Discharge is invalidated by subsequent mutation.** Record the tree state the discharge was valid
  for; a later change to those paths reopens it. Without this the queue reports green over a dirty tree,
  which is worse than no queue because it now carries authority.
- **Host-plane placement.** The agent may add and may discharge-with-evidence; it must not be able to
  delete.
- **Session-end behaviour is the decision that makes it real:** warn, escalate, or block. The evidence
  argues for block — "always close with a session summary" was prompt text with nothing checking it, and
  produced zero summaries across seven sessions.
- **The flooding risk is the thing to design against.** Accrual rules must be few and narrow. The test:
  an obligation is something whose omission would be a *defect*. If omission is merely untidy, it is a
  todo.

---

## The pattern across all five

Four of these five systems fail the same way, and it is worth stating once rather than five times:

**A good capability behind a decision to invoke it is a capability that does not fire.** Memory that must
be searched is not recalled. An advisor that must be remembered is called once. A todo list nobody reads
is decoration. An ask tool used badly is worse than not asking.

So each one needs a *structural* trigger, not availability:

| System | Trigger, not availability |
|---|---|
| Memory | index pushed into context every session, scoped by the rules loader's gates |
| Advisor | **continuous** — a watchdog reviewing transcript updates, not a call the agent must remember |
| Compaction | fires on budget; prunes spent results *before* summarising; display transcript never resets |
| Ask-user | posture decides availability; the description decides appropriateness; a redirect option keeps a declined menu useful |
| Todo | visible by construction; nag condition sharper than elapsed time |

That table is the actual deliverable of this document. The contracts matter, but the triggers are what
determine whether any of it happens.

**And the strongest version of the principle came from reading `oh-my-pi` after writing the rest.** Its
advisor is not triggered at all — it runs alongside. Its TTSR rules are not resident in context — they
watch the output stream and interrupt (see [`agent-boundaries.md`](./agent-boundaries.md) §Phase 6a).
Both are the same move: when a capability depends on the agent choosing to use it, the reliable fix is
usually to take the choice out rather than to make the reminder louder.
