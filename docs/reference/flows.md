<!-- generated: scripts/docs/flow-diagrams.ts -->
# Generated flows

Every node below is read out of the source the flow runs through — the route table in `packages/web/src/server/index.ts` and the `EnsoObservation` union in `packages/core/src/observation.ts`. Nothing here is drawn by hand, so a route or a kind that moves changes this page or fails the docs gate.

## Control plane

The 9 control routes: what the browser can ask the runtime to do. Observation routes are the next diagram's first stage rather than a second copy of it.

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
  Browser -->|POST /api/threads/:threadId/fork| R_POST_api_threads_threadId_fork["respondToFork → forkThreadAt → AgentHost.forkThread"]
  R_POST_api_threads_threadId_fork --> H_respondToFork_forkThreadAt_AgentHost_forkThread["forkThreadAt()"]
  H_respondToFork_forkThreadAt_AgentHost_forkThread --> Runtime
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
| `respondToProjectRegistration → ProjectRegistry.register` | [`POST /api/projects`](./routes.md) | body: `EnsoProjectRegistration` — an absolute `path` strictly under a root the ENSO_HOME config declares (`projects.roots`), optional `title` | [`packages/web/src/server/index.ts:1086`](../../packages/web/src/server/index.ts#L1086) |
| `respondToProjectRemoval → ProjectRegistry.remove` | [`DELETE /api/projects/:projectId`](./routes.md) | path: `projectId` (sixteen hex digits) | [`packages/web/src/server/index.ts:85`](../../packages/web/src/server/index.ts#L85) |
| `respondToAbort → abortThread` | [`POST /api/threads/:threadId/abort`](./routes.md) | path: `threadId`; no body | [`packages/web/src/server/index.ts:75`](../../packages/web/src/server/index.ts#L75)<br>[`packages/web/src/server/follow.ts:717`](../../packages/web/src/server/follow.ts#L717) |
| `respondToHostCommand → runHostCommand` | [`POST /api/threads/:threadId/command`](./routes.md) | path: `threadId`; body: `EnsoHostCommandRun` — `model` with `provider/id`, `thinking` with a level, `login` with `provider/authType`, `logout` with a provider, `compact` with nothing; a `view` row (`context`, `fork`) is the page's to do, never run | [`packages/web/src/server/index.ts:79`](../../packages/web/src/server/index.ts#L79) |
| `respondToConfigure → configureThread` | [`POST /api/threads/:threadId/configure`](./routes.md) | path: `threadId`; body: `EnsoSessionConfiguration` — optional `model` (`provider/id`), `thinking` (a level that model supports) and `mode`; applied in that order under one lease, a value equal to the current one left alone | [`packages/web/src/server/index.ts:81`](../../packages/web/src/server/index.ts#L81) |
| `respondToDialog → answerThreadDialog` | [`POST /api/threads/:threadId/dialog`](./routes.md) | path: `threadId`; body: `DialogAnswer` | [`packages/web/src/server/index.ts:74`](../../packages/web/src/server/index.ts#L74)<br>[`packages/web/src/server/follow.ts:382`](../../packages/web/src/server/follow.ts#L382) |
| `respondToFork → forkThreadAt → AgentHost.forkThread` | [`POST /api/threads/:threadId/fork`](./routes.md) | path: `threadId`; body: `EnsoForkRequest` — `entryId`, the pi entry id of one of the thread's user messages; the fork is pi's `/fork` at position `before`, taken from the session file | [`packages/web/src/server/index.ts:83`](../../packages/web/src/server/index.ts#L83)<br>[`packages/web/src/server/follow.ts:689`](../../packages/web/src/server/follow.ts#L689) |
| `respondToModeChange → changeThreadMode` | [`POST /api/threads/:threadId/mode`](./routes.md) | path: `threadId`; body: `EnsoPermissionModeChange` | [`packages/web/src/server/index.ts:77`](../../packages/web/src/server/index.ts#L77)<br>[`packages/web/src/server/follow.ts:418`](../../packages/web/src/server/follow.ts#L418) |
| `respondToPrompt → promptThread` | [`POST /api/threads/:threadId/prompt`](./routes.md) | path: `threadId`; body: `EnsoPromptBody` | [`packages/web/src/server/index.ts:73`](../../packages/web/src/server/index.ts#L73)<br>[`packages/web/src/server/follow.ts:276`](../../packages/web/src/server/follow.ts#L276) |

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
| `mapPiEvent (22 kinds)` | [Observations](./observations.md) | [`packages/web/src/host/map-events.ts:283`](../../packages/web/src/host/map-events.ts#L283) |
| `EnsoObservation` | [Core exports](./core-exports.md) | [`packages/core/src/observation.ts:583`](../../packages/core/src/observation.ts#L583) |
| `observation frame` | [Observations](./observations.md) | [`packages/web/src/server/follow.ts:182`](../../packages/web/src/server/follow.ts#L182) |
| `follow connection` | [Routes](./routes.md) | [`packages/web/src/follow-connection.ts:465`](../../packages/web/src/follow-connection.ts#L465) |
| `to-agui chunk` | [Observations](./observations.md) | [`packages/web/src/to-agui.ts:76`](../../packages/web/src/to-agui.ts#L76) |
| `custom event router` | [Observations](./observations.md) | [`packages/web/src/custom-event-router.ts:209`](../../packages/web/src/custom-event-router.ts#L209) |

Kinds, in the union's order of declaration: `text-delta`, `thinking-delta`, `tool-call`, `tool-result`, `custom-entry`, `permission-mode`, `permission-mode-rejected`, `model`, `message-start`, `message-end`, `session-usage`, `turn-start`, `turn-end`, `provider-refused`, `provider-retry`, `provider-retry-ended`, `queue`, `prompt-rejected`, `extension-error`, `extension-ui-request`, `dialog-settled`, `run-ended`, `settled`, `unmapped`.
