# Harness design principles — what Claude Code gets structurally right

**Written** 2026-09-02 by Claude (Opus 5) at Daniel's request, for the Enso project.

Companion to [`agent-boundaries.md`](./archive/agent-boundaries.md) (safety and permissions) and
[`agent-tooling.md`](./agent-tooling.md) (tools from the consumer side). This one is about
*architecture* — the patterns worth carrying into a new harness regardless of which tools or rules it
ships.

A first-person report. Evidence comes from one long working session on 2026-09-02; where a claim rests on
reasoning rather than observation, it says so.

---

## Part 1 — Progressive disclosure, applied seven times

This is the single best idea in the harness, and I have not seen it named anywhere as a principle. It
appears in seven independent places:

| Surface | The index (always loaded) | The body (loaded on demand) | What triggers the load |
|---|---|---|---|
| **Skills** | name + one-line description | `SKILL.md` contents | slash command, or the model's judgement from the description |
| **Tools** | tool name only | the full JSONSchema | `ToolSearch` by name or keyword |
| **MCP servers** | tool names; server instructions on connect | tool schemas | same deferral as tools |
| **Oversized tool output** | ~2 KB preview + a filesystem path | the whole result on disk | a later read or grep of that path |
| **Subagents** | the agent's final report | its entire transcript | *nothing* — deliberately unreachable from the parent |
| **Memory** | one line per memory in an index file | the memory file itself | reading the file |
| **Path-scoped rules** | *nothing* — the rule is absent until relevant | the whole rule file | a `paths:` glob in its frontmatter matching the files in play |

The rule underneath all seven: **keep the index, defer the body.** It is what makes a large capability
surface affordable at all — a hundred skills cost a hundred description lines rather than a hundred
bodies, and a hundred tools cost a hundred names rather than a hundred schemas.

### The seventh case is the most interesting, and it has two mechanisms

Rules in a project's `.claude/rules/` directory are auto-loaded without any `@import`, and **`paths:`**
frontmatter — a glob such as `src/**/*.ts` — gates which ones load: a rule with a path constraint stays
absent while the files in play do not match.

Measured in this project on 2026-09-02: seven rule files on disk, four loaded, three absent. The three
absent ones carry `paths: src/**/*.ts` and the session had touched no TypeScript source. **Conditional
instruction loading, working correctly.**

⚠ **Correction, 2026-09-02, later the same day.** All seven files also carry a `trigger_phrase` key with
`opus:` / `sonnet:` / `haiku:` sub-keys, and I originally recorded that here as a *second loading
mechanism* — "a small model judges relevance" — composing with the path gate. **That was wrong, and
wrong in an interesting direction.**

`trigger_phrase` is not a harness loading mechanism at all. It is Daniel's own convention, consumed by
the `zenflow:schedule` skill, and the model names are the **session's** model rather than a judging one:
each sub-key holds the phrase to re-inject when the session runs on that model, because a smaller model
needs a blunter phrase to reactivate the same rules. Its purpose is periodic re-injection, not
conditional loading.

So there is one loading gate (`paths`), not two composing ones. The four rules that loaded did so
because they carry no path constraint — nothing judged their topical relevance.

**The inference that misled me** was reading `haiku:` as naming the decider rather than the audience. It
looked like a cheap-classifier design because that is a design I had just been thinking about. Worth
recording as a failure shape: an unfamiliar key read through the lens of the problem currently in mind.

This is a capability worth copying outright. It inverts the usual tradeoff: a project can carry
thirty rules covering every subsystem, and any given session pays only for the ones its files
implicate. Instruction volume stops being a global budget and becomes a per-task one.

### ⚠ But it fails identically to a bug, and that is a design problem

Establishing the paragraph above took two wrong turns, and both are worth recording because they are the
hazard rather than incidental clumsiness.

First I found the three missing files by counting, and hypothesised that the loader had hit a size budget
and truncated alphabetically — the four that loaded happen to sort first, so the coincidence was
persuasive. Reading the frontmatter killed that.

Then I read the frontmatter with `head -3`, saw `trigger_phrase` on the loaded files and `paths` on the
absent ones, and concluded the two were alternative mechanisms. They are not: a full grep showed **all
seven files carry a trigger phrase**, and the three absent ones simply carry an additional path gate.
A truncated read produced a confident, wrong architectural claim — the second time in this session that
`head -N` did exactly that.

That is the whole hazard. **From inside, conditional absence and silent failure are
indistinguishable.** An agent seeing four of seven rules cannot tell "three were correctly withheld"
from "three failed to parse" or "the loader stopped early." Neither can the operator.

The fix is cheap and nobody does it: **the index should name what it withheld.** A line stating that
three path-scoped rules exist and did not match would make the mechanism legible, cost almost nothing,
and turn a mystery into information. Without it this is the "healthy and broken render identically"
failure mode, sitting inside the instruction loader — the one place where being wrong is least visible.

### The property that makes it work, and the failure mode

**The index must carry enough information to decide.** This is the whole game, and it is where naive
implementations fail.

A skill description that summarises what the skill *is* leaves the body unloaded forever, because nothing
in the summary tells the model when the skill applies. Descriptions in the working set are consequently
written as *trigger conditions* — "use this when the user asks X, Y, or Z" — rather than as abstracts.
The same holds for a memory index line: a title is not enough, and a hook that names the lesson is.

Three failure modes follow, all of which I observed today:

- **An index that does not discriminate.** If the description does not distinguish this item from its
  neighbours, the load decision is a coin flip.
- **An index that outgrows its role.** A memory index carrying two- and three-sentence entries reached
  21 KB in this project, and a harness hook fired warning that it was approaching a read limit. At that
  point the index is a body wearing an index's name. **One line per entry is not a style preference, it
  is what preserves the property.**
- **Index/body drift.** The paste of a skill body can be truncated or out of sync with the file on disk,
  which is why a hook exists in this setup purely to re-assert the canonical path and force a real read.
  Progressive disclosure introduces a fidelity problem: the index is a promise about a body that may
  have changed. Version or checksum the body if the index is going to make claims about it.

### Why to copy it first

It is cheap, it compounds, and every surface a harness adds is another place it applies. Retrofitting is
also unusually painful, because the decision *not* to defer tends to be baked into how the surface is
declared.

---

## Part 2 — Three more things it gets structurally right

### 1. The instruction hierarchy actually composes

Right now I am simultaneously honouring twelve instruction files across several authority levels: a user
global `CLAUDE.md`, five rule files it imports, a project `CLAUDE.md`, four of its seven project rule
files (three correctly withheld — Part 1), and a memory index — plus the base prompt, tool descriptions,
and mode instructions injected mid-session.

The notable part: **every conflict we found today was between the *content* of two layers, never between
the layering mechanism itself.** Precedence resolved deterministically and no layer clobbered another.
That is harder than it looks, and it is the thing to get right before writing any rule — a rule in a
layer that silently does not apply is the worst failure class available, because it presents as
compliance.

The one caveat, from Part 1: three rules *did* fail to reach me, correctly and by design, and the
mechanism gave no signal that it had acted. Deterministic precedence is not the same as legible
precedence, and only the first is solved here.

The precedence semantics worth copying are asymmetric on purpose (detail in
[`agent-boundaries.md`](./archive/agent-boundaries.md) §7): restrictions merge from every scope, permissions can
be locked so lower scopes cannot broaden them, and some booleans are any-source-true. **Precedence must
be monotone toward restriction.** A lower layer may narrow and may never widen.

### 2. Failure is loud exactly where being wrong is expensive

Edit refuses a non-unique match rather than picking one. A permission denial says it was a denial. A
blocking hook returns its reason. In each case the harness declines to be helpful, and that is correct:
a tool that guesses transfers verification cost to the caller at a terrible exchange rate.

The inverse is worth stating as a design rule: **anywhere a harness "helpfully" resolves ambiguity, it
has created work it cannot see.**

### 3. The harness talks to the agent during the turn

Most agent frameworks assemble a context, hand it to the model, and wait. This one injects mid-turn: a
file changed on disk, a permission mode switched, a background task finished, an MCP server connected or
dropped, a memory was recalled.

That channel is why I noticed a memory index being rewritten underneath me three times in one session,
and why a settings file I had just edited was re-presented when it changed again. Without it, every
state change between turn start and turn end is invisible, and the agent operates on a snapshot that
silently expires.

This is also the least documented surface anywhere, which is why it heads the roadmap below.

---

## Part 3 — Documentation roadmap

**Working state as of 2026-09-02.** This section is expected to churn as items are written; the
principles above are not.

Ranked by value, with the reasoning rather than just the ordering.

### 1. The system-reminder channel — a taxonomy

**Why first:** it is the surface nobody has documented, and the one that requires the inside view to
enumerate. Daniel's own prompt-corpus methodology names runtime injection as an uncaptured channel; a
wire capture sees the system prompt and the tool definitions, and this arrives as message content
instead.

What to record: every distinct block type observed, its format, when it fires, what it evidently exists
to correct, and — for a harness author — whether the equivalent state change would otherwise be
invisible. Observed so far in one session: file-changed-on-disk notices with diffs, memory recall,
permission-mode transitions in and out, agent-availability changes, MCP connect and disconnect,
oversized-output spill notices, and skill-invocation path re-assertion from a local hook.

### 2. Instruction composition and precedence

**Why:** it must be rebuilt, and the semantics bite. See Part 2 §1. The deliverable is the precedence
table plus the asymmetries, plus a test that proves a rule in each layer actually reaches the model —
because the failure mode is silent.

### 3. Skills as a pattern rather than a feature

**Why:** it is progressive disclosure plus a trigger-description discipline plus a fidelity problem, and
all three generalise beyond skills. Includes the description-as-trigger rule and the index-drift hazard
from Part 1.

### 4. The context lifecycle

**Why:** the pruning thesis lives here and it is the least-examined territory. What to record: what
compaction preserves and discards, what turning it off buys, what survives session resumption, and the
recorded failure mode where numbers outlived the receipts that justified them while their stated
confidence stayed intact.

### 5. Hooks as the enforcement plane

**Why:** this is the gates mechanism. The events, what each can block versus annotate versus inject, and
the property that matters more than any of them — **hooks run outside the model, so they are the only
enforcement an agent cannot reason around.**

---

## The short version

Keep the index, defer the body — in every surface, without exception. Make precedence monotone toward
restriction. Refuse to resolve ambiguity on the caller's behalf. And keep talking to the agent after the
turn has started, because the alternative is an agent working from a snapshot that expired without
telling it.
