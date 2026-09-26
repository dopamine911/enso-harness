<!-- generated: scripts/docs/flow-diagrams.ts -->
# Generated flows

Every node below is read out of the source the flow runs through — the route table in `packages/web/src/server/index.ts` and the `EnsoObservation` union in `packages/core/src/observation.ts`. Nothing here is drawn by hand, so a route or a kind that moves changes this page or fails the docs gate.

## Control plane

The 8 control routes: what the browser can ask the runtime to do. Observation routes are the next diagram's first stage rather than a second copy of it.

```mermaid
flowchart LR
  Browser["Browser"]
  Browser -->|POST /api/projects| R_POST_api_projects["respondToProjectRegistration → ProjectRegistry.register"]
  Browser -->|DELETE /api/projects/:projectId| R_DELETE_api_projects_projectId["respondToProjectRemoval → ProjectRegistry.remove"]
  Browser -->|POST /api/threads/:threadId/abort| R_POST_api_threads_threadId_abort["respondToAbort → abortThread"]
  R_POST_api_threads_threadId_abort --> H_respondToAbort_abortThread["abortThread()"]
  H_respondToAbort_abortThread --> Runtime
  Browser -->|POST /api/threads/:threadId/command| R_POST_api_threads_threadId_command["respondToHostCommand → runHostCommand"]
  Browser -->|POST /api/threads/:threadId/configure| R_POST_api_threads_threadId_configure["respondToConfigure → configureThread"]
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
| `respondToProjectRegistration → ProjectRegistry.register` | [`POST /api/projects`](./routes.md) | body: `EnsoProjectRegistration` — an absolute `path` strictly under a root `enso.config.json` declares (`projects.roots`), optional `title` | [`packages/web/src/server/index.ts:1046`](../../packages/web/src/server/index.ts#L1046) |
| `respondToProjectRemoval → ProjectRegistry.remove` | [`DELETE /api/projects/:projectId`](./routes.md) | path: `projectId` (sixteen hex digits) | [`packages/web/src/server/index.ts:79`](../../packages/web/src/server/index.ts#L79) |
| `respondToAbort → abortThread` | [`POST /api/threads/:threadId/abort`](./routes.md) | path: `threadId`; no body | [`packages/web/src/server/index.ts:71`](../../packages/web/src/server/index.ts#L71)<br>[`packages/web/src/server/follow.ts:668`](../../packages/web/src/server/follow.ts#L668) |
| `respondToHostCommand → runHostCommand` | [`POST /api/threads/:threadId/command`](./routes.md) | path: `threadId`; body: `EnsoHostCommandRun` — `model` with `provider/id`, `thinking` with a level, `login` with `provider/authType`, `logout` with a provider, `compact` with nothing; a `view` row (`context`) is the page's to open, never run | [`packages/web/src/server/index.ts:75`](../../packages/web/src/server/index.ts#L75) |
| `respondToConfigure → configureThread` | [`POST /api/threads/:threadId/configure`](./routes.md) | path: `threadId`; body: `EnsoSessionConfiguration` — optional `model` (`provider/id`), `thinking` (a level that model supports) and `mode`; applied in that order under one lease, a value equal to the current one left alone | [`packages/web/src/server/index.ts:77`](../../packages/web/src/server/index.ts#L77) |
| `respondToDialog → answerThreadDialog` | [`POST /api/threads/:threadId/dialog`](./routes.md) | path: `threadId`; body: `DialogAnswer` | [`packages/web/src/server/index.ts:70`](../../packages/web/src/server/index.ts#L70)<br>[`packages/web/src/server/follow.ts:363`](../../packages/web/src/server/follow.ts#L363) |
| `respondToModeChange → changeThreadMode` | [`POST /api/threads/:threadId/mode`](./routes.md) | path: `threadId`; body: `EnsoPermissionModeChange` | [`packages/web/src/server/index.ts:73`](../../packages/web/src/server/index.ts#L73)<br>[`packages/web/src/server/follow.ts:399`](../../packages/web/src/server/follow.ts#L399) |
| `respondToPrompt → promptThread` | [`POST /api/threads/:threadId/prompt`](./routes.md) | path: `threadId`; body: `EnsoPromptBody` | [`packages/web/src/server/index.ts:69`](../../packages/web/src/server/index.ts#L69)<br>[`packages/web/src/server/follow.ts:265`](../../packages/web/src/server/follow.ts#L265) |

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
| `mapPiEvent (22 kinds)` | [Observations](./observations.md) | [`packages/web/src/host/map-events.ts:280`](../../packages/web/src/host/map-events.ts#L280) |
| `EnsoObservation` | [Core exports](./core-exports.md) | [`packages/core/src/observation.ts:567`](../../packages/core/src/observation.ts#L567) |
| `observation frame` | [Observations](./observations.md) | [`packages/web/src/server/follow.ts:179`](../../packages/web/src/server/follow.ts#L179) |
| `follow connection` | [Routes](./routes.md) | [`packages/web/src/follow-connection.ts:449`](../../packages/web/src/follow-connection.ts#L449) |
| `to-agui chunk` | [Observations](./observations.md) | [`packages/web/src/to-agui.ts:76`](../../packages/web/src/to-agui.ts#L76) |
| `custom event router` | [Observations](./observations.md) | [`packages/web/src/custom-event-router.ts:176`](../../packages/web/src/custom-event-router.ts#L176) |

Kinds, in the union's order of declaration: `text-delta`, `thinking-delta`, `tool-call`, `tool-result`, `custom-entry`, `permission-mode`, `permission-mode-rejected`, `model`, `message-start`, `message-end`, `session-usage`, `turn-start`, `turn-end`, `provider-refused`, `provider-retry`, `provider-retry-ended`, `queue`, `prompt-rejected`, `extension-error`, `extension-ui-request`, `dialog-settled`, `run-ended`, `settled`, `unmapped`.
