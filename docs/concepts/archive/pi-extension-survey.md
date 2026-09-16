# Off-the-shelf survey — what covers `pi-immediate-needs`, and what does not

> **Status (#167, #162 workstream 11):** archived — pre-build survey (2026-09-03) of off-the-shelf extensions against `pi-immediate-needs`. The choices it led to are the vendored packages in `packages/harness/package.json` → `pi.extensions`; the survey itself is dated the day it was written.

**Written** 2026-09-03 by Claude (Opus 5) at Daniel's request, for the zen-harness project.

The "use off-the-shelf plugins and extensions first" strategy, checked against the eleven needs in
[`pi-immediate-needs.md`](../pi-immediate-needs.md)). Sources: the pi package catalogue
(`pi.dev/packages?type=extension`, 58 extensions listed on 2026-09-03), the sixteen packages installed
on this machine, and `@oh-my-pi/pi-coding-agent` 17.2.14 as a source of ports.

**Method, and the reason for it.** Every row marked *adopt* or *port* was checked by reading the
package's own source. Rows carrying a candidate that was not opened are marked **blurb only** and are
not recommendations. That distinction is load-bearing, not procedural — see the next section.

---

## The catalogue description is not evidence

`cc-safety-net`'s catalogue entry reads *"block destructive commands and secret file access."* Its
installed v1.0.6 pi extension does not do the second half. The extension registers one `tool_call`
handler whose adapter table is `{bash, Shell}`; it never sees `read`, `write` or `edit`. The `"read"`
and `"write"` strings that make it look broader are entries in a shell-builtin safe-command name list.

One package, one blurb, one wrong half. Treat catalogue copy as a pointer to source, never as coverage.

## The headline: Tier 0 item 1 is open across the whole catalogue

Item 1 — *nothing confines writes to the workspace* — is the worst gap in pi and it is closed by nothing
available. The two packages that looked like they closed it:

- **`cc-safety-net`** never reaches the write path at all, per above.
- **`@firstpick/pi-extension-safety-guard`** does handle `write` and `edit`, but through
  `isProtectedPath` — fifteen regexes over secret filenames (`.ssh`, `.env`, `.pem`, `.aws/credentials`,
  `.kube/config`, …). That is a **secret-file denylist, not workspace confinement**. A write to
  `~/Projects/other-repo/src/main.ts` or `~/.claude/settings.json` matches nothing and proceeds.

⚠ The denylist/allowlist distinction is the whole finding. Confinement needs an **allowlist of roots**;
every denylist leaves everything unlisted writable. This is the inverse of the exclusion-over-inclusion
rule that applies to *enumeration* — for a boundary the asymmetry runs the other way, because an
incomplete denylist silently permits.

So `packages/harness/extensions/guards` is not redundant with anything on the shelf.

## Item → candidate

| # | Need | Best candidate | What was verified | Verdict |
|---|---|---|---|---|
| 1 | Confine writes to workspace | — | nothing in catalogue covers it | **ours** |
| 2 | Bash default timeout | — | nothing found | **ours** |
| 3 | Secret paths | `safety-guard` (write/edit half) | 15-regex denylist; **no `read` handler** | **ours**, lift its regex set |
| 4 | Egress / bash policy | `cc-safety-net`; omp `bash-interceptor.ts` | cc-safety-net is destructive-command analysis (git reset/clean/checkout/restore/push, `rm -rf`, target classes like `outside_anchored_cwd`), **not** egress; fails **closed** on analysis error | **adopt** + port for egress |
| 5 | Read-before-write | omp `file-recorder.ts` — 35 lines, 2 imports | read-tracking primitive | **port** — smallest win here |
| 6 | Stale-write detection | omp `conflict-detect.ts` — 815 lines, 2 imports | most liftable file in omp | **port** |
| 7 | `write` strictness | composite of 5 + 6 | — | falls out |
| 8 | The agent can ask | `@juicesharp/rpiv-ask-user-question` v1.20.0 (installed) | non-interactive returns `{answers: [], cancelled: true, error: "no_ui"}` — errors, does not hang | **adopt**, with the caveat below |
| 9 | Modes | `@narumitw/pi-plan-mode`, `pi-tbox` | blurb only | design work, not a package |
| 10 | Filesystem snapshot | — | pi's `/tree` covers conversation rewind natively; **neither harness snapshots the tree** | **build** — see `pi-immediate-needs.md` §10 |
| 11 | Worktree isolation | omp `src/task/worktree.ts` | real, but imports `@oh-my-pi/pi-natives` (Rust), `utils/git`, `utils/jj`, isolation-ownership | read for shape; harness-level |

**Deliberately not recommended:** omp's `ask.ts` (1,459 lines, 14 imports — the catalogue package is
better) and `fetch.ts` (1,908 lines, 35 imports). Both are the wrong side of the port/adopt line.

**The item 8 caveat.** The ask tool supplies the *channel* when a human is present. It does not supply
halt-on-unattended: `no_ui` returns as an error and the agent then proceeds however it likes. Halting
still needs the convention on top — a blocked `tool_call` whose reason must be escalated rather than
routed around, and something that treats `no_ui` as terminal. Item 8 is half-closed by adoption, and the
remaining half is ours.

## Port candidates, by liftability

Import count is the portability signal; omp's leaf modules are liftable and its wired ones are not.

| File | Lines | Imports | For |
|---|---|---|---|
| `src/tools/file-recorder.ts` | 35 | 2 | item 5 |
| `src/tools/bash-interceptor.ts` | 148 | 2 | item 4 |
| `src/tools/approval.ts` | 279 | 1 | items 8, 9 |
| `src/tools/conflict-detect.ts` | 815 | 2 | item 6 |
| `src/tools/checkpoint.ts` | 137 | 9 (3 omp pkgs + 2 `.md`) | context cost, **not** item 10 |
| `src/tools/ask.ts` | 1,459 | 14 | — prefer the catalogue package |
| `src/tools/fetch.ts` | 1,908 | 35 | — too wired |

## Composition is the unsolved design problem

Adopting even two guards means several `tool_call` handlers on `bash`, in manifest order, with the first
`block` short-circuiting and unable to be un-blocked. Two decisions have to precede that:

**Mixed fail modes under one call.** Three adopted guards, three answers to *"what happens when we
cannot tell"*: `cc-safety-net` fails **closed** on analysis error; `safety-guard` blocks when
non-interactive but **prompts** otherwise; ours **blocks** outright. A composed stack whose fail mode
depends on which member noticed first does not have a fail mode.

**N independent allow-stores that do not agree.** `safety-guard` persists "allow once / for this session
/ always in this cwd" in its own state. Every adopted guard brings its own. A grant in one is invisible
to the others, so the same action can be approved and still blocked.

Neither is a reason not to compose. Both are reasons the composition needs an owner.

## Measured: per-command prompting on pi is ~99% noise

`~/.pi/agent/extensions/pi-permission-system/logs/` holds **1,753 permission reviews** from a run
between 2026-06-30 and 2026-07-02.

| | |
|---|---|
| Approvals | **1,332** — session 972, once 240, for-session 120 |
| Denials | **11** — 8 denied, 2 policy, 1 with-reason |
| Approve rate | **99.2%** of resolved reviews |
| `bash` share | 1,668 of 1,753 = **95%** |
| Largest single pattern | **`cd *` — 765 occurrences** |
| `read` / `write` / `edit` | 34 / 8 / 5 |

⚠ This measures what `pi-immediate-needs.md` §"What not to build first" only argued. The argument was
that a command classifier is the least urgent thing to copy; the data says an interactive per-command
permission layer is overwhelmingly noise, and that its largest single source is a command which cannot
damage anything. 972 of the approvals were *session* approvals — i.e. the operator answering "stop
asking me."

Two conclusions follow, and they point the same way:

1. **Gates, not prompts.** A mechanical check that runs without asking is the right instrument;
   an approval prompt is the wrong one for anything a rule can decide. This is the seam the
   slop-factory gating work lands on. `pi-lens` (installed, v3.8.65 — LSP, linters, formatters,
   type-checking) is where those gates attach.
2. **Confinement over classification.** Item 1 blocks a class without asking anything. That is why it
   is first and the classifier is last.

## Installed state on this machine

Sixteen packages in `~/.pi/agent/settings.json`. Relevant ones, with peer ranges as declared:

| Package | Version | Declared peer | Relevance |
|---|---|---|---|
| `cc-safety-net` | 1.0.6 | *(none)* | item 4 |
| `@juicesharp/rpiv-ask-user-question` | 1.20.0 | `*` | item 8 |
| `@juicesharp/rpiv-advisor` | 1.20.0 | `*` | second-opinion channel |
| `pi-lens` | 3.8.65 | `*` | the gating seam |
| `pi-hermes-memory` | 0.7.23 | `>=0.74.0` | memory; also claims secret scanning |
| `pi-multi-account` | 1.13.8 | `*` | ⚠ **fatal at startup** against pi 0.84.4 |

⚠ **Peer ranges are not a compatibility signal in this ecosystem.** Of the packages carrying a peer
declaration at all, nearly every one says `*`. `pi-multi-account` 1.13.8 declares `*` and throws at
startup on pi 0.84.4 reading a property of a provider object that no longer exists. There is no
mechanism that would have warned. Assume any adopted package can break on a pi minor bump, and pin.

⚠ Also note `~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent` is **0.80.3** while the
global CLI is 0.84.4 — the package tree resolves a different version than the one running.

**Two corrections to earlier assumptions:**

- **`@firstpick/pi-extension-safety-guard` is probably not loading.** It is on disk only as an
  `optionalDependencies` entry of `@firstpick/pi-package-webui`, and is not itself in the `packages`
  list. Its regexes are still worth lifting; do not assume its behaviour is currently in effect.
- **`@gotgenes/pi-permission-system` is no longer installed** — the `@gotgenes/` directory is empty.
  The 1.5 MB review log is the record of a past run, not a live configuration.

---

## What this changes about the plan

Nothing in Tier 0 becomes free. Items 1, 2 and 3 remain ours — which is what
`packages/harness/extensions/guards` already covers — and item 4's egress half is still undecided.

What adoption genuinely buys: `cc-safety-net` for destructive-command analysis, the `rpiv`
ask/advisor pair for the escalation and second-opinion channels, `pi-lens` as the gate seam. What omp
buys is three leaf files totalling under 1,200 lines for items 4, 5 and 6.

The order the survey does not change: confinement first, recoverability next, classification last —
and the permission log is now the measurement behind that last clause rather than an argument for it.
