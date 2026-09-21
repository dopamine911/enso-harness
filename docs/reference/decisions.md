<!-- generated: scripts/docs/decisions.ts -->
# Code-local decisions

**Decision headers: 168.**

This is an inventory of decisions recorded in leading source-file headers. It is not an index of every
issue mention: implementation comments, tests and fixture prose after the leading header are deliberately
outside the inventory. Each qualifying file appears exactly once, with every issue cited by that header.

| File | Issues | First complete decision sentence |
|---|---|---|
| `packages/core/src/__tests__/config.test.ts` | `#59` | The zen.config.json loading contract (#59): parse fails CLOSED — every non-conforming input comes back `unreadable`, never as a silently-empty config. |
| `packages/core/src/__tests__/log-process.test.ts` | `#132` | The file a user hands us (#132), end to end through the real configurator: what a line looks like, what never reaches it, what every line under a route carries — and the knob. |
| `packages/core/src/__tests__/log-recorder.ts` | `#132`, `#178` | The tests' sink (#132), one for every package (#178): every `zen` record, at every level, into memory — a guard's verdict, an audit line or a route's problem is asserted as the record it is, the way a bundle reader would read it, not as a line on stderr. |
| `packages/core/src/__tests__/no-duplicate-paths.test.ts` | `#59` | The anti-duplication anchor for path resolution (#59) — Daniel: "this should live in core and prevent duplicate code again." |
| `packages/core/src/__tests__/no-duplicate-shapes.test.ts` | `#255` | Anchors for the reason this package exists: one place for every shape, reachable by one search. |
| `packages/core/src/__tests__/observation-kinds.ts` | `#53` | The oracle both "every observation" sweeps compare against (#53 S1.4): every `kind` literal the ZenObservation union declares, sorted. |
| `packages/core/src/__tests__/secrets.test.ts` | `#89` | #89: secrets stay out of the environment the model's tools inherit. |
| `packages/core/src/__tests__/thread-inspection.test.ts` | `#86`, `#100` | The row formats are shared by the `?debug` drawer and `zen-thread.mjs` (PR #100 review: one definition, after the #86 pair had drifted). |
| `packages/core/src/config.ts` | `#59` | zen-harness's ONE committed config file (#59): `zen.config.json` at the repository root. |
| `packages/core/src/dialog.ts` | `#27`, `#112` | pi's blocking extension dialogs, as data (#27, #112). |
| `packages/core/src/follow.ts` | `#112` | The server↔browser wire (#112): a thread's feed, as the follow route serves it. |
| `packages/core/src/log-bundle.ts` | `#132` | The bundle (#132 item 5): ONE plaintext file a user attaches to an issue, built from things that already exist — the day's records, the live threads' inspections, the versions, and what the browser logged — with a manifest of what was redacted so the reader knows what is missing rather than wondering. |
| `packages/core/src/log-process.ts` | `#132` | A process's sink (#132 item 2): ONE log for the harness — `.zen/logs/zen-YYYY-MM-DD.jsonl`, every process appending to the same day's file, every record redacted by field name before it is written, and — for a terminal — a pretty console sink beside it at its own level. |
| `packages/core/src/log.ts` | `#132` | The harness's log record (#132): one shape for every process, so a bundle a user hands us reads the same whichever layer wrote the line. |
| `packages/core/src/paths.ts` | `#58`, `#59` | The workspace path helpers (#59) — THE one place that walks the filesystem for roots. |
| `packages/core/src/permission-mode.ts` | `#84`, `#162` | The permission mode's shape on the wire (#84; #162 workstream 4, L3): what a run starts in and what it may switch to. |
| `packages/core/src/secrets.ts` | `#7`, `#89`, `#98` | Secrets stay OUT of the environment the model's tools inherit (#89). |
| `packages/core/src/thread-inspection.ts` | `#86` | What a live thread's session ACTUALLY contains, as the server reports it (#86). |
| `packages/core/src/thread-runtime.ts` | `#69`, `#162`, `#165` | The thread runtime: the contract the host implements for one thread, and the shapes that cross it (`docs/glossary.md` → Thread, Control). |
| `packages/core/src/tool-result.ts` | `#16`, `#17`, `#18` | The tool-result payload contract (#18), as a TypeBox schema. |
| `packages/core/src/transcript.ts` | `#162` | The transcript (#162 workstream 4, leak L2's persistence side): a thread's branch, root to leaf, as entries of OURS. |
| `packages/core/src/web-fetch.ts` | `#9`, `#54`, `#59` | The web_fetch tool's shapes and policy constants (#54). |
| `packages/core/src/web-search.ts` | `#63` | The web_search tool's shapes and config section (#63). |
| `packages/harness/core/__tests__/environment-dump.test.ts` | `#89` | #89's depth layer: the bash environment-dump deny. |
| `packages/harness/core/__tests__/paths.test.ts` | `#53` | ⚠ FAIL CLOSED (#53 S3): no roots means nothing is inside — a misconfigured policy with an empty root list must deny, not allow, every write. |
| `packages/harness/core/__tests__/shell-fixtures.ts` | `#261`, `#289` | Shell-shaped literals the scanner tests write, in one place (#261, PR #289 review). |
| `packages/harness/core/__tests__/shell-secret-paths.test.ts` | `#204` | The bash/powershell secret-path deny (#204). |
| `packages/harness/core/__tests__/shell-segments.test.ts` | `#9`, `#89`, `#261` | The tokenizer's own contract (#261) — the parsing floor under the network deny (#9) and the environment-dump deny (#89), pinned directly instead of transitively. |
| `packages/harness/core/__tests__/web-fetch-policy.test.ts` | `#54`, `#55` | web_fetch's pure policy (#54). |
| `packages/harness/core/__tests__/web-search-model-providers.test.ts` | `#63` | The google and openai providers (#63) against synthetic wire fixtures. |
| `packages/harness/core/__tests__/web-search-support.test.ts` | `#63` | The web_search support layer (#63): source hygiene, citation appliers, auth, Tavily. |
| `packages/harness/core/__tests__/web-search-wire.test.ts` | `#63` | The Anthropic WIRE (#63) against synthetic SSE fixtures — the wire serves both the `anthropic` and `deepseek` providers, so these fixtures are the shared spine. |
| `packages/harness/core/deadline.ts` | `#58`, `#174` | Run work under a deadline AND the caller's abort signal, as one signal (#174; the shape `web_fetch` and `web_search` each carried). |
| `packages/harness/core/environment-dump.ts` | `#89`, `#206` | The bash environment-dump deny (#89) — DEPTH, not the fix. |
| `packages/harness/core/network-egress.ts` | `#9`, `#54`, `#55`, `#57`, `#206` | The bash network deny (#9) — a BAR, deliberately not a boundary. |
| `packages/harness/core/read-tracker.ts` | `#10`, `#11` | Session-scoped record of files whose content this session has seen (#10), and of the on-disk state they had when it saw them (#11). |
| `packages/harness/core/shell-secret-paths.ts` | `#9`, `#89`, `#204` | The bash/powershell secret-path deny (#204) — the read gate's own policy, on the shell route. |
| `packages/harness/core/shell-segments.ts` | `#9` | Conservative shell command segmenter — the parsing floor under the bash network deny (#9). |
| `packages/harness/core/tool-identity.ts` | `#4` | Canonical tool identity (#4, gap 2). |
| `packages/harness/core/web-fetch-policy.ts` | `#54`, `#55` | web_fetch's pure policy (#54) — every decision that needs no IO. |
| `packages/harness/core/web-search/anthropic-wire.ts` | `#63` | The Anthropic Messages WIRE — one streaming `/messages` call with the native `web_search` server tool, parsed into the outcome union. |
| `packages/harness/core/web-search/auth.ts` | `#63` | Model-routed auth (#63): resolve one model's credentials THROUGH PI's model registry — the same identity the conversation bills, including the OAuth path — with the provider-env fallback pi 0.80.1+ made necessary. |
| `packages/harness/core/web-search/citations.ts` | `#63` | Citation markers (#63): turn a provider's citation records into `[n]` markers inside the answer text plus the numbered source list those markers point at. |
| `packages/harness/core/web-search/dispatch.ts` | `#174` | How every provider sends its request (#174): a JSON POST, and the two ways it fails — the request never left (`requestDispatched: false`, so the extension may fall through to the next provider) or the API answered but not OK (`requestDispatched: true`, the body quoted). |
| `packages/harness/core/web-search/providers/anthropic.ts` | `#63` | The `anthropic` provider (#63): current-model routing onto the Anthropic Messages native `web_search` server tool ({@link ANTHROPIC_WEB_SEARCH_TOOL_TYPE}). |
| `packages/harness/core/web-search/providers/deepseek.ts` | `#63` | The `deepseek` provider (#63): the DEDICATED search backend, dsh's shape (`dsh-web-search-deepseek`, MIT — the spec this follows). |
| `packages/harness/core/web-search/providers/google.ts` | `#63` | The `google` provider (#63): Gemini "Grounding with Google Search" over the `streamGenerateContent` SSE endpoint. |
| `packages/harness/core/web-search/providers/openai.ts` | `#63` | The `openai` provider (#63): the Responses API `web_search` tool, serving three model APIs — `openai-responses`, `azure-openai-responses`, and `openai-codex-responses` (including GitHub Copilot credentials, whose resolved endpoint rides the credential object). |
| `packages/harness/core/web-search/providers/tavily.ts` | `#63` | The `tavily` provider (#63): the FALLBACK — a dedicated retrieval API, not a model. |
| `packages/harness/core/web-search/sources.ts` | `#63` | Source hygiene for provider results (#63): URL normalization, junk filtering, and order-preserving dedupe. |
| `packages/harness/core/web-search/sse.ts` | `#63` | A minimal SSE reader for the provider streams (#63). |
| `packages/harness/core/web-search/vocabulary.ts` | `#56`, `#63` | The web_search vocabulary (#63): provider ids, the outcome union, and the request shapes every provider module accepts. |
| `packages/harness/core/web-search/wire-json.ts` | `#63`, `#64` | Tiny helpers every provider wire shares (#63, PR #64 review): narrowing for unknown JSON wire payloads, and base-URL hygiene. |
| `packages/harness/extensions/__tests__/tool-call-participants.test.ts` | `#4`, `#20`, `#62` | THE #4 TRIPWIRE — the arbiter trigger, made structural. |
| `packages/harness/extensions/guards/__tests__/cc-safety-net-contract.test.ts` | `#4`, `#9`, `#238` | The cc-safety-net CONTRACT TEST (#9) — the condition #4's comments set for adopting a vendor as a library: exact pin + a fixed command set asserted verdict-by-verdict, so a vendor bump that shifts the boundary goes red here instead of silently moving it. |
| `packages/harness/extensions/guards/index.ts` | `#4`, `#9`, `#10`, `#20`, `#21`, `#69` | Tier 0 guards — see `docs/concepts/pi-immediate-needs.md`. |
| `packages/harness/extensions/logging/__tests__/logging.test.ts` | `#132` | The extension's two branches (#132): pi as a CHILD configures its own sink; pi IN-PROCESS leaves the server's alone. |
| `packages/harness/extensions/logging/index.ts` | `#132`, `#144`, `#167` | The extension process's logging (#132), and the one record only an extension can write: the provider's own request id (#144). |
| `packages/harness/extensions/web-fetch/__tests__/web-fetch.test.ts` | `#54` | The web_fetch extension (#54), against injected IO seams — no test here touches the network, DNS, or the committed config file (one shape-pin at the bottom reads the real `zen.config.json`, read-only). |
| `packages/harness/extensions/web-fetch/index.ts` | `#9`, `#54`, `#59` | The web_fetch tool (#54) — the sanctioned web access that replaces the ad-hoc network clients #9 denies in bash. |
| `packages/harness/extensions/web-search/__tests__/web-search.test.ts` | `#63` | The web_search extension (#63) against injected seams — the SELECTION and FALLBACK policy, and the ACCURATE rendering contract. |
| `packages/harness/extensions/web-search/index.ts` | `#54`, `#63`, `#89`, `#132` | The web_search tool (#63) — provider-native search with a Tavily fallback, consumed from pi-web-search 1.4.0 (© ttttmr, MIT) and retyped behind zen's seams. |
| `packages/web/e2e/chat.e2e.ts` | `#27`, `#71` | Manual web smoke (#71): drive the real chat surface and leave screenshots behind. |
| `packages/web/e2e/playwright.config.ts` | `#71` | Playwright config for the MANUAL web smoke (#71). |
| `packages/web/src/ZenToolResult.tsx` | `#18` | The web renderer for a zen tool result — the React half of #18's contract. |
| `packages/web/src/__tests__/browser-logging.test.ts` | `#132` | The page's logging (#132 slice 3): the ring the drawer reads, the shipper to the server, and the `?log=` knob — driven through a real `configure`, asserted at the sinks. |
| `packages/web/src/__tests__/chat-screen.test.tsx` | `#27`, `#49` | #49, first pass: the dialog components had live receipts (#27, the e2e smoke) and no unit render, so chat-screen.tsx sat at ~14% lines. |
| `packages/web/src/__tests__/custom-event-router.test.ts` | `#53`, `#90`, `#162` | #53 S1.3: the CUSTOM-chunk router was an inline closure no test reached — renaming a chunk, dropping the notify-type allowlist, or swapping the two `apply*` calls all left the suite green. |
| `packages/web/src/__tests__/dom-environment.ts` | `#118` | A browser DOM for the tests that MOUNT React (#118) — the mounted-pane tests, which need effects, `useSyncExternalStore` subscriptions and TanStack's `useChat` to actually run. |
| `packages/web/src/__tests__/fixture-conversation.test.ts` | `#27`, `#218` | The compatibility probe that used to live in a PR body (#218). |
| `packages/web/src/__tests__/follow-budget.test.ts` | `#272` | The page's follow budget (#272). |
| `packages/web/src/__tests__/follow-connection.test.ts` | `#112` | The adapter is the ONLY place AG-UI is made (#112). |
| `packages/web/src/__tests__/mode-lines.test.ts` | `#29`, `#90` | #29's remaining half: a mode change becomes a visible transcript line. |
| `packages/web/src/__tests__/notifications.test.tsx` | `#29`, `#90` | #29's browser half: notify messages become visible transcript lines. |
| `packages/web/src/__tests__/page-scoped-stores.test.ts` | `#103`, `#125` | The anchor for #125 item 3 / #103 invariant 2 (switching threads leaks no state): every store that holds a THREAD's state is created inside `createThreadStores` (thread-stores.ts), so a second thread on the page gets its own. |
| `packages/web/src/__tests__/permission-mode.test.tsx` | `#84`, `#90` | #84's browser half: the CURRENT permission mode as state, and the control that changes it. |
| `packages/web/src/__tests__/prompt-input.test.ts` | `#141` | ⚠ Upstream reported a refusal only when the WHOLE batch failed; a mixed drop lost files silently (PR #141 review). |
| `packages/web/src/__tests__/scripted-server.ts` | `#112`, `#118` | A scripted server behind `fetch` (#112, #118): one follow body the test writes SSE frames into, and unary routes the test scripts the answers of. |
| `packages/web/src/__tests__/stored-threads.test.ts` | `#103` | #103 receipt, step 8: the dev proxy answered a dead API with Bun's whole HTML error page, and quoting it filled the rail. |
| `packages/web/src/__tests__/thread-debug.test.tsx` | `#86` | #86: the drawer's one job is to NAME a disagreement between what the browser believes and what pi's session holds. |
| `packages/web/src/__tests__/thread-stats.test.tsx` | `#45`, `#90` | #45's browser half: `message-end` chunks become the stats the status bar renders (#90, thread-status.test.tsx). |
| `packages/web/src/__tests__/thread-status.test.tsx` | `#45`, `#90` | #90 PR 1: the always-on status bar. |
| `packages/web/src/__tests__/thread-url.test.ts` | `#142` | The URL is the source of truth for the active thread (#142): what it names, and what it cannot. |
| `packages/web/src/__tests__/threads-rail.test.tsx` | `#90` | #90 PR 3: the sessions rail and the page's thread list behind it. |
| `packages/web/src/browser-logging.ts` | `#86`, `#132` | The browser's logging (#132 slice 3). |
| `packages/web/src/custom-event-router.ts` | `#103` | The one chunk that is neither an observation nor a frame: the follow ended without this page leaving it (#103 receipt) — the server closed, restarted, or dropped the connection. |
| `packages/web/src/fixture-conversation.ts` | `#27`, `#31` | The styling dev loop (#31): a scripted conversation streamed through the REAL `useChat` pipeline as local AG-UI events — no server, no pi. |
| `packages/web/src/follow-connection.ts` | `#112`, `#272`, `#274` | The browser's connection to a thread (#112): TanStack's `SubscribeConnectionAdapter` over the prompt/follow split. |
| `packages/web/src/host/__tests__/agent-host.test.ts` | `#27`, `#69` | The in-process host against the REAL harness package (#69) — every extension the manifest names loads, and inline probe extensions observe what the host does. |
| `packages/web/src/host/__tests__/agent-loop-contract.test.ts` | `#130` | A CONTRACT TEST on the runtime's loop, the shape of `cc-safety-net-contract.test.ts`: the wire shape of a refused tool call is the vendor's doing — a guard's `{ block, reason }` becomes an error result with the reason as its content, `isError: true` — and `map-events.ts` relies on it (the `tool_execution_end` case, "isError is the only signal a refused call has"). |
| `packages/web/src/host/__tests__/event-tail.test.ts` | `#97` | #97's tail is a debugging surface: what it must not do is lie by omission. |
| `packages/web/src/host/__tests__/extension-ui-context.test.ts` | `#69` | The `ExtensionUIContext` the host binds (#69), driven directly: the blocking methods become `extension_ui_request` records and resolve on an answer, a cancel, an abort signal or a timeout; the fire-and-forget methods emit and return; the terminal-only surface is inert — pi's rpc mode's behaviour, which extensions already tolerate. |
| `packages/web/src/host/__tests__/permission-dialog.test.ts` | `#73` | The coupling to picc's `FilePermissionDialog` (#73), pinned against the REAL class: the lift reads TypeScript-private fields by name, so this is what fails — loudly — when a picc refactor renames one. |
| `packages/web/src/host/__tests__/permission-mode-adapter.test.ts` | `#95` | picc's own restore rule, applied to the raw branch, below the seam (L3 step A). |
| `packages/web/src/host/__tests__/session-events.test.ts` | `#69` | The replica of pi's unexported `toJsonEvent` (#69): what `map-events.ts` consumes must be byte-for-byte the rpc wire shape. |
| `packages/web/src/host/agent-host.ts` | `#27`, `#69`, `#89` | pi, hosted IN THIS PROCESS (#69) — the web server's replacement for spawning `pi --mode rpc` per prompt. |
| `packages/web/src/host/event-tail.ts` | `#69`, `#84`, `#86`, `#88`, `#97` | A thread's event tail (#97): the last N events through one funnel, with provenance. |
| `packages/web/src/host/map-events.ts` | `#24` | pi rpc events → the observations a surface renders (#24). |
| `packages/web/src/host/permission-dialog.ts` | `#27`, `#69`, `#73` | picc's permission prompt, lifted to a question the web surface can ask (#73). |
| `packages/web/src/host/permission-mode-adapter.ts` | `#84`, `#162` | picc-permission-modes' PERSISTED MODE, as the host reads it (#84; below the seam since #162 workstream 4, L3). |
| `packages/web/src/host/runtime-event.ts` | `#69`, `#162` | The runtime's event, as the host receives it — BELOW the thread-runtime seam since #162 workstream 4 (L2). |
| `packages/web/src/host/session-events.ts` | `#69` | `AgentSessionEvent` → the rpc WIRE shape (#69). |
| `packages/web/src/host/transcript.ts` | `#162` | The runtime's session branch → the transcript of ours (#162 workstream 4, L2's persistence side). |
| `packages/web/src/mode-lines.ts` | `#29`, `#69`, `#88`, `#162` | Permission-mode lines in the transcript (#29, the remaining half). |
| `packages/web/src/notifications.tsx` | `#29`, `#84`, `#94`, `#96` | pi's `notify` messages, rendered (#29). |
| `packages/web/src/permission-mode.tsx` | `#73`, `#84`, `#90` | The CURRENT permission mode, as state — and the control that changes it (#84). |
| `packages/web/src/server/__tests__/fake-hosted-thread.ts` | `#178` | The one fake of the thread-runtime seam (#178; `docs/seams/thread-runtime.md`): a `ThreadRuntime` from plain closures that records every call, so the server, the registry and the routes are driven over it and asserted through what it recorded. |
| `packages/web/src/server/__tests__/follow-reader.test.ts` | `#231` | The double's own contract (#231). |
| `packages/web/src/server/__tests__/follow-reader.ts` | `#231` | A follow as a test reads it: frames and keepalive comments as they arrive, awaited by count — never by a guessed delay. |
| `packages/web/src/server/__tests__/follow.test.ts` | `#109`, `#112` | The wire, measured (#109's receipt, kept as the contract — #112). |
| `packages/web/src/server/__tests__/logs-route.test.ts` | `#132` | `POST /api/logs` (#132 slice 3): the browser's batch into this process's logger, under the browser's own category, at its level, marked as the browser's — or a 4xx that is never a record of its own. |
| `packages/web/src/server/__tests__/observation-log.test.ts` | `#144` | The tier an observation lands at, and the one record that is not an observation at all: the run's time to first token (#144). |
| `packages/web/src/server/__tests__/run-timing.test.ts` | `#144` | Time to first token, once per run (#144). |
| `packages/web/src/server/__tests__/server-handler.test.ts` | `#76`, `#86`, `#95`, `#97` | The server's routes beside the wire, over real HTTP (#76, #86, #95, #97): what the inspection, history and session-listing routes report about threads the prompt route built. |
| `packages/web/src/server/__tests__/transcript-to-messages.test.ts` | `#95`, `#162` | #95: a stored branch mounts as the messages a live run would have left behind. |
| `packages/web/src/server/bundle-route.ts` | `#132`, `#137` | `GET /api/logs/bundle[?thread=<id or prefix>]` (#132 item 5): the day's records, the live threads' inspections, and the versions, as ONE markdown file with the records fenced as JSONL — `bun run logs --file` reads it back. |
| `packages/web/src/server/dev-web.ts` | `#9`, `#36` | Dev entry point for the web surface — Bun's fullstack dev server, replacing vite (#36). |
| `packages/web/src/server/dev.ts` | `#9`, `#132` | Dev entry point for the zen server. |
| `packages/web/src/server/follow.ts` | `#75`, `#109`, `#112`, `#116` | The prompt/follow split (#112) — the server↔browser wire. |
| `packages/web/src/server/logs-route.ts` | `#132` | `POST /api/logs` (#132 slice 3): the browser's records, into the one file. |
| `packages/web/src/server/observation-log.ts` | `#97`, `#132` | Every observation the server publishes becomes a record (#132, "trace everything") — at the tier it belongs to, with the ids that join it to the transcript, the event tail (#97) and the other layers' lines about the same moment. |
| `packages/web/src/server/run-timing.ts` | `#144` | When a run was admitted, so its FIRST delta can be recorded as a latency (#144 slice 1). |
| `packages/web/src/server/sse.ts` | `#109` | The SSE plumbing every streaming route shares: the response headers and the keepalive. |
| `packages/web/src/server/thread-registry.ts` | `#43`, `#69`, `#113`, `#116` | One pi session per chat THREAD, held across runs (#69 PR 2 — closes #43). |
| `packages/web/src/server/transcript-to-messages.ts` | `#93`, `#95`, `#162` | The transcript → TanStack `UIMessage`s (#95): the history a resumed thread mounts with. |
| `packages/web/src/store.ts` | `#90` | The smallest external store React can subscribe to: one value, replaced whole, and a listener set. |
| `packages/web/src/stored-threads.ts` | `#29`, `#86`, `#95` | The sessions a user can come back to (#95): pi's session files for this workspace, as the server lists them. |
| `packages/web/src/thread-stats.tsx` | `#44`, `#45`, `#90` | The thread-stats STORE (#45, phase 1): cost so far + the last request's prompt size. |
| `packages/web/src/thread-status.tsx` | `#45`, `#51`, `#84`, `#90`, `#103` | The status bar (#90 PR 1): the always-on line that says what this session is doing and what it has cost, so the answer to "is anything happening?" |
| `packages/web/src/thread-stores.ts` | `#90`, `#272` | Everything the browser knows about one thread beyond its messages (#90 PR 3). |
| `packages/web/src/thread-url.ts` | `#95`, `#142` | The thread a page URL names (#142): `?thread=<id>`. |
| `packages/web/src/threads-rail.tsx` | `#90`, `#95`, `#104` | The threads rail (#90 PR 3): which conversation am I in, what else is live on this page, how do I start over. |
| `packages/web/src/to-agui.ts` | `#18`, `#24`, `#112` | `ZenObservation` → AG-UI `StreamChunk` (#24, #112). |
| `scripts/__tests__/pi-version-parity.test.ts` | `#69`, `#217` | THE TWO PI RESOLUTIONS, HELD TOGETHER (#217). |
| `scripts/__tests__/zen-logs.test.ts` | `#132` | The reader's own logic (#132, `bun run logs`): the flags, and what a line must be to print. |
| `scripts/check-coverage.ts` | `#49`, `#118` | The TOTAL coverage floor — the gate that bunfig.toml cannot express. |
| `scripts/docs/core-exports.ts` | `#170` | Generates `docs/reference/core-exports.md` (#170): the public core barrel and the node-only logging subpath, with their defining declarations and production importers. |
| `scripts/docs/decisions.ts` | `#170` | Generates `docs/reference/decisions.md` (#170): one row for each owned source file whose first comment/header block cites an issue. |
| `scripts/docs/env-and-config.ts` | `#170` | Generates `docs/reference/env-and-config.md` (#170): the explicit environment boundary, the composed `ZenConfig` shape, every `.zen/` path assembled by core, and the harness manifest resources. |
| `scripts/docs/extract-declaration.ts` | `#168` | The docs gate's one primitive (#168): a top-level declaration, verbatim, by name. |
| `scripts/docs/gate-source.ts` | `#170`, `#262` | Reading a declared constant back out of a gate's source (#170, split out on #262). |
| `scripts/docs/generator-support.ts` | `#174` | What every generator under `scripts/docs/` shares (#174): the exhaustiveness check that makes a metadata table refuse to be stale, and the one way a generator runs — its page to stdout, or one `name: reason` line to stderr and a non-zero exit, never a partial page. |
| `scripts/docs/ported-provenance.ts` | `#168` | Generates `docs/seams/ported-provenance.md` (#168): one row per file under `components/ai-elements/` — the upstream path and commit its header names, and the `Modified —` line that follows. |
| `scripts/docs/refresh-fences.ts` | `#162`, `#168` | Refreshes every sourced fence in a page from the source it names (#168): the authoring and repair tool for `test/docs-gate.test.ts`. |
| `scripts/docs/seams-table.ts` | `#162`, `#167` | Generates the seams table (#162 workstream 11, #167 item 4) — the block `docs/architecture.md` and `docs/seams/README.md` embed between `<!-- generated-block: … -->` markers. |
| `scripts/docs/verification-inventory.ts` | `#170`, `#262` | Generates `docs/reference/verification-inventory.md` (#170): enforcement gates, the numeric and count ratchets they carry, and the deliberately reusable test doubles. |
| `scripts/link-vendor-packages.mjs` | `#30` | Ensure the vendor pi packages exist inside the harness package's own node_modules. |
| `scripts/print-harness.mjs` | `#9`, `#13`, `#20` | The PRINT-MODE harness variant (#20): the zen-harness package minus picc-permission-modes. |
| `scripts/source-tree.ts` | `#162`, `#174` | The one walk over the source tree (#174, #162 workstream 6: one walker per gate family). |
| `scripts/zen-logs.ts` | `#132` | See the log (#132): the day's file, rendered the way the terminal renders it live. |
| `scripts/zen-thread.mjs` | `#86`, `#97` | Inspect the live web server's threads from a shell — the agent's half of #86. |
| `scripts/zen.mjs` | `#20`, `#217` | Launch a VANILLA pi with only zen-harness loaded. |
| `test/browser-bundle-gate.test.ts` | `#211` | The browser zone must bundle for the browser (#211). |
| `test/check-coverage.test.ts` | `#53` | The coverage GATE's own arithmetic (#53 S2). |
| `test/code-offenders.test.ts` | `#162` | The allowlist is the leak inventory (#162 workstream 4): a row hides a file's matches, and a row for a file with no matches is drift and is reported. |
| `test/dependency-gate.test.ts` | `#218`, `#223` | What the dependency manifests claim, held against what the code actually imports (#218, #223). |
| `test/docs-gate.test.ts` | `#162`, `#167`, `#168` | The docs cannot drift (#168, goals §3.3): a page either quotes source and is checked against it, or is generated from source and is diffed against it. |
| `test/duplicate-shapes-gate.test.ts` | `#53`, `#174`, `#255` | One place for every shape: no TypeBox schema is declared outside `@zen/core` (#53, #255). |
| `test/fallow-config.test.ts` | `#163` | fallow's entry list cannot drift from the harness manifest (#163). |
| `test/gate-abort.test.ts` | `#157` | The gate's blind spot, closed (#157): a tool that dies mid-run and still exits 0. |
| `test/gate-support.ts` | `#150`, `#162`, `#165`, `#174` | What the source-tree gates share (#165, #162 workstream 6): the word-splitter, the sequence matcher, the comment skip, over the one walker (`scripts/source-tree.ts`, #174). |
| `test/glossary-doc.test.ts` | `#161`, `#164`, `#165` | The glossary keeps its own two rules (#161, PR #164 review). |
| `test/glossary-gate.test.ts` | `#165`, `#241`, `#287` | The glossary's Retired table, applied to the source tree (#165, `docs/glossary.md` → Retired). |
| `test/logging-gate.test.ts` | `#132`, `#162`, `#254` | Every record goes through the one logger (#132), and the substrate stays behind it. |
| `test/naming-gate.test.ts` | `#82`, `#83`, `#250` | The naming gate's exemption for externally-fixed KEYS (#82, PR #83 review), and the severity that decides whether a tier blocks (#250) or merely mentions. |
| `test/no-lint-suppressions.test.ts` | `#82` | The gate may not be talked out of, one line at a time. |
| `test/presentation-gate.test.ts` | `#31`, `#121`, `#174`, `#253` | Presentation stays presentation (#121 item 4, #31). |
| `test/vendor-gate.test.ts` | `#69`, `#145`, `#150`, `#165`, `#173`, `#215` | The seam has an owner: only the host and the pi extensions may name the vendor (#145). |

**Parser limit.** The parser considers the first block or contiguous line comment beginning within the
first 80 lines of TypeScript/JavaScript source under `packages/`, `scripts/`,
and `test/`.
It skips generated type output, dependencies, coverage output, and vendored web components. Sentence
reduction uses the first `.`, `!`, or `?`, optionally followed by closing quotes/brackets and then
whitespace or the end of the header; a qualifying header that does not fit that current source shape
is emitted as `UNCLASSIFIED` and makes generation fail.
