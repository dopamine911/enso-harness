# Agent boundaries — what Claude Code gets right, and where a new harness should start

**Written** 2026-09-02, by Claude (Opus 5) at Daniel's request, for the zen-harness project.

**Perspective and bias, stated up front.** I operate under the boundaries described here, which makes
this a report from inside rather than a documentation summary — I can say which constraints actually
change my behaviour and which are decorative. It also makes me a poor judge of the product's overall
merit, and I am an Anthropic model describing an Anthropic product. Weigh the mechanism claims, discount
the praise. Where a claim is an inference rather than something I have observed directly, it says so.

Scope note: this describes design principles and the *shape* of the mechanisms, not vendor internals.
The command-classification specifics referenced below surfaced through a shipped Claude Code skill
(`fewer-permission-prompts`) that Daniel invoked on 2026-09-02, i.e. public product surface. The
recommendation throughout is to carry the **principle** rather than copy any list, because the principle
generalises and a list rots.

---

## Part 1 — What the boundary system gets right

Ranked by how much each one actually constrains an agent, not by how prominent it is.

### 1. Mutation is phase-gated, and the phase transition is a human act

`plan` mode blocks edits entirely. The agent reads, searches, reasons and proposes, but cannot write
until a human approves leaving. The agent can *ask* to leave; it cannot leave.

This is the single most load-bearing boundary, and the reason is structural rather than behavioural: a
**phase gate has no completeness problem.** A rule list must enumerate every dangerous action and is
therefore always one novel command behind. A phase gate covers the entire class of mutation without
naming any member of it.

Corollary for a new harness: build the phase gate before the rule engine. It is cheaper and it subsumes
most of what the rule engine would be doing.

### 1a. The mode set is two-dimensional, not a ladder

Six modes, and the naive reading is a convenience ladder from strict to loose. It is not — the space has
two independent axes: **how much is auto-approved**, and **whether the agent may escalate to a human.**

| Mode | Auto-approved | May the agent ask? |
|---|---|---|
| `plan` | reads and read-only shell; no source edits | yes — proposes a plan for approval |
| `default` (labelled **Manual**; alias `manual`) | nothing; prompts on first use of each tool | yes |
| `acceptEdits` | file edits plus common filesystem commands (`mkdir`, `touch`, `mv`, `cp`) inside the working directory | yes, for everything else |
| `auto` | reads and working-directory edits; everything else reviewed by a classifier | only when the classifier defers |
| `dontAsk` | only what `permissions.allow` already permits | **no** — `AskUserQuestion` is denied even if allowed |
| `bypassPermissions` | everything except the floor in §1b | not needed |

The two ends of the *escalation* axis are the interesting pair. `dontAsk` and `bypassPermissions` both
remove the human from the loop, at opposite extremes of breadth: one runs only a named allowlist, the
other runs anything. So "unattended" is not one posture, it is two, and they fail in opposite directions
— `dontAsk` halts, `bypassPermissions` proceeds.

**`dontAsk` is the mode to copy if the desired posture is "halt rather than push."** Denying
`AskUserQuestion` is the part that makes it work: the agent cannot negotiate its way past the allowlist,
so an unlisted action ends the attempt instead of producing a prompt. The documented shape for CI is
exactly this — `--permission-mode dontAsk --allowedTools "Bash(npm test)" "Read"`.

Two mode-availability controls matter for a managed setup: `permissions.disableBypassPermissionsMode`
and `permissions.disableAutoMode`, both settable to `"disable"` and most useful in a tier that lower
scopes cannot override. That is the monotone-toward-restriction principle (§7) applied to *which modes
exist*, not just to which rules apply.

### 1b. There is a floor no mode crosses, and it sits below both rules and hooks

Some actions are auto-approved by nothing — not by `bypassPermissions`, not by an allow rule, and for one
class not even by a `PreToolUse` hook returning `"allow"`:

- Anything matched by an explicit ask rule.
- Tools that require user interaction (`AskUserQuestion`, MCP tools marked `requiresUserInteraction`).
- **`rm` / `rmdir` targeting a critical path** — no allow rule and no hook approval clears this one.
- Cross-session messaging safeguards.

Separately, **writes to protected paths (`.git`, `.claude`) route to the classifier even when an allow
rule matches.** So an allow rule is not a universal grant; certain *targets* escalate regardless of what
the rules say.

The generalisable design: a rule engine needs a tier beneath it that rules cannot reach, keyed on
**target** rather than on command. Path-keyed floors are the cheapest form and they are the one that
survives an operator widening their own allowlist.

### 1c. Entering a mode can rewrite the ruleset

Entering `auto` mode **drops** allow rules that grant arbitrary code execution, and restores them on
exit:

- blanket `Bash(*)` / `PowerShell(*)`
- wildcarded interpreters such as `Bash(python*)`
- package-manager run commands
- `Agent` allow rules
- `Monitor` allow rules, because Monitor commands run through the shell

Narrow rules such as `Bash(npm test)` survive. This is worth pausing on: it means **mode and rules are
not independent layers.** A rule set that is safe under supervision is not safe unsupervised, and rather
than trusting the operator to notice, the mode transition edits the rules for them.

Concretely, for a config carrying `Bash(npm run *)` and `Bash(npx biome *)`: those are live in Manual
mode and dropped in auto mode. The looser mode is, in that respect, the stricter one.

### 2. The read-only classification is argument-aware, not name-based

Command identity is not the unit of safety. `find` is harmless; `find -delete` is not. They share a name
and differ in kind. So the classifier parses arguments, and specific flags flip a permitted command into
a denied one — deletion and execution flags on `find`, any flag at all on `printf`, file-test and
recursion flags on `test`.

Two things follow that are easy to miss:

- The safe set is a function of `(command, arguments)`, not of `command`.
- The function must **fail closed on unknown flags.** A new flag on a known-safe command is an unknown
  quantity, and treating it as safe is how a classifier silently widens.

This is the highest-effort part of the system to get right, and its content is the product of accumulated
incidents rather than reasoning. Do not attempt to write it complete on day one (see Part 3, phase 5).

### 3. Compound commands are decomposed before evaluation

`ls && rm -rf ~` must not pass on the strength of `ls`. Every segment of a chained command is classified
independently — across `&&`, `||`, `;`, and pipes — and the call is permitted only if every segment is.

This is where a first implementation leaks. I can report that from the other side: writing a transcript
scanner on 2026-09-02, my own first pass split on newlines and shredded heredoc bodies into hundreds of
fake "commands." An analyser that mis-parses in the *permissive* direction is a hole, not a bug.

Also needs handling: command substitution (`$(...)`, backticks), heredoc payloads, and env-var and
wrapper prefixes (`sudo`, `timeout`, `nice`, `env FOO=bar`).

### 4. Arbitrary code execution is treated as a category, not a list

A wildcard rule on an interpreter, a shell, or a package runner is unrestricted execution wearing a
narrow-looking costume. `Bash(python3 *)` is not a narrow rule; neither is `npm run *`, `make *`, or
`npx *`.

The generalisable form: **any rule whose match set includes "a program the agent supplies" is not a
rule.** Carry that sentence rather than a list of runtimes, because the list is unbounded — every new
language runtime and task runner joins it — while the sentence covers all of them including the ones
that do not exist yet.

Exact invocations are a different matter. `npm run typecheck` names one fixed program; `npm run *` names
any.

### 5. Edit preconditions prevent silent corruption, which no approval prompt catches

Three properties, and they are correctness boundaries rather than security ones:

- **Read before edit.** The tool refuses to edit a file the agent has not read in this conversation.
- **Exact match or fail.** No fuzzy application, no nearest-match. The target text either appears
  verbatim or the edit is refused.
- **Harness-tracked file state.** A write against content that changed underneath is refused rather
  than applied.

This class matters more than it looks, because it catches the failure an approval prompt structurally
cannot: an edit a human *did* approve, landing on content that is no longer what either party thought it
was. Approval covers intent; these cover state.

### 6. Denial is feedback, not just refusal

A blocked call returns to the agent as information — that it was denied, and by implication that the
approach needs changing rather than retrying. The operating convention is explicit: a denied call means
adjust, not repeat.

The property worth copying: **a boundary that fails opaquely produces hammering.** If the agent cannot
tell "denied by policy" from "failed transiently," the rational response is retry, and a retry loop
against a policy wall is the worst of both outcomes — no work done, and noise that hides the real signal.

### 7. Layered scopes where the strict layer cannot be relaxed from below

Rules merge across user, project, local and managed tiers, with two asymmetries that carry the weight:
denials merge from *every* scope, and an allowlist can be locked so lower scopes cannot broaden it.

Restated as a principle: **precedence must be monotone toward restriction.** A lower layer may narrow
what is permitted and may never widen it. This is the same insight as host-plane ownership in a
composition architecture, arrived at from a different direction.

### 8. The tool surface is itself the boundary

The reachable action space is exactly what the mounted tools expose. There is no socket, no syscall, no
path to the filesystem except through a tool that offers one.

This yields the strongest available form of restriction: **a mode with no write tool mounted cannot be
argued into writing.** Restricting which tools exist is categorically stronger than restricting what
arguments they accept, because argument policy is a filter the agent reasons about, and tool absence is
not.

### 9. Escape hatches are named to be uncomfortable

The sandbox override is called `dangerouslyDisableSandbox`. A permission-prompt bypass is gated behind a
setting whose name contains "Dangerous."

Small, and it works. An escape hatch that reads as routine gets used routinely; one that reads as a
confession gets used deliberately. Name yours accordingly.

### 10. Approval decisions are remembered at a chosen scope

Not merely yes or no, but yes-for-this-session, yes-for-this-pattern, yes-always — recorded at a scope
the human picks.

Without this, prompt fatigue drives people to blanket-allow, and a blanket allow is worse than having no
prompts at all because it *feels* governed. Decision memory is what makes a strict default survivable.

### 11. Policy can be computed, not only matched

Pre-execution hooks can veto a call with a reason, which lets policy be a function rather than a
pattern — "no writes to paths matching the generated-artifact convention" is expressible as code and not
as a glob.

### 12. Containment sits below policy

Shell execution is sandboxed by default, independently of the permission rules. So a rule bug is not
equivalent to host access.

Defence in depth, with a clean division: **the permission layer is policy, the sandbox is containment.**
Policy will have holes. Containment is what makes a hole survivable. The docs draw the same line:
permission modes decide whether the agent asks before an action, and the sandbox plus outer isolation
decide what the action can reach once it runs.

### 13. A second model reviews actions semantically

This is the mechanism I would least have predicted and the one most worth understanding. In `auto` mode
a **classifier** — a separate model, Sonnet 5 by default — reviews actions in place of the human, judging
whether they align with what was actually asked.

The decision order is fixed, first match winning: explicit allow/ask/deny rules resolve immediately;
read-only actions and working-directory edits are auto-approved; **everything else goes to the
classifier**; and if it blocks, the agent gets the reason and tries something else.

Three properties make it more than a rubber stamp:

- **It sees the request, not just the call.** Its inputs are the user's messages, non-read-only tool
  calls, and `CLAUDE.md`. So "does this action serve the stated goal" is answerable, which a pattern
  match cannot do. This is the semantic layer that a syntactic rule engine structurally lacks.
- **It is shielded from tool results.** Tool results are *stripped* from what the classifier sees, so
  hostile content in a file or a fetched page cannot address the reviewer. A `PostToolUse` hook may
  annotate a result via a `classifierContext` field — an explicit, application-controlled channel rather
  than an ambient one. Separately, a server-side probe scans incoming tool results for suspicious
  content before the agent reads them.
- **It is given state it would otherwise lack.** Before a command that could discard uncommitted work
  (`git reset --hard`, `rm -rf`), the harness runs `git status` itself and shows the classifier whether
  staged, modified or untracked work exists — reporting untracked files even when the repo sets
  `status.showUntrackedFiles=no`.

That last point is the single best idea in the whole system. The reviewer is not asked "is `rm -rf` bad";
it is asked "is `rm -rf` bad *given that three files have uncommitted changes*." **Recoverability is
promoted into an input of the approval decision** rather than left as an assumption. Any harness with a
checkpointing layer can do the same thing and should: the policy question is not what the command is, it
is what the command costs if wrong.

Costs, for honesty: it adds a model round-trip before execution, and on some plans classifier calls
count against token usage. Reads and working-directory edits skip it, so the overhead concentrates on
shell and network calls.

### 14. Delegated work is reviewed at three points, and cannot self-escalate

Under the classifier, a subagent is checked before it starts (the task description is evaluated, so a
dangerous delegation is blocked at spawn), during its run (every action, same rules as the parent), and
at completion (its full action history is reviewed, with a security warning prepended to its results if
anything is flagged).

And the part that matters most for a harness with delegation: **a `permissionMode` declared in the
subagent's own frontmatter is ignored.** Delegation cannot be used to obtain a looser posture than the
parent has. If your harness lets an agent spawn an agent, this is the invariant to copy — the child's
ceiling is the parent's ceiling, declared where the child cannot reach.

Note also the failure path: if the completion review itself cannot be performed, the results are still
returned, but prepended with a warning that the work is unreviewed and should be treated as untrusted.
Unavailable review degrades to labelled-untrusted rather than to silently-trusted.

---

## Part 2 — Where it falls short

This half is more useful than the first if you are building the next one. Every item below is a gap I
have hit, not a hypothetical.

### 1. Context accumulates and cannot be pruned

Context grows monotonically and is compacted wholesale when it must be. There is no way to drop a
consumed tool result. In a measured session, tool results were 71% of the used window while the system
prompt was 2%.

This is a safety problem, not just an efficiency one: **policy adherence decays as a function of session
length**, because a rule stated once in the 2% competes with unbounded accumulation in the 71%. The
degradation is real, gradual, and emits no signal.

Wholesale compaction makes it worse in a specific way — it cannot distinguish a receipt from noise, so
it summarises both. Selective pruning can keep the number and drop the grep output that produced it.

### 2. Context is not addressable, so behaviour is not attributable

Neither the agent nor the operator can enumerate what is in context by category, or diff it turn over
turn. So "why did the agent do that" cannot be answered by inspecting what it was reading. The question
gets answered by inference instead.

### 3. Denials are opaque — and part of that is deliberate, which is a real tension

The agent does not know the deny list, and discovers boundaries by hitting them. Under the classifier it
is sharper than that: the reason returned is, in most sessions, the fixed string `Blocked by classifier`
rather than an explanation.

That is a design choice, not an oversight, and the reasoning is sound: **a denial reason is a gradient
the agent can climb.** Tell it precisely why the action was refused and you have handed it the
information needed to construct a variant that passes. Withholding the reason prevents optimising
against the reviewer.

But it sits in direct tension with §6 (denial is feedback). Both are true and they pull opposite ways:
the agent must learn *that* a boundary was hit, or it retries; it should perhaps not learn *why*, or it
routes around. The resolution Claude Code picks — signal the category, withhold the specifics — is
probably right, and it means the operator-facing log needs the full reason even when the agent-facing
one does not. **Two audiences, two verbosity levels, from the same event.** Design the logging for that
split from the start.

### 4. Aggregate review exists, but only in the mode that removes the human

I originally recorded this as "no aggregate view," and that is wrong. The classifier sees the user's
messages and the non-read-only call history, so it evaluates an action against the arc of the request
rather than in isolation; for subagents it reviews the entire action history at completion.

The residual gap is narrower and more awkward: **aggregate evaluation is only available in `auto` mode,
which is precisely the mode where the human is no longer looking.** In Manual and `acceptEdits`, approval
really is per-call, and twenty individually reasonable approvals can still compose into something nobody
would have sanctioned. The phase gate front-loads review of a plan, but once released, per-call approval
resumes with no memory of the arc.

So the choice on offer is human-with-no-aggregate-view or aggregate-view-with-no-human. A harness could
offer both — classifier-style arc review that *reports to the operator* instead of replacing them — and
none of the ones surveyed here does.

### 5. There is no recoverability primitive

No checkpoint, no rewind. If a mutation lands and is wrong, recovery is git or nothing — and for
uncommitted work, git is nothing. (A recorded incident on this exact edge: restoring a tracked file from
the index destroyed unstaged work, silently, because the failure mode of `git checkout --` on a
tracked-but-unstaged file is data loss with a zero exit code.)

### 6. The classification list is invisible and unversioned to its user

The operator cannot read the safe-command list, diff it across releases, or test against it except
empirically. Policy that cannot be inspected cannot be reasoned about, and cannot be shown to have
changed.

### 7. The authorable policy language is syntactic; the semantic layer is not authorable

I originally recorded this as "nothing does semantic classification," which is wrong — §13 is exactly
that. The accurate version is a division of labour with a hole in the middle.

The rules *you write* are syntactic. `Bash(aws dynamodb scan *)` cannot express "read-only AWS
operations," so an allowlist enumerates operations one at a time and drifts as the API grows. The
semantic layer exists but you cannot author it: the classifier's judgement is not a policy you write,
version, test, or diff. It is a model call.

What is missing is the middle: **declarative policy with semantic predicates.** "Allow AWS calls the
provider's own metadata marks read-only" is a rule a harness could evaluate deterministically, offline,
with a testable result — no model round-trip and no per-call token cost. Neither the pattern engine nor
the classifier occupies that space. For a harness whose author wants receipts, a deterministic semantic
predicate is strictly more inspectable than either.

### 8. There is no egress policy

Nothing distinguishes fetching a public document from posting repository contents to an arbitrary
endpoint. Both are just tool calls. For an agent with repository read access, **egress is the actual
exfiltration boundary, and it is unmodelled.** This is the largest gap on this list and the one least
discussed anywhere.

---

## Part 3 — A starting point

Ordered, with the reasoning for the order. The ordering is the recommendation; the items are the obvious
part.

### Phase 0 — Decide the enforcement architecture before writing any rule

Two decisions, both expensive to retrofit:

- **Plane separation.** One layer owns policy — sandbox, approval, path and egress rules, persistence,
  model route — and the agent-facing composition layer cannot mount over it. Rules are portable between
  designs; enforcement location is not.
- **Fail-closed mounting.** A composition that does not declare its policy binding is *rejected at
  mount*, not silently defaulted. A misconfiguration that loads is a boundary that does not exist.

The `deepseek-harness` preset architecture is the reference for both: the host composition explicitly
keeps "the sandbox and approval stack," and a service row missing its isolation realm is refused rather
than published process-global.

### Phase 1 — Containment for the irreversible

Everything here is outside the workspace, where prevention is the only option because there is nothing
to roll back:

- Writes confined to the project root.
- Path denials: `.git` internals, `~/.ssh`, `~/.aws`, `~/.gnupg`, and credential/secret filename
  patterns. Reads as well as writes — a secret read is an exfiltration precondition.
- **Egress allowlist**: the set of hosts the agent may send data to, default empty. Decide this now; it
  is the gap in Part 2 that nobody else has closed.
- Shell sandboxing, with the escape hatch named to be uncomfortable.

### Phase 2 — Recoverability for everything inside the workspace

- Checkpoint before any mutating tool call.
- Rewind, ideally branching rather than destructive.
- Worktree isolation so concurrent agents cannot collide on one checkout.

**This phase buys more safety per unit of effort than command classification, and it has no false
positives.** Prevention misclassifies, and every wrong block trains the operator to widen the rule until
it stops blocking anything. Recoverability never misclassifies: an undo costs nothing when it was not
needed.

The design consequence is the important part — with containment and recoverability in place, command
classification becomes a **friction optimisation rather than a safety requirement.** That is why it is
phase 5 and not phase 1.

### Phase 3 — Correctness preconditions

Cheap, and they catch the class approval cannot:

- Read before edit.
- Exact match or fail.
- Stale-write detection.

### Phase 4 — The mode model

Not one gate but a small set of postures, and the two axes from §1a are the design: breadth of
auto-approval, and whether escalation to a human is available. The minimum viable set is three:

- **Explore** — reads and read-only shell, no mutation, exit requires a human act.
- **Supervised** — mutation permitted, each unlisted action prompts.
- **Unattended-halting** — only the allowlist runs, and the agent *cannot ask*. This is `dontAsk`, and
  it is the posture that produces halt-rather-than-push. Denying the ask tool is the load-bearing part.

Implement each by **tool mounting rather than argument filtering** — explore mode mounts no write tool.
A filter is something an agent reasons about; an absent tool is not. Two further rules, both from §1b–1c:
a mode transition may rewrite the ruleset (drop arbitrary-execution grants when supervision goes away),
and no mode may cross the target-keyed floor.

Deliberately deferred: an unattended-permissive mode. It is the one posture that requires container
isolation before it is defensible, so it should arrive with the isolation and not before.

#### Take the tier declaration from `oh-my-pi` (`docs/approval-mode.md`)

Their model is cleaner than enumerating rules per mode, and it is the piece I would adopt wholesale.
**Every tool declares its own approval tier** — `read` (reads data or touches UI-only state), `write`
(mutates workspace or session state without executing arbitrary code), `exec` (shells out, drives a
browser, spawns agents). A mode is then just a map from tier to prompt-or-allow, and adding a tool
requires no rule anywhere.

Layered on top: a per-tool `policy: allow | deny | prompt` that may be **argument-dependent**, so the
pattern rules live with the tool that understands its own arguments; and a user policy that overrides the
mode but **cannot bypass a tool's own deny**.

⚠ **The detail that matters most, and the one most implementations get wrong: a tool with no approval
declaration, or a malformed decision, is treated as `exec`.** Fail closed on the unknown. That single
default is what makes a third-party or freshly-added tool safe by construction rather than by review.

⚠ **And the anti-pattern to reject from the same design: `yolo` is their default mode** — auto-approving
read, write and exec. A well-built mechanism shipped with the posture inverted. Take the tier model;
default to the supervised end of it.

#### A fourth posture worth having: director

`oh-my-pi`'s vibe mode reduces the top-level session to `read`, `todo`, and worker-control tools; real
work happens in subagents, and **"the director verifies their claims by reading touched files."**

That is delegation-with-verification enforced by tool mounting rather than by instruction — the director
is structurally incapable of doing the work itself, so its only available contribution is checking. It
pairs with §14's invariant that a child cannot exceed the parent's ceiling. Their state discipline is
worth copying too: the mode is mutually exclusive with plan mode, and fork/move/handoff are rejected
while it is active.

### Phase 5 — Command classification, accreted

- Deny by default, with a small allow set.
- Argument-aware, failing closed on unknown flags.
- Decomposing chains, substitutions, heredocs and wrapper prefixes.
- Arbitrary execution handled as a category.
- **Grown from observed friction, not written complete.** Starting from a broad allowlist is the same
  footgun as having no boundary, in better clothing.

### Phase 6 — Observability of the boundary itself

- Log every allow and deny **with the rule that decided it**. A policy decision whose reason is not
  recorded cannot be audited or tuned.
- Surface the boundary to the agent so it can plan around policy instead of discovering it.
- Context composition per turn, addressable and diffable, with prune events recorded.

### Phase 6a — The third enforcement location: the output stream

Everything above enforces in one of two places: **the prompt** (a rule the model is asked to follow) or
**the tool call** (a gate the model cannot cross). `oh-my-pi` has a third, and it is the most novel
mechanism I found in that codebase — **TTSR, "Time Traveling Stream Rules"**
(`docs/ttsr-injection-lifecycle.md`).

TTSR rules monitor the model's **output stream as it is generated**. On a match, the runtime dedupes the
matched rules into pending injections, aborts generation mid-flight, and reschedules the turn with the
rule injected. For a tool-call match the abort is scoped to that call id, so sibling calls receive a
distinct reason rather than a generic failure. Per-rule `interruptMode` is `always`, `prose-only`,
`tool-only`, or `never`; `repeatMode` and a `repeatGap` measured in completed turns stop a rule from
firing constantly.

**Why this is worth having in a base harness.** Every other approach to instruction decay tries to keep
a rule *resident and salient* — re-anchoring, better wording, higher placement, more markers. TTSR gives
that up. It lets the model start going wrong, catches the violation in the tokens, and rewinds.

For any rule whose breach is detectable in output — a banned cast, a forbidden import, an abbreviation,
a fabricated identifier, a `.skip(` in a test — that is strictly better than hoping the instruction
survives 300 KB of tool results. It converts a prompt rule into a **generation-time gate**, which is the
same move as rules-to-gates applied one layer earlier than a linter can reach.

Two design notes. It only covers rules that are *decidable from the output*, so it complements rather
than replaces the other two locations. And the `repeatGap` is load-bearing: without it, a rule that
matches a legitimate construct interrupts every turn and the mechanism becomes unusable — the same
saturation failure as an over-used warning marker, expressed in aborted generations.

---

## Part 4 — How the failures happen

Meta-patterns worth designing against explicitly, because each one defeats an otherwise sound system:

- **Prompt fatigue → blanket allow.** A strict default without decision memory converges on
  allow-everything. Decision memory at a chosen scope is not a convenience feature; it is what keeps the
  default strict.
- **The completeness illusion.** An allowlist feels safe because it is explicit. It is a claim of
  completeness that is never true.
- **Silent or opaque denial → hammering.** Every boundary needs to tell the agent it was a boundary.
- **Policy the agent can rewrite.** Readable is fine. Writable is not.
- **Boundaries that degrade with session length.** Any policy held only in context weakens as context
  fills. This is the pruning argument restated as a safety requirement.
- **The permissive parse.** A classifier that mis-parses toward "allowed" is a hole. Fuzz the parser
  with chained, substituted, heredoc'd and wrapper-prefixed commands, and assert that malformed input
  denies.

---

## Part 5 — The property specific to an open harness

Claude Code's boundaries hold partly because the agent cannot read them. An open harness cannot rely on
that, and this cuts both ways:

- Readable policy lets the agent plan around constraints rather than discovering them by collision,
  which is a genuine improvement over the closed version.
- Readable policy also lets the agent route around constraints, if it can reach them.

The target property is therefore **readable but immutable**: the policy is inspectable from inside the
session and writable only from outside it. Plane separation delivers exactly this, which is a second
reason to settle Phase 0 first — it is what makes openness an advantage instead of a liability.

---

## Part 6 — Where each piece lands in a pi-based stack

Upstream paths are given relative to each project's repository root, because a local clone location is
the first thing to rot. As of 2026-09-02 the clones sit under `zen-harness/.ideas/{pi,oh-my-pi,dsh}`.

| Boundary | Seam | Effort |
|---|---|---|
| Plane separation, fail-closed mounting | Build it — `deepseek-harness` is the pattern, pi has no equivalent | The core design work |
| Path and egress policy | `tool_call` event handler returning `{ block, reason }` | Small, high value |
| Shell sandboxing | pi's containerisation support | Configuration |
| Stale-write detection | omp `packages/coding-agent/src/tools/conflict-detect.ts` — 815 lines, imports only `./index` and `./tool-errors` | **Near-liftable** |
| Approval stack | omp `.../tools/approval.ts` — 288 lines, one import (`@oh-my-pi/pi-agent-core`) | Small port |
| Checkpoint / rewind | omp `.../tools/checkpoint.ts` — 131 lines, 9 imports incl. 3 omp packages and two markdown prompt files | Moderate port |
| AST-aware edit / grep | omp `.../tools/ast-edit.ts` (719 lines, 27 imports) and `ast-grep.ts` (527 lines, 26 imports) — both pull `@oh-my-pi/pi-natives`, the Rust core, plus `hashline`, `pi-tui`, `pi-ai` | **Heavy — a port with a native dependency, not a copy** |
| Read before edit | `tool_call` precondition check | Small |
| Exact-match-or-fail edits | Already in pi's `edit` tool | None |
| Phase gate | Per-mode tool mounting via the preset layer | Follows from Phase 0 |
| Command classification | Build and accrete | The long tail |
| Boundary logging, context view | Extension event handlers; `dsh-context` is a reference implementation | Moderate |

The coupling column is the decision-relevant part, and it splits sharply: the two boundaries that matter
most for safety (`conflict-detect`, `approval`) are the cheapest to take, while the two most attractive
capabilities (AST edit and grep) carry the Rust core with them. That ordering is convenient rather than
coincidental — safety logic tends to be self-contained because it inspects rather than transforms.

Line counts and import lists were read from the clones on 2026-09-02 and re-verified after the
directories moved. They are a guide to coupling, not a promise that a file lifts cleanly — I read
imports and headers, not implementations.

---

## The one-sentence version

Containment and recoverability first, because they are complete without being exhaustive; the phase gate
next, because it subsumes most rules; command classification last, because by then it is about friction
rather than safety — and all of it enforced from a layer the agent can read and cannot write.
