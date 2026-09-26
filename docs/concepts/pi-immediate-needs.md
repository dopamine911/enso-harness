# pi — immediate needs

> **Status (re-checked 2026-09-24 against the code):** Tier 0, Tier 1 and the escalation tool (item 8)
> have landed; recoverability (items 10 and 11) is open. The per-item state, with the seam page
> or issue that is the current statement, is the **Status** column of [the table at the end](#the-order-in-one-table).
> The item bodies below are the analysis as written on 2026-09-02 and are not re-triaged.

**Written** 2026-09-02 by Claude (Opus 5) at Daniel's request, for the Enso project.

What has to exist before pi is safe to run unattended on a real repository. Grounded in the source, not
in the docs' exclusion list — every absence below was checked by reading the file that would contain it.

Paths are repo-relative to `packages/coding-agent/`. Read from a clone on 2026-09-02.

Companion to [`agent-boundaries.md`](./archive/agent-boundaries.md), which argues the general ordering
(containment before recoverability before classification). This applies that ordering to pi specifically.

---

## What pi actually ships

**Eight tools:** `bash`, `powershell`, `read`, `write`, `edit`, `grep`, `find`, `ls`.

**One policy mechanism:** tool-name allow/deny — `--tools` / `--exclude-tools`, which control *which
tools are mounted*. That is the strongest form of boundary there is (an absent tool cannot be argued
with) and it is also the *only* granularity available. There is no per-argument policy.

**A real extension API**, which is the good news: `tool_call` can block with a reason, built-in tools can
be replaced by registering a tool of the same name, and `before_provider_request` sees the wire. Every
gap below is closable at one of those seams. Nothing here requires forking pi.

**What the docs say is deliberately absent:** *"It intentionally does not include built-in MCP,
sub-agents, permission popups, plan mode, to-dos, or background bash."*

---

## Tier 0 — before any unattended run

These four are not hardening. They are the difference between a tool that damages a repository and one
that does not.

### 1. ⚠ Nothing confines writes to the workspace

`resolveToCwd` (`src/core/tools/path-utils.ts:48`) is a one-line wrapper that *resolves* a path against
cwd. It does not constrain the result. There is no `startsWith(cwd)` check anywhere in the write path.

`write`'s own description states the behaviour plainly: *"Creates the file if it doesn't exist,
overwrites if it does. Automatically creates parent directories."* No existence check, no confinement, no
confirmation.

Composed, that means a single `write` call with an absolute path — or enough `../` — overwrites any file
the process can reach, and builds the directory tree to get there. `~/.ssh/authorized_keys`,
`~/.claude/settings.json`, a sibling repository's source.

**This is the worst gap in pi and it is also the cheapest to close.** A `tool_call` handler that resolves
the target and blocks anything outside an allowed root list is a few dozen lines.

**Seam:** `tool_call` block handler. **Effort:** small. **Do this first.**

### 2. ⚠ Bash has no default timeout

`resolveTimeoutMs` (`src/core/tools/bash.ts:29`) returns `undefined` when the `timeout` parameter is
absent, and the timeout handle is only installed `if (timeoutMs !== undefined)`. The ceiling when a
timeout *is* given is `2_147_483_647` ms — about 24.8 days.

So a command that hangs — an interactive prompt nobody answers, a `psql` waiting on a lock, a `curl` to
a black hole — holds the session indefinitely with no recovery path. In an unattended run that is the
whole run.

**Seam:** wrap the `bash` tool by name-override and inject a default timeout, or clamp in a `tool_call`
handler. **Effort:** trivial.

### 3. Secret paths are readable and writable

There is no path denylist. `read` will return `.env`, `~/.aws/credentials`, `~/.ssh/id_*`,
`~/.gnupg/*`, and any `secrets.json` it is pointed at — and a secret read is the precondition for
exfiltration, so this is not only a write-side concern.

`oh-my-pi` ships a worked example of exactly this fix: `examples/extensions/tool-override.ts` overrides
`read` with a pattern denylist covering `.env`, secrets, credentials, and the `.ssh`/`.aws`/`.gnupg`
directories, plus an access log. **That file is the closest thing to a drop-in on this list.**

**Seam:** same-name tool override, or a `tool_call` handler. **Effort:** small — adapt the shipped
example.

### 4. Egress is unmodelled, and it runs through `bash`

pi has no web-fetch tool, which sounds like a smaller attack surface and is actually a larger one: the
egress path is `bash` plus `curl`/`wget`, so it inherits whatever bash policy exists. Which is none.

An agent with repository read access and unrestricted `bash` can post the repository anywhere. Nothing
in pi distinguishes fetching a public document from uploading source.

**Decide this now** even if the answer is "block all network from bash and add a narrow fetch tool with a
host allowlist." An explicit empty allowlist is a policy; the current state is an absence.

**Seam:** `tool_call` handler on `bash`, plus optionally a purpose-built fetch tool you control. **Effort:**
medium — the hard part is deciding, not implementing.

---

## Tier 1 — correctness, which an approval prompt cannot catch

### 5. No read-before-edit precondition

Nothing requires that a file was read before it is edited. `edit` does read the file at edit time and
matches exactly, so a blind edit fails rather than corrupting — the exact-match requirement is doing real
work here. But `write` has no such protection: it overwrites whole files with no knowledge of prior
content.

**The narrow, high-value version:** require that `write` targets either a file the session has read, or
a path that does not exist. That closes blind whole-file replacement while leaving file creation
unimpeded.

**Seam:** `tool_call` precondition, with read-tracking state in the extension. **Effort:** small.

### 6. No stale-write detection

`withFileMutationQueue` serialises mutations *within* the process. Nothing detects that a file changed
underneath the session — no mtime check, no content hash. `edit` fails safe by accident (a changed region
no longer matches), but `write` clobbers silently, and neither reports that the file moved.

This matters disproportionately here because of a recorded incident in this ecosystem: a concurrent agent
holding the same checkout, and unstaged work destroyed by a restore. Two agents in one tree is a real
operating mode, not a hypothetical.

**Seam:** `oh-my-pi`'s `src/tools/conflict-detect.ts` — 815 lines importing only `./index` and
`./tool-errors`, the most liftable file in that repo. **Effort:** small port.

### 7. `write` overwrites without any signal

Covered by 5 and 6 in combination, but worth stating on its own: the single most destructive built-in has
the fewest guards. Whatever policy layer you build, `write` deserves the strictest treatment of any tool
in the set.

---

## Tier 2 — the escalation channel that does not exist

### 8. ⚠ The agent cannot ask

There is no ask/prompt/question tool in pi's tool set, and no permission prompt. This has a
counter-intuitive consequence for the posture you said you want.

I described `dontAsk` earlier as the mode that produces halt-rather-than-push, and noted that denying the
ask tool is what makes it halt. **pi is already in that state — but without the halting.** With no
escalation channel, an agent facing an unlisted or blocked action cannot pause and ask; it can only
proceed differently or fail. There is no third option, because the third option requires a channel.

So "halt and report" is not a default you inherit from pi's minimalism. It is a thing you have to build:
a tool the agent can call to stop and surface a question, plus a convention that a blocked `tool_call`
returns a reason the agent is expected to escalate rather than route around.

**Seam:** register an `ask` tool; pair it with the `tool_call` block reason. **Effort:** small, and it is
a prerequisite for every mode design in [`agent-boundaries.md`](./archive/agent-boundaries.md) §Phase 4.

### 9. No mode concept at all

Tool mounting is per-process (`--tools`), so "modes" today means restarting with different flags. That is
actually fine — and better than per-turn remounting, which
[`prompt-cache-architecture.md`](./prompt-cache-architecture.md) §Part 3.2 shows invalidates the entire
cache. Mount per session, switch by starting a session.

What is missing is the *composition* that makes a mode more than a tool list: prompt, tool set, and
policy bound together as one named, checksummable artifact. That is the preset pattern, and it is design
work rather than a gap to patch.

---

## Tier 3 — recoverability

### 10. No filesystem snapshot before a mutating call

Nothing snapshots the working tree before a mutating call. Recovery is git, and for uncommitted work git
is nothing.

This is the highest-leverage item on the whole list *after* Tier 0, for the reason argued in the
boundaries doc: recoverability has no false positives, while prevention misclassifies and every wrong
block trains you to widen the rule.

⚠ **Corrected 2026-09-03.** This item previously read "No checkpoint or rewind" and named
`oh-my-pi`'s `src/tools/checkpoint.ts` as the seam. Both halves were wrong, and the error came from
reading a definition instead of an execution path — the class this project keeps hitting.

**Conversation rewind already exists, natively, and is better than the thing that was recommended.**
pi sessions are trees: every entry has an `id` and a `parentId`, the current position is the active
leaf, and `/tree` (branch in place, with an optional summary of the abandoned branch), `/fork` (new
session from an earlier user message) and `/clone` (duplicate the active branch) navigate it. There is
a `--fork <path|id>` startup flag and a `SessionManager` API. Nothing to port.

**omp's `checkpoint`/`rewind` is a context-cost tool, not a recoverability tool.** Its own tool
description is explicit: check-point before exploratory work, do the work, then `rewind(report)` so the
intermediate tool calls leave the active context and are replaced by a concise report. The
implementation matches — `CheckpointState` holds a message count and a session entry id, and rewind
truncates in-memory messages and calls `sessionManager.branchWithSummary`. It performs no git and no
filesystem operation on any path. The class's `summary` field calls it "a git-based checkpoint to save
and restore session state"; that string is what this item was originally written from, and it does not
describe what the tool does. Worth adopting **for its real purpose** — exploratory-work context
compaction — and it is unrelated to this item.

**What is actually missing is the filesystem half, and it is missing in both harnesses.** pi's sessions
persist message history only — the format carries message entries, model and thinking-level changes,
labels, compactions, branch summaries and extension entries, and no filesystem state. So this is ours
to build. The design that falls out of the above: key a working-tree snapshot to pi's session entry id,
so `/tree` navigation and tree restoration move together rather than being two unrelated rewinds.

**Seam:** a `tool_call` handler that snapshots before mutating calls, plus the `SessionManager` API for
the entry id to key on. **Effort:** moderate, and it is now a build rather than a port.

### 11. No worktree isolation

Concurrent agents share a checkout. Worth pairing with item 10 rather than treating separately.

omp has real machinery here — `src/task/worktree.ts` — but it is not liftable: it imports
`@oh-my-pi/pi-natives` (Rust), both `utils/git` and `utils/jj`, and its own isolation-ownership module.
Read it for the shape, not as a port. Harness-level either way.

---

## What not to build first

**The command classifier.** It is the most visible thing Claude Code has and the least urgent thing to
copy. With Tier 0 confinement and Tier 3 recoverability in place, argument-level command classification
is friction optimisation, not safety — and it is a long tail whose content comes from incidents rather
than from reasoning. Starting there means spending the most effort on the item with the lowest marginal
safety return, and doing it before you have the incidents that would tell you what to put in it.

Start deny-by-default with a narrow allow set and let it accrete.

---

## The order, in one table

| # | Need | Seam | Effort | Status (2026-09-24) |
|---|---|---|---|---|
| 1 | Workspace confinement for writes | `tool_call` block | Small — **do first** | **Landed** — the guards ([`seams/guards.md`](../seams/guards.md)) |
| 2 | Default bash timeout | tool override or clamp | Trivial | **Landed** — the guard patches `timeout` in when absent ([`seams/guards.md`](../seams/guards.md)) |
| 3 | Secret-path denial, read and write | tool override (omp example) | Small | **Landed** — `secret-read`, and on the bash route (#204); `grep`/`find`/`ls` too (#8); `grep` over a directory holding one, too (#160 §4) |
| 4 | Egress policy decision | `tool_call` on bash | Medium, mostly deciding | **Landed as a bar, not a boundary** (#9) — ad-hoc network clients denied, `web_fetch`/`web_search` the sanctioned route ([`seams/web-providers.md`](../seams/web-providers.md)); git remotes and interpreters stay open by statement. #160 (the deny is closed by spelling, not by class) is open |
| 5 | `write` requires prior read or a non-existent path | `tool_call` precondition | Small | **Landed** — `read-before-write` (#10) |
| 6 | Stale-write detection | port omp `conflict-detect.ts` | Small port | **Landed** — `stale-write`, built rather than ported: the stamp is pi's own `ino:size:mtimeNs:ctimeNs` (#11) |
| 7 | `write` overwrites without any signal | 5 and 6 together | — | **Landed** with 5 and 6 |
| 8 | An ask tool, so halting is possible | `registerTool` | Small | **Landed** (#12) — `ask_user`, ours: one to four questions asked as one card on the web, one prompt at a time in the terminal, with a real decline on both ([`seams/dialog.md`](../seams/dialog.md) → *Asked by the agent*). What the model must do after an unanswered question (halt, not route around) is not built |
| 9 | Modes | picc's permission modes | — | **Landed by adoption** (#13) — [`seams/permission-mode.md`](../seams/permission-mode.md). Prompt, tools and policy as one named artifact is Expansion-phase work |
| 10 | Filesystem snapshot keyed to the session entry id | build — pi's `/tree` covers conversation rewind, neither harness covers the tree | Moderate | **Open** — #146 (supersedes #14): two published candidates to source-read first |
| 11 | Worktree isolation | harness-level (omp's is Rust-bound, read only for shape) | Moderate | **Open** — #147 (supersedes #15): five published candidates to source-read first |
| — | Command classification | build and accrete | Last | **Deferred** — `architecture.md` → *Deferred, deliberately* |

Items 1, 2, 3 and 8 together are perhaps a day's work and they move pi from *unsafe to leave alone* to
*safe to leave alone within a workspace*. That is the whole Tier 0 argument: the gap between pi and a
usable harness is smaller than the exclusion list suggests, because the extension API is genuinely good —
what is missing is not capability, it is four guards nobody has written yet.

---

## Out of scope here: provider auth

pi's credential handling has two gaps of the same character — a session that cannot authenticate exits 0
with no output, and a retired credential carries no record of why it was retired. They are not safety
guards, so they are not tiered above; they live in
[`provider-auth-and-client-identity.md`](./provider-auth-and-client-identity.md) § Observability, which
also covers why Enso will not follow omp's route to subscription billing.
