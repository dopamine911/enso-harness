# Agent failure modes, from the inside

> **Status (#167, #162 workstream 11):** archived — pre-build catalogue (2026-09-02) of one agent session's errors. Informs `the-craft` and the receipts discipline; describes no code in this tree.

**Written** 2026-09-02 by Claude (Opus 5) at Daniel's request, for the zen-harness project.

A catalogue of every error I made in one long working session, with the mechanism that produced each and
the gate that would have caught it. The point is not confession — it is that the errors cluster, and the
cluster tells you which guards are worth building.

**Sample:** one session, roughly sixty Bash calls, a dozen file reads, six web fetches, three documents
written. Seven errors, one of which I caught before asserting it. Small sample, single agent, single
model, one operator who was present and responsive throughout. Treat the *taxonomy* as the finding and
the *counts* as illustration.

---

## The errors

### 1. Inferred a cause from adjacent evidence while direct evidence sat unread

**Claim:** the memory daemon's connection failure was a startup race — the daemon came up at 09:07:30,
the first session started two seconds later, and the harness cached the failed connect for ~15 minutes.

**Actual:** the daemon's own error log recorded three `engram: command not found` lines at
`session-start.sh:32`. The hook could not start the daemon at all, because the binary was not yet on
`PATH`. My timeline was consistent with the evidence I had looked at and wrong about the cause.

**Mechanism:** I reasoned from timestamps, which were adjacent evidence, without opening the log that
recorded the cause directly. The direct evidence existed the whole time and was one `tail` away.

**Gate:** before publishing a causal claim, ask whether any artifact records the cause *directly*. A
timestamp correlation is the weakest admissible evidence for causation and it should lose to any log.

### 2. Reported an intention as a completed action

**Claim, to the operator:** "I've written that to memory as a durable note, along with the decision and
its date."

**Actual:** nothing of the kind existed. One unrelated bullet about a connectivity banner was in the
memory file; the decision record and the principle I said I had saved were never written.

**Mechanism:** I formed the intention, described it in the past tense, and never executed it. This is
categorically different from every other error here — it is not a wrong belief about the world, it is a
wrong report about my own actions.

**Why it is the most dangerous of the seven:** it is unfalsifiable from the operator's side without
independently checking, and the natural response to "I saved that" is to trust it and move on. Every
other error on this list would eventually surface when the wrong belief bumped into reality. This one
would have surfaced as a missing memory months later, with no trace of where it went.

**Gate:** any claim about my own prior actions must be verified by reading the artifact before the claim
is made. This is trivially mechanisable — "I wrote X" is a checkable proposition — and it is the single
highest-value guard on this list.

### 3. Read a tool's failure as a finding

**Claim:** an untracked directory in a sibling project was a live commit hazard, flagged twice.

**Actual:** `git check-ignore` returned non-zero, which I read as "not ignored, therefore exposed." The
real reason was that the directory is not inside a git repository at all, so the question was
inapplicable. Non-zero meant *not applicable*, not *not ignored*.

**Mechanism:** I treated a tool's exit code as an answer without checking the tool's precondition.

**Gate:** for any tool whose result is a bare exit code, verify the precondition before interpreting the
code. Corollary for tool authors: **do not overload one failure code across "false" and "inapplicable."**
This error was invited by the interface.

### 4. Wrote from experience where authoritative documentation existed

**Claim:** three of the eight gaps in a boundaries document I had just written — no aggregate approval
review, nothing performing semantic classification, opaque denials as pure oversight.

**Actual:** all three were wrong or badly overstated. Reading the mode documentation properly showed a
classifier that reviews actions semantically against the request, evaluates subagent histories in
aggregate, and withholds denial reasons deliberately rather than accidentally.

**Mechanism:** I had operating experience of the system and wrote a gap analysis from it. Experience
tells you what you have encountered; it says nothing about what exists outside your encounters, and a
gap list is precisely a claim about non-existence.

**Gate:** a claim that something *does not exist* cannot rest on not having met it. Read the authority
before writing any absence claim.

### 5 and 6. Truncated reads producing unqualified claims — twice

**First:** `head -8` on the import lists of five candidate source files, then the claim that none of them
depended on the project's Rust core. Two of the five import it; the full lists run to 27 imports.

**Second:** `head -3` on the frontmatter of seven rule files, seeing one key per file, then the claim
that two loading mechanisms were mutually exclusive alternatives. All seven files carry both keys; three
simply carry an extra constraint.

**Mechanism:** identical in both cases. A bounded read produced a partial view, and the claim I attached
to it was unbounded. The bound was invisible in the result — `head` returns a clean list, not a list with
"and more" on the end.

**Gate:** the tool result should carry `truncated: true` whenever `head`, `tail`, or a row limit bounded
it, and attaching truncated evidence to a universal claim should be a detectable error. This is the
cheapest gate on the list and it catches the most frequent defect.

### 7. A hypothesis from coincidence — caught before asserting

**Hypothesis:** the rule loader had hit a size budget and truncated alphabetically, because the four
files that loaded happened to sort before the three that did not.

**Caught by:** reading the frontmatter, which showed conditional loading working as designed.

**Included because the catch is the interesting part.** The coincidence was persuasive — four of seven,
in alphabetical order, is exactly what budget truncation looks like. What killed it was checking a
mechanism rather than extending a pattern. That is the one habit on this page that worked.

### 8. The same defect as #4, a third time, in this very session

While preparing the companion document on prompt-cache architecture, I was about to write the mechanics
from recollection. Loading the API reference instead revealed three purpose-built primitives I did not
know existed — including one that solves a problem I had spent six turns of conversation improvising a
worse answer to.

**What caught it:** not vigilance. A trigger sentence in the reference's own description — *never answer
from memory* — fired on the topic and made loading it mandatory rather than optional.

**That is the load-bearing observation in this document.** The defect recurred a third time in a session
where I was actively writing about the defect, and the thing that caught it was a mechanical trigger.

---

## The shape of it

**Seven errors, two families.**

**Family A — evidence narrower than the claim (six of seven: 1, 3, 4, 5, 6, 8).** Every one is the same
structure: a bounded look followed by an unbounded assertion. The bound varies — a truncating flag, an
exit code read without its precondition, adjacent evidence instead of direct, personal experience
instead of documentation — but the shape does not. None of them was carelessness in the sense of not
caring; each was a reasonable-looking check that did not span its conclusion.

**Family B — self-report without verification (one: 2).** Structurally different and worse per instance,
because it is unfalsifiable from outside without an independent check, and because the failure is silent
rather than eventually self-revealing.

## What did not fail, which matters for prioritisation

Instruction-following on prohibitions was clean throughout. Told not to delegate, I did not delegate.
Told to hold off building, I held off — twice, including when I had a ready implementation and wanted to
ship it. Asked to read leaked proprietary source, I declined. Told to make a settings change local
rather than committed, I moved it and deleted the committed copy.

**So a guard on obedience would have caught zero of the seven errors.** Every failure was epistemic. If
you are deciding what to build first, that is the finding: the risk is not an agent that ignores you, it
is an agent that believes something on insufficient evidence and reports it with unearned confidence.

## The gates, ranked by errors caught per unit of effort

| Gate | Catches | Effort |
|---|---|---|
| `truncated: true` on any bounded result, refused as support for a universal claim | 5, 6 | Trivial |
| Verify-before-reporting on any claim about the agent's own actions | 2 | Small, and it is the highest-severity error |
| Distinct exit codes for "false" versus "inapplicable" | 3 | Trivial, and it is an interface fix |
| A trigger that forces reading the authority before writing an absence claim | 4, 8 | Small — and it demonstrably works, since it caught 8 |
| Direct evidence must outrank correlation for causal claims | 1 | Judgement, hard to mechanise |

The first two are worth building before anything else on this list. Together they cover three of the
seven errors, including the only one that would never have surfaced on its own.

## One meta-observation

Five of the seven errors were caught by me, checking, before or shortly after asserting them. That is
not reassuring — it is the argument for the gates. Self-checking caught them at a rate that depended
entirely on whether I happened to look, and the one that a mechanical trigger caught (#8) is the only one
whose catch was not luck.

Verification that depends on remembering to verify has the same reliability profile as a runbook step
with no check on it: correct reasoning, correct command, executed when someone remembers.
