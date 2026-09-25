<!-- generated: scripts/docs/flow-diagrams.ts -->
# Generated flows

Every node below is read out of the source the flow runs through — the route table in `packages/web/src/server/index.ts` and the `EnsoObservation` union in `packages/core/src/observation.ts`. Nothing here is drawn by hand, so a route or a kind that moves changes this page or fails the docs gate.

## Control plane

The 5 control routes: what the browser can ask the runtime to do. Observation routes are the next diagram's first stage rather than a second copy of it.

```mermaid
flowchart LR
  Browser["Browser"]
  Browser -->|POST /api/threads/:threadId/abort| R_POST_api_threads_threadId_abort["respondToAbort → abortThread"]
  R_POST_api_threads_threadId_abort --> H_respondToAbort_abortThread["abortThread()"]
  H_respondToAbort_abortThread --> Runtime
  Browser -->|POST /api/threads/:threadId/command| R_POST_api_threads_threadId_command["respondToHostCommand → runHostCommand"]
  Browser -->|POST /api/threads/:threadId/dialog| R_POST_api_threads_threadId_dialog["respondToDialog → answerThreadDialog"]
  R_POST_api_threads_threadId_dialog --> H_respondToDialog_answerThreadDialog["answerThreadDialog()"]
  H_respondToDialog_answerThreadDialog --> Runtime
  Browser -->|POST /api/threads/:threadId/mode| R_POST_api_threads_threadId_mode["respondToModeChange → changeThreadMode"]
  R_POST_api_threads_threadId_mode --> H_respondToModeChange_changeThreadMode["changeThreadMode()"]
  H_respondToModeChange_changeThreadMode --> Runtime
  Browser -->|POST /api/threads/:threadId/prompt| R_POST_api_threads_threadId_prompt["respondToPrompt → promptThread"]
  R_POST_api_threads_threadId_prompt --> H_respondToPrompt_promptThread["promptThread()"]
  H_respondToPrompt_promptThread --> Runtime
  Runtime["ThreadRuntime"] --> Observations["EnsoObservation stream"]
```

| Node | Contract | Input | Source |
|---|---|---|---|
| `respondToAbort → abortThread` | [`POST /api/threads/:threadId/abort`](./routes.md) | path: `threadId`; no body | [`packages/web/src/server/index.ts:64`](../../packages/web/src/server/index.ts#L64)<br>[`packages/web/src/server/follow.ts:563`](../../packages/web/src/server/follow.ts#L563) |
| `respondToHostCommand → runHostCommand` | [`POST /api/threads/:threadId/command`](./routes.md) | path: `threadId`; body: `EnsoHostCommandRun` — `model` with `provider/id`, `thinking` with a level, `login` with `provider/authType`, `logout` with a provider, `compact` with nothing; a `view` row (`context`) is the page's to open, never run | [`packages/web/src/server/index.ts:68`](../../packages/web/src/server/index.ts#L68) |
| `respondToDialog → answerThreadDialog` | [`POST /api/threads/:threadId/dialog`](./routes.md) | path: `threadId`; body: `DialogAnswer` | [`packages/web/src/server/index.ts:63`](../../packages/web/src/server/index.ts#L63)<br>[`packages/web/src/server/follow.ts:363`](../../packages/web/src/server/follow.ts#L363) |
| `respondToModeChange → changeThreadMode` | [`POST /api/threads/:threadId/mode`](./routes.md) | path: `threadId`; body: `EnsoPermissionModeChange` | [`packages/web/src/server/index.ts:66`](../../packages/web/src/server/index.ts#L66)<br>[`packages/web/src/server/follow.ts:399`](../../packages/web/src/server/follow.ts#L399) |
| `respondToPrompt → promptThread` | [`POST /api/threads/:threadId/prompt`](./routes.md) | path: `threadId`; body: `EnsoPromptBody` | [`packages/web/src/server/index.ts:62`](../../packages/web/src/server/index.ts#L62)<br>[`packages/web/src/server/follow.ts:265`](../../packages/web/src/server/follow.ts#L265) |

## Observation pipeline

One pi event becomes one observation and crosses six stages to reach the browser store. The union declares 24 kinds; the mapper produces 22 of them, and the rest are produced by the prompt route (see [Observations](./observations.md) for the per-kind producer, carrier and consumer).

```mermaid
flowchart LR
  Pi["pi runtime event"]
  Pi --> Mapper["mapPiEvent (22 kinds)"]
  Mapper --> Schema["EnsoObservation"]
  Schema --> Frame["observation frame"]
  Frame --> Connection["follow connection"]
  Connection --> Adapter["to-agui chunk"]
  Adapter --> Router["custom event router"]
  Router --> Store["browser store"]
```

| Stage | Contract | Source |
|---|---|---|
| `mapPiEvent (22 kinds)` | [Observations](./observations.md) | [`packages/web/src/host/map-events.ts:270`](../../packages/web/src/host/map-events.ts#L270) |
| `EnsoObservation` | [Core exports](./core-exports.md) | [`packages/core/src/observation.ts:567`](../../packages/core/src/observation.ts#L567) |
| `observation frame` | [Observations](./observations.md) | [`packages/web/src/server/follow.ts:179`](../../packages/web/src/server/follow.ts#L179) |
| `follow connection` | [Routes](./routes.md) | [`packages/web/src/follow-connection.ts:427`](../../packages/web/src/follow-connection.ts#L427) |
| `to-agui chunk` | [Observations](./observations.md) | [`packages/web/src/to-agui.ts:76`](../../packages/web/src/to-agui.ts#L76) |
| `custom event router` | [Observations](./observations.md) | [`packages/web/src/custom-event-router.ts:176`](../../packages/web/src/custom-event-router.ts#L176) |

Kinds, in the union's order of declaration: `text-delta`, `thinking-delta`, `tool-call`, `tool-result`, `custom-entry`, `permission-mode`, `permission-mode-rejected`, `model`, `message-start`, `message-end`, `session-usage`, `turn-start`, `turn-end`, `provider-refused`, `provider-retry`, `provider-retry-ended`, `queue`, `prompt-rejected`, `extension-error`, `extension-ui-request`, `dialog-settled`, `run-ended`, `settled`, `unmapped`.
