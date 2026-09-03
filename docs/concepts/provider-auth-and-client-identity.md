# Provider auth and client identity

**Written** 2026-09-03 by Claude (Opus 5) at Daniel's request, for the zen-harness project.

Why zen-harness treats provider authentication as a first-class design surface, and what the
alternative looks like in practice. Grounded in the source of two harnesses read on this machine on
2026-09-03:

| Package | Version | Read at |
|---|---|---|
| `@earendil-works/pi-coding-agent` (pi) | 0.84.4 | `~/.nvm/versions/node/v24.12.0/lib/node_modules/` |
| `@oh-my-pi/pi-ai` (omp's AI layer) | 17.2.14 | `~/.bun/install/global/node_modules/` |

Both are MIT-licensed and public. Line citations below are to the installed source at those versions;
they will drift as the packages move.

Companion to [`pi-immediate-needs.md`](./pi-immediate-needs.md), which covers what pi lacks on the
safety axis. This covers what it lacks on the auth axis, and what a fork did about it.

---

## The problem this document exists to record

zen-harness is a multi-provider harness. The provider it will be used with most is Anthropic, and
Anthropic's consumer plans (Pro/Max) are not the same product as the API. The plan is sold for use
through Anthropic's own clients; the API is sold per token. A third-party harness that wants to run on
the model has one honest route — API billing — and the plan is not it.

That gap is the whole subject. Every design decision below follows from choosing which side of it to
stand on.

## What pi does

pi ships an Anthropic OAuth provider and identifies itself as pi.

- OAuth client id, authorize endpoint, and scopes: `@earendil-works/pi-ai/dist/auth/oauth/anthropic.js:13-14`.
  The client id is the one Claude Code uses, stored base64-obfuscated. The scope set includes
  `user:inference` and `user:sessions:claude_code`.
- Token endpoint: `platform.claude.com/v1/oauth/token`.
- Inference requests carry the bundled Anthropic SDK's own `X-Stainless-*` headers with that SDK's real
  values. There is no `claude-cli` user agent anywhere in pi's bundle — checked by grep across `dist/`
  and its vendored `pi-ai`.
- When subscription auth is active, pi prints a warning that third-party harness usage draws from extra
  usage and is billed per token rather than against plan limits. `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING`
  silences the warning; it does not change the billing.

So pi borrows the client id but presents itself honestly at the transport layer, and tells the user what
the billing consequence is. Whether that is a coherent position is arguable — the client id is not pi's
to use — but it stops well short of the next section.

**Credential storage.** A flat `auth.json` under the agent directory, four fields per provider:
`{access, refresh, expires, type}`. No account identity, no grant anchor, no failure record. This has
practical consequences covered under [Observability](#observability-what-pi-cannot-tell-you).

## What omp does

omp's Anthropic subscription path reproduces the identity of Anthropic's first-party client at four
layers. This is a description of the shape, not a build guide; the constants are in the cited files.

**1. OAuth identity.** `src/registry/oauth/anthropic.ts:13-25` — the same Claude Code client id as pi,
the `claude.ai` authorize endpoint, the same scope set, but the token endpoint is
`api.anthropic.com/v1/oauth/token` (line 15). Login additionally calls
`api.anthropic.com/api/claude_cli/bootstrap` (line 16) with `entrypoint=cli`, a pinned model, and a
`claude-code/<version>` user agent (lines 17-18, 142-149).

**2. Transport headers.** `src/providers/anthropic.ts:307-326` — on the OAuth path, requests carry
`claude-cli/<version> (external, claude-desktop)` as user agent, `x-app: cli`,
`anthropic-dangerous-direct-browser-access`, an `X-Claude-Code-Session-Id`, a per-request
`x-client-request-id`, and eight `X-Stainless-*` headers hardcoded at `:528-537` to the values the
first-party client's build emits — including a runtime version that is not the Node version omp runs on
and a package version that is not the SDK omp bundles. If a caller supplies a user agent that already
starts with `claude-cli`, that one is preserved instead (`:217-220`, `:308`). An `enforcedHeaderKeys`
set at `:539-556` strips a caller's own user agent and auth headers so the fingerprint cannot be
displaced by accident.

**3. A system-block billing header.** `:565-578` — the first system block is not part of the user's
prompt at all. It is a synthetic `x-anthropic-billing-header:` line carrying a client version, an
entrypoint, and a short fingerprint derived by hashing a hardcoded salt together with selected
characters of the first user message and the pinned client version. A comment states it matches the
first-party client's own fingerprint routine. The second system block is a hardcoded identity line
asserting the agent is built on Anthropic's Agent SDK (`src/providers/claude-code-fingerprint.ts:18`,
injected at `:2876`), and the cache-breakpoint logic at `:2857-2861` knows to skip both synthetic
blocks when deciding what is cacheable.

**4. A body attestation.** `:580-583` and the `fetch` wrapper that follows — the billing header ships
with a placeholder `cch` value, which is replaced before the request goes on the wire by a seeded hash
of the serialized request body, truncated to a few hex characters. The seed is a hardcoded 64-bit
constant.

Layer 4 is the one that matters for classification. Layers 1-3 are impersonation: claiming an identity.
Layer 4 is attestation defeat: the value exists so the server can verify a request was produced by the
genuine client, and reproducing it requires having recovered the algorithm and its constants by reverse
engineering. There is no reading of layer 4 on which it is anything other than deliberate circumvention
of an integrity control.

**Credential storage.** SQLite at `~/.omp/agent/agent.db`, table `auth_credentials`, via
`SqliteAuthCredentialStore`. Eight columns; the credential blob carries `accountId`, `email`, `orgId`,
`orgName`, and `authorizedAt` alongside the tokens, and a separate `disabled_cause` column holds the
text of the failure that retired a credential. This part is straightforwardly better than pi's and is
the part worth copying.

## Why zen-harness will not do this

Not primarily an ethics argument — though the ethics are not close, and obtaining a paid entitlement by
defeating the check that gates it is the plain description of layers 3 and 4. Three engineering reasons
stand on their own:

**It is pinned to a moving target in four places at once.** A client version string, an SDK version
string, a runtime version string, a salt, a seed, a set of character offsets, a header set, and two
synthetic system blocks. Every one of them is a copy of something Anthropic controls and ships on its own
schedule. When any single one moves, this path breaks.

**Its failure mode is invisible.** None of those pins is version-checked, because there is nothing to
check them against. A drifted constant does not produce a version-mismatch error; it produces
authentication or inference failures at some later point, in a code path far from the header block that
caused them. That is the same shape as the 12-day scan-worker outage on 715-109: both halves of a
contract green, contradictory shapes, nothing raised. It is the failure class this project exists to
design against.

**The account risk lands on the operator, not the author.** Circumventing a billing-integrity control is
the category of term violation that ends accounts rather than generating a warning, and it would be
Daniel's work account, with 715-109's AWS and ThingsBoard work sitting behind the same identity.

There is a fourth reason specific to this project: zen-harness is a **multi-provider** harness. An auth
layer whose Anthropic path is a bundle of pinned impersonation constants is not a provider abstraction —
it is a special case that leaks its shape into everything above it. The design goal is one credential
model that holds for Anthropic, OpenAI-compatible endpoints, a local llama.cpp server, and whatever
comes next. Forgery does not generalize.

## What zen-harness does instead

**Auth is provider-neutral and honest about identity.** One credential model, one storage layer, no
per-provider identity forgery. zen-harness identifies as zen-harness.

**Credential storage follows omp's shape, not pi's.** The record carries the account identity, the grant
anchor, and the reason a credential was retired — see [Observability](#observability-what-pi-cannot-tell-you).

**Secrets do not live in config files.** `~/.pi/agent/models.json` stores provider API keys in plaintext
beside non-secret model configuration, which is how one got printed into a transcript on 2026-09-03. Keys
come from the OS keyring or the environment; config files hold references, never values.

**The provider set is the answer to cost, not the billing path.** For Anthropic specifically that means
API billing when Anthropic is required. For everything else it means the harness is genuinely
multi-provider: OpenAI-compatible endpoints, a self-hosted llama.cpp or ollama server at zero marginal
cost for loop-wiring and smoke work, and whatever else is authenticated. Most of zen-harness — the guard
extension, `@zen/core`, persistence, the tool-result renderers, and every read-only pane over existing
transcripts — needs no inference at all, so provider cost gates a much smaller slice of the build than it
first appears to.

**If plan-rate access from a custom harness is a requirement, it is a conversation with Anthropic.** That
is a real option and it is not this one.

## Observability: what pi cannot tell you

Independent of the identity question, omp's credential record is better instrumented, and the gap has a
concrete cost. Two fields:

**`authorizedAt`.** An Anthropic OAuth grant family has an absolute lifetime anchored at the interactive
login — refresh rotation does not extend it. omp records the constant and its evidence in
`src/registry/oauth/anthropic-constants.ts`: roughly 30 days, observed against production, with grants
dying to the hour despite healthy 8-hour rotations. Because omp stores the anchor, it can warn before the
deadline. pi stores only `expires` for the current access token, so it cannot compute the deadline at all
and simply dies with a bare `invalid_grant: "Refresh token expired"` when it arrives.

**`disabled_cause`.** omp writes the failure text onto the credential row and marks it disabled. Observed
on this machine: a work-account row carrying the full `invalid_grant` response from 2026-08-11, still
readable three weeks later, which is what identified the cause immediately. pi's equivalent failure
produced a session that exited 0 with no output.

Both are zen-harness requirements. A session that cannot authenticate must exit non-zero and say why, and
a credential that has been retired must carry the reason it was retired. Neither has anything to do with
which billing path a harness takes — they are just the difference between a diagnosable failure and an
afternoon of guessing.

---

## Provenance

Everything above was read from installed source on 2026-09-03, not from documentation or recollection.
Line numbers are for `@oh-my-pi/pi-ai` 17.2.14 and `@earendil-works/pi-coding-agent` 0.84.4 and will
drift. The ~30-day grant lifetime is omp's own recorded observation, corroborated here by two
independently expired grants (2026-07-23 and 2026-07-29 in pi's store, 2026-08-10 in omp's) — it is a
display heuristic in omp's words, not a documented wire contract.

The attestation constants in layers 3 and 4 are deliberately not reproduced here. The file and line
citations are complete, the source is MIT-licensed and on disk, and an auditor needs to know the
mechanism exists and what it is pinned to — not the values, which are the circumvention itself.
