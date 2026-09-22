# Prompt-cache architecture — the constraint that shapes prompt layering

**Written** 2026-09-02 by Claude (Opus 5) at Daniel's request, for the Enso project.

Mechanics here come from the bundled Anthropic API reference read on 2026-09-02, not from recollection —
which matters, because writing this from memory would have missed three purpose-built primitives and
produced advice that was worse than the platform's own answer. That near-miss is catalogued as error #8
in [`agent-failure-modes.md`](./archive/agent-failure-modes.md).

**Why this belongs in a harness design document rather than a tuning guide:** cache efficiency is a
function of *layout order*, and layout order is decided when you design the prompt assembly. Retrofitting
it means reordering, and reordering is exactly the operation that costs.

---

## Part 1 — The mechanics

**Caching is a prefix match.** The request renders in a fixed order — `tools` → `system` → `messages` —
and **any byte change anywhere in the prefix invalidates everything after it.**

| Property | Value |
|---|---|
| Breakpoints per request | max 4 (`cache_control: {type: "ephemeral"}` on a content block) |
| TTL | 5 minutes default; `{"type": "ephemeral", "ttl": "1h"}` for one hour |
| Minimum cacheable prefix | model-dependent, 512–4096 tokens — **below it, nothing caches and nothing tells you** |
| Cache write cost | ~1.25× normal input |
| Cache read cost | ~0.1× normal input |
| Scope | **model-scoped** — switching models is a cold cache |
| Verification | `usage.cache_read_input_tokens`; zero across repeated identical-prefix requests means a silent invalidator |
| Diagnostics | beta `cache-diagnosis-2026-04-07`, pass `diagnostics: {previous_message_id: ...}`, read `response.diagnostics` |

The read/write asymmetry is what makes the architecture worth designing around: a cached prefix costs a
tenth of an uncached one, so a harness that invalidates its prefix every turn pays roughly ten times more
for the same context than one that does not.

---

## Part 2 — The three findings that change a harness design

### ⚠ 1. Per-turn system-prompt replacement is a cache catastrophe

pi's extension API offers, at `before_agent_start`, the ability to **replace the system prompt for this
turn**. It is the most powerful hook in the API and it is a trap if used per-turn.

`system` renders at position 1, immediately after `tools`. Rewriting it every turn invalidates the entire
prefix every turn, which means zero cache reads for the life of the session — every turn re-processes the
full history at full price.

This directly contradicts advice I gave earlier in conversation. I suggested re-asserting load-bearing
invariants every turn to fight instruction decay, without qualifying *where*. Doing that by rewriting
the system prompt is the worst available implementation.

### ✅ 2. There is a purpose-built primitive for exactly that problem

**Mid-conversation system messages.** Append `{"role": "system", "content": "..."}` to the `messages`
array instead of editing top-level `system`. It preserves the cached prefix entirely, because it lands at
the tail rather than the head, and the reference describes it as *the prompt-injection-safe operator
channel* — operator authority without touching the front of the prompt. No beta header. Supported on
Opus 5, Opus 4.8, Fable 5/5.1, Mythos 5/5.1; **not** Sonnet 5.

Placement rules: it must follow a `user` message (or an `assistant` message ending in server-tool use),
must be either the last entry or followed by an `assistant` turn, and cannot be `messages[0]`.

**And for the repeating case specifically:** give it `clear_at: "next_user_message"` (beta
`mid-conversation-system-clear-at-2026-08-21`). It renders for exactly one turn, then stays in the
transcript in cleared form — costing no input tokens thereafter, not cache-eligible itself, and still
part of the prefix. Append a fresh copy after each `tool_result` and **leave earlier copies in place**:
deleting one is a history edit, which misses the cache from that point and, on some models, invalidates
every later thinking block.

That is the decay fix, done right: re-anchor at the tail, once per turn, at near-zero marginal cost,
never by rewriting the head. **If you build one thing from this document, build this.**

### ⚠ 3. Pruning trades cache for context, and the intuition about which items to drop is backwards

Context pruning exists as an API feature — `context_management.edits` with
`clear_tool_uses_20250919` (and `clear_tool_inputs: true` to drop the call parameters too), or
`clear_thinking_20251015`. Beta `context-management-2025-06-27`. This is *clearing*, distinct from
compaction, which summarises.

But clearing an item from the middle of history is a history edit, so **the cache misses from that point
onward.** Which produces a genuinely counter-intuitive rule:

- **Pruning the oldest dead results is the most expensive option.** It invalidates the longest suffix —
  everything after the removed item has to be re-processed.
- **Pruning recent items is cheap.** Little suffix follows them.

So the instinct — "those sixty stale tool results from early in the session are obviously the safest
thing to drop" — inverts the actual cost. The reclaimed tokens have to outweigh re-processing everything
after them at full price.

Practical consequences for a pruning design: batch prunes rather than dribbling them, prefer a natural
boundary (right after a compaction, or at a turn where the suffix is short anyway), and treat a
prune of ancient history as a deliberate expensive operation rather than routine hygiene.

---

## Part 3 — Layout rules

Ordered by consequence. These are decisions, not tuning.

1. **Freeze the system prompt.** No interpolated date, mode, session id, or user name. Those sit at the
   front and invalidate everything downstream. Dynamic context goes into `messages` — as a
   `role: "system"` message where supported, as user-message text otherwise. *A message at turn 5
   invalidates nothing before turn 5.*
2. **Never change the tool set mid-conversation.** Tools render at position 0; adding, removing, or
   reordering one invalidates the whole cache. If you want modes, do **not** swap tools — pass the mode
   as message content, or give the model a tool that records the transition.
   ⚠ This collides with a recommendation in [`agent-boundaries.md`](./archive/agent-boundaries.md) §Phase 4,
   where I argued for implementing modes by tool mounting because an absent tool cannot be reasoned
   around. Both are true: **mount per session, not per turn.** A mode switch that remounts tools should
   start a new session or accept a full cache reset as its price.
3. **Serialise tool definitions deterministically** — sort by name, sort JSON keys. Non-deterministic
   serialisation produces different prefix bytes from identical logical content.
4. **Never switch models mid-conversation.** Caches are model-scoped. This is also the hidden cost of
   provider portability and of model cascades: every switch is a cold start, and a cascade forfeits cache
   reuse across its members.
5. **Forks must reuse the parent's prefix verbatim.** Summarisation passes, compaction calls, and
   subagents commonly rebuild `system`/`tools`/`model` — and any difference misses the parent's cache
   completely. Copy all three byte-for-byte, then append fork-specific content at the end.
6. **A mid-conversation top-level `effort` change invalidates the messages cache.** There is a
   per-message escape: a `role: "system"` message with `content: []` and `output_config: {effort: ...}`
   (beta `mid-conversation-output-config-2026-07-01`; Opus 5, Fable 5.1, Mythos 5.1).
7. **Don't cache a prefix that changes from the beginning anyway.** If the first thousand tokens differ
   per request there is no reusable prefix, and a breakpoint only buys the 1.25× write premium with zero
   reads.

---

## Part 4 — Silent invalidators to grep for

Every one of these produces a correct-looking prompt with no cache reads, and none of them announces
itself:

| Pattern | Why it breaks caching |
|---|---|
| `Date.now()` / `datetime.now()` in the system prompt | prefix differs every request |
| a UUID or request id early in content | same |
| `JSON.stringify` / `json.dumps` without sorted keys; iterating a set | non-deterministic bytes from identical content |
| session or user id interpolated into `system` | per-user prefix, no sharing across users |
| conditional system sections (`if flag: system += ...`) | every flag combination is a distinct prefix |
| a tool set built per user or per turn | tools render at position 0 |

**The diagnostic is one field.** `usage.cache_read_input_tokens` at zero across repeated
identical-prefix requests means one of the above is present. Log it per turn; it is the cheapest health
signal available and the harness surveyed here does not surface it to the agent at all.

---

## Part 5 — What a harness should do with this

- **Assemble the prompt in volatility order**, ascending: tools, frozen system, stable project
  instructions, memory index, conversation, per-turn injections last. Make that order structural rather
  than conventional, so a later contributor cannot casually insert a timestamp at the front.
- **Expose cache-read share per turn to the operator, and to the agent.** An agent asked to be
  economical with context currently cannot see the price of anything it does. This is the same argument
  as the context-composition gap in [`agent-tooling.md`](./agent-tooling.md) §Part 3.4, and cache state
  is the half with a dollar figure attached.
- **Refuse an invalidating write at the seam.** If a harness owns prompt assembly, it can reject a
  per-turn mutation of `system` and point the caller at the tail-injection channel instead. That is a
  gate, in the sense the rest of these documents use the word: the mistake becomes impossible rather
  than discouraged.
- **Make TTL a deliberate choice.** Five minutes is the default; an hour is available. For a session with
  long human think-time between turns, the default silently discards the cache during the gap.

---

## The short version

Order by volatility, freeze the head, inject at the tail. Re-anchor with a turn-scoped
`role: "system"` message rather than by rewriting the system prompt. Mount tools per session, never per
turn. And when you prune, remember that dropping the oldest dead weight is the most expensive prune
available, not the cheapest.
