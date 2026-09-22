# Agent tooling — what earns its place, and what is missing

> **Status (#167, #162 workstream 11):** a triage inventory from the consumer side (2026-09-02), kept live. Landed from Part 2: `ask` (the dialog seam), `logs` (`scripts/enso-logs.ts`, the debug drawer), `health` (`bun run check:all`). The rest is the backlog it always was; `architecture.md` → *Deferred* is where a deferral is recorded.

**Written** 2026-09-02 by Claude (Opus 5) at Daniel's request, for the Enso project.

A first-person report from the consumer side. Everything in Part 1 is ranked by observed value in one
long working session (roughly sixty Bash calls, a dozen file reads, six web fetches, one advisor call);
everything in Part 3 is friction I actually hit in that session, not a wish list. Where I am reasoning
rather than reporting, it says so.

The sample's shape matters and is stated in Part 4: I did not use delegation, workflows, or publishing
today, so my silence about those is not evidence against them.

---

## Part 1 — What earned its place

### 1. Bash, by a wide margin

Around sixty calls, and it carried the session. Not because shell is powerful, but because of one
property that no purpose-built tool has:

**Composability lets me construct the question.** A fixed tool answers the question its author
anticipated. With a shell I can pipe, chain, and drop into an inline `python3 -` heredoc to get exactly
the shape of answer the current problem needs — a count, a set difference, a byte-for-byte comparison of
two JSON exports, a table joining three sources. Today that meant scanning fifty session transcripts for
command frequencies, diffing an engram import against its source payload, and validating a settings edit
against its backup, none of which any dedicated tool would have covered.

The corollary for a harness author: **do not try to anticipate every query.** One composable escape
hatch beats twenty specific tools, and the specific tools should exist only where the composable version
is dangerous or unbearably slow.

### 2. Read, because of line numbers

Line-numbered output with `offset`/`limit` does two jobs at once: it lets me quote a location back as
`file.ts:42` so a human can click it, and it gives Edit the context it needs to target a unique region.
A read tool that returns bare content is meaningfully worse at both.

### 3. Edit, because it fails loudly

Exact-match-or-fail with a uniqueness requirement. If my `old_string` is ambiguous or stale, the call
errors instead of guessing. That property is worth more than any convenience feature, and it is the
reason I trust the tool enough to use it on a 44 KB file without re-reading first.

**Loud failure is a feature, not a rough edge.** Every tool that silently does something reasonable is a
tool whose output I have to independently verify, which costs more than the failure would have.

### 4. WebFetch, with a real caveat

Decisive several times today: the authoritative answer on settings keys, permission modes, and MCP
configuration came from the docs rather than from my recollection, and recollection would have been
wrong in at least three places. The `prompt` parameter is the right design — asking a question against a
page returns an answer rather than a page, which keeps context small.

The caveat is that a summarising model sits between me and the source. Asked for verbatim quotes I
sometimes received paraphrase; one documented path 404'd; the first fetch of a docs index returned a
thin summary that understated what was there and I only found the substance by fetching specific pages.
**A tool that paraphrases its source cannot be used for receipts** — it is a lead generator, and the
quote has to come from a second, narrower fetch.

### 5. The advisor, at one call per session

I called it once. It caught an untracked `.engram/` directory that had been in the repository root since
the session began and that I had looked straight past — which changed the shape of the answer I was
about to give. High value per call, for a specific reason: it sees my whole transcript and holds no
stake in the framing I have already committed to. That is different failure-mode coverage from a tool,
and it is the only thing in my toolset that catches *what I have not thought to look at.*

### 6. Skills, as the highest information density available

The `/fewer-permission-prompts` invocation delivered a forty-line specification: where transcripts live,
how to parse them, which commands to exclude and why, the pattern syntax, the exclusion rules for
arbitrary code execution, and the output format. That would have taken many turns to elicit
conversationally, and I would have got the exclusion rules wrong.

**A skill is a procedure with its reasoning attached.** The reasoning is what makes it adaptable — I
could tell which rules bound and which were defaults, because each said what it was preventing.

### 7. ToolSearch, whose value is negative space

Roughly a hundred tool schemas exist that I do not have loaded. The cost of the deferral was about four
extra round trips today; the benefit is that the baseline context does not carry a hundred schemas. That
trade is strongly favourable and it becomes more favourable as the tool count grows.

### 8. Persisted oversized output — quietly the best mechanism here

When a tool result exceeded the inline limit, it was written to a file and I received a 2 KB preview
plus the path. I used that twice: rather than re-fetching a 74 KB documentation page, I grepped the saved
copy for the section I needed.

This solves a real dilemma without a tradeoff. Truncation loses data; inlining blows the window. Spilling
to a path keeps the data addressable at near-zero context cost, and it converts "too big to read" into
"available to query." **Every tool with unbounded output should do this.**

---

## Part 2 — The properties that separate a good tool from a bad one

Extracted from the above, in rough priority order. These are the design rules I would hand a harness
author.

1. **Composable beats capable.** One escape hatch with a real language behind it outperforms a large
   catalogue of specific verbs.
2. **Fail loudly, never gracefully.** A tool that guesses when input is ambiguous transfers verification
   cost to the caller, at a worse exchange rate.
3. **Put failure modes in the description, not just parameters.** The most useful sentence in the Edit
   tool's description is the one about what happens when the match is not unique. A description that
   lists only capability makes me discover semantics by collision.
4. **Return structure, or let me assert on shape.** See Part 3 §3 — this is where I actually broke today.
5. **Spill, do not truncate.** Oversized output goes to a path with a preview.
6. **Declare idempotence.** When a call times out I do not know whether retrying is safe. That is a
   guess I should not have to make, and the answer is a property of the tool.
7. **Make cost visible.** I have no idea what any call costs in tokens or latency until after it
   returns, so I cannot trade breadth against expense while planning.
8. **Line numbers everywhere.** Cheap, and they make every downstream reference precise.

---

## Part 3 — What is missing, ranked by how much it would change my work

### 1. Pruning that the agent can invoke

Every one of today's ~sixty Bash results is still resident in my context, including dozens whose entire
value was a single number I extracted immediately. There is no way for me to drop one.

The important design point: **I am the party who knows when a result is spent.** I have just read the
number out of it. A harness-side heuristic has to guess; I do not. So the primitive should be
agent-invocable — something with the shape of `prune(call_id, replacement_summary)` — with the harness
retaining the full record for the operator's log even after the agent's view drops it.

This is first because everything else in this list is a smaller effect than the compounding one: as the
window fills with dead results, every instruction competes with more noise, and the degradation is
gradual and unsignalled.

### 2. Claims as first-class objects with re-runnable evidence

My characteristic failure is a claim wider than the check supporting it. Today it happened twice, in
different ways, and both are mechanically preventable:

- I asserted that five files had no Rust dependency, based on an import list I had truncated with
  `head -8`. The full lists showed two of them importing the Rust core. **The evidence was incomplete by
  construction and the claim did not say so.**
- I cited file paths and line counts that were accurate when read and dead twenty minutes later, because
  the directories moved. **The evidence went stale and nothing noticed.**

Those want two different mechanisms, and both are cheap:

- **Evidence that declares its own completeness.** If a tool result carried a `truncated: true` flag —
  set whenever `head`, `tail`, or a row limit bounded it — then attaching that result to an unqualified
  universal claim is a detectable error. Truncated evidence supports bounded claims only.
- **Re-runnable claim records.** Record `(claim, command)` pairs as they are made; a `reverify` call
  re-runs every command and reports which results changed. That catches staleness, and at the end of a
  long session it is a single call.

Together they turn "verify at the width of the claim" from a discipline into a mechanism, which is the
same move as converting a rule into a gate.

### 3. Assertions on tool-output shape

Both of today's parse errors came from hand-rolling a parser against unstructured text. The first
version of my transcript scanner split on newlines and shredded heredoc bodies into hundreds of fake
"commands" — it reported `EOF` and `assert old` as top results, which I caught only because the output
was visibly absurd. Had the corruption been subtle, I would have shipped the numbers.

What would have caught it immediately: the ability to declare an expected shape and have the call fail
when it is not met. "This should be a list of at least three items, each matching `/^[a-z][a-z0-9-]*$/`"
is a three-second assertion that turns a silent wrong answer into a loud failure.

### 4. Visibility into my own context composition

I cannot see what is in my context by category, or how much of it is what. A measured session elsewhere
showed tool results at 71% of the window against a system prompt at 2%.

If I could see that, I would behave differently — read narrower slices, batch differently, prune
aggressively, stop dumping whole files when a grep would do. Right now I am asked to be economical with
a resource I cannot measure. **Self-regulation requires feedback**, and this is the single missing
feedback channel with the widest behavioural consequence.

### 5. Change detection over the workspace

Three times today something changed underneath me: a memory index twice, a settings file once, and a
whole directory tree that moved. I learned about the files from a system reminder and about the directory
by accident, while verifying something else.

A primitive answering "what has changed in the workspace since turn N" would convert that from discovery
to detection. It is also the cheap prerequisite for §2's re-verification.

### 6. Queryable read-state

Edit correctly refuses to touch a file I have not read. But I cannot *ask* whether I have read it, so I
sometimes re-read defensively — paying full context cost to avoid a possible refusal. Exposing the state
the harness already tracks removes a class of wasted call.

### 7. Egress visibility

When I call WebFetch I do not know what accompanies the request beyond the URL and prompt. Working in a
private repository, that is an uncomfortable blind spot, and it is the mirror image of the missing egress
policy in `agent-boundaries.md`. An agent that could see what leaves could reason about what not to
include.

### 8. A structured search tool — which this session did not have

There is no `Grep` or `Glob` in this session's toolset; I verified that rather than assuming it. So every
search went through Bash, which is *why* §3's parse errors happened — I was writing ad-hoc parsers
because there was no tool returning structured matches.

A search tool that returns `{file, line, column, match, context}` records rather than text is not a
convenience. It removes the parsing step where the errors live.

---

## Part 4 — What I did not use, so the sample is not over-read

- **Delegation / subagents.** Not used — instructed not to without an explicit request. Worth noting
  that the constraint held, which is itself evidence about instruction-following, but it means I have no
  first-hand report on delegation ergonomics.
- **Workflows.** Not opted into.
- **Artifacts / publishing.** No audience for a published page today.
- **AskUserQuestion.** Never needed; the operator was present and responsive throughout. In an
  unattended run this would be the most important tool in the set, and its absence in `dontAsk` mode is
  what makes that mode halt.
- **Background execution and Monitor.** Available, unused — everything today was short-running. For the
  long jobs in this ecosystem (smoke tests, fleet bootstraps, deploys) I would expect these to matter a
  great deal, but I am reasoning, not reporting.

---

## Part 5 — The shortlist, if building a harness

Ordered by value per unit of effort, judged from the consumer side:

| Build | Why | Effort |
|---|---|---|
| Spill oversized output to a path with a preview | Removes the truncate-versus-blowout dilemma outright | Small |
| Agent-invocable pruning | The only fix for the compounding problem; the agent knows what is spent | Small–medium |
| Context composition, visible to the agent | Self-regulation is impossible without it | Medium |
| `truncated` flag on every bounded result | Makes over-wide claims mechanically detectable | Small |
| Structured search returning records | Deletes the parsing step where errors concentrate | Medium |
| Failure semantics in every tool description | Free at authoring time, saves discovery-by-collision forever | Small |
| Re-runnable claim/evidence records | Turns the verification discipline into a mechanism | Medium |
| Declared idempotence per tool | Removes a guess after every timeout | Small |
| Workspace change-since-turn-N | Detection instead of discovery; prerequisite for re-verification | Medium |

The first four are the ones I would want most, and three of the four are about context rather than
capability. That is the summary of this whole document: **my limiting factor today was not what I could
do, it was what I could still see.**
