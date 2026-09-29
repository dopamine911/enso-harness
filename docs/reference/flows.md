<!-- generated: scripts/docs/flow-diagrams.ts -->
# Generated flows

Every node below is read out of the source the flow runs through — the route table in `packages/web/src/server/index.ts` and the `EnsoObservation` union in `packages/core/src/observation.ts`. Nothing here is drawn by hand, so a route or a kind that moves changes this page or fails the docs gate.

## Control plane

The 12 control routes: what the browser can ask the runtime to do. Observation routes are the next diagram's first stage rather than a second copy of it.

```mermaid
flowchart LR
  Browser["Browser"]
  Browser -->|POST /api/projects| R_POST_api_projects["respondToProjectRegistration → ProjectRegistry.register"]
  Browser -->|DELETE /api/projects/:projectId| R_DELETE_api_projects_projectId["respondToProjectRemoval → ProjectRegistry.remove"]
  Browser -->|DELETE /api/prompts/:id| R_DELETE_api_prompts_id["respondToPromptRemoval → PromptLibrary.remove"]
  Browser -->|PUT /api/prompts/:id| R_PUT_api_prompts_id["respondToPromptWrite → PromptLibrary.write"]
  Browser -->|POST /api/threads/:threadId/abort| R_POST_api_threads_threadId_abort["respondToAbort → abortThread"]
  R_POST_api_threads_threadId_abort --> H_respondToAbort_abortThread["abortThread()"]
  H_respondToAbort_abortThread --> Runtime
  Browser -->|POST /api/threads/:threadId/command| R_POST_api_threads_threadId_command["respondToHostCommand → runHostCommand"]
  Browser -->|POST /api/threads/:threadId/configure| R_POST_api_threads_threadId_configure["respondToConfigure → configureThread"]
  Browser -->|POST /api/threads/:threadId/continue| R_POST_api_threads_threadId_continue["respondToContinue → continueThread → ThreadRuntime.continueRun"]
  R_POST_api_threads_threadId_continue --> H_respondToContinue_continueThread_ThreadRuntime_continueRun["continueThread()"]
  H_respondToContinue_continueThread_ThreadRuntime_continueRun --> Runtime
  Browser -->|POST /api/threads/:threadId/dialog| R_POST_api_threads_threadId_dialog["respondToDialog → answerThreadDialog"]
  R_POST_api_threads_threadId_dialog --> H_respondToDialog_answerThreadDialog["answerThreadDialog()"]
  H_respondToDialog_answerThreadDialog --> Runtime
  Browser -->|POST /api/threads/:threadId/fork| R_POST_api_threads_threadId_fork["respondToFork → forkThreadAt → AgentHost.forkThread"]
  R_POST_api_threads_threadId_fork --> H_respondToFork_forkThreadAt_AgentHost_forkThread["forkThreadAt()"]
  H_respondToFork_forkThreadAt_AgentHost_forkThread --> Storage
  Browser -->|POST /api/threads/:threadId/mode| R_POST_api_threads_threadId_mode["respondToModeChange → changeThreadMode"]
  R_POST_api_threads_threadId_mode --> H_respondToModeChange_changeThreadMode["changeThreadMode()"]
  H_respondToModeChange_changeThreadMode --> Runtime
  Browser -->|POST /api/threads/:threadId/prompt| R_POST_api_threads_threadId_prompt["respondToPrompt → promptThread"]
  R_POST_api_threads_threadId_prompt --> H_respondToPrompt_promptThread["promptThread()"]
  H_respondToPrompt_promptThread --> Runtime
  Storage["AgentHost (storage)"]
  Runtime["ThreadRuntime"] --> Observations["EnsoObservation stream"]
```

| Node | Contract | Input | Source |
|---|---|---|---|
| `respondToProjectRegistration → ProjectRegistry.register` | [`POST /api/projects`](./routes.md) | body: `EnsoProjectRegistration` — an absolute `path` strictly under a root the ENSO_HOME config declares (`projects.roots`), optional `title` | [`packages/web/src/server/index.ts:1206`](../../packages/web/src/server/index.ts#L1206) |
| `respondToProjectRemoval → ProjectRegistry.remove` | [`DELETE /api/projects/:projectId`](./routes.md) | path: `projectId` (sixteen hex digits) | [`packages/web/src/server/index.ts:116`](../../packages/web/src/server/index.ts#L116) |
| `respondToPromptRemoval → PromptLibrary.remove` | [`DELETE /api/prompts/:id`](./routes.md) | path: `id` | [`packages/web/src/server/index.ts:114`](../../packages/web/src/server/index.ts#L114) |
| `respondToPromptWrite → PromptLibrary.write` | [`PUT /api/prompts/:id`](./routes.md) | path: `id`; body: `EnsoLibraryPromptWrite` — `name`, `description`, `category` (system, append or session) and the markdown `body` | [`packages/web/src/server/index.ts:113`](../../packages/web/src/server/index.ts#L113) |
| `respondToAbort → abortThread` | [`POST /api/threads/:threadId/abort`](./routes.md) | path: `threadId`; no body | [`packages/web/src/server/index.ts:91`](../../packages/web/src/server/index.ts#L91)<br>[`packages/web/src/server/follow.ts:827`](../../packages/web/src/server/follow.ts#L827) |
| `respondToHostCommand → runHostCommand` | [`POST /api/threads/:threadId/command`](./routes.md) | path: `threadId`; body: `EnsoHostCommandRun` — `model` with `provider/id`, `thinking` with a level, `login` with `provider/authType`, `logout` with a provider, `compact` with nothing; a `view` row (`context`, `fork`) is the page's to do, never run | [`packages/web/src/server/index.ts:95`](../../packages/web/src/server/index.ts#L95) |
| `respondToConfigure → configureThread` | [`POST /api/threads/:threadId/configure`](./routes.md) | path: `threadId`; body: `EnsoSessionConfiguration` — optional `systemPrompt` (a library prompt id, `system` or `append`; absent is pi's default), `model` (`provider/id`), `thinking` (a level that model supports) and `mode`; applied in that order under one lease, a value equal to the current one left alone | [`packages/web/src/server/index.ts:97`](../../packages/web/src/server/index.ts#L97) |
| `respondToContinue → continueThread → ThreadRuntime.continueRun` | [`POST /api/threads/:threadId/continue`](./routes.md) | path: `threadId`; no body | [`packages/web/src/server/index.ts:106`](../../packages/web/src/server/index.ts#L106)<br>[`packages/web/src/server/follow.ts:389`](../../packages/web/src/server/follow.ts#L389) |
| `respondToDialog → answerThreadDialog` | [`POST /api/threads/:threadId/dialog`](./routes.md) | path: `threadId`; body: `DialogAnswer` | [`packages/web/src/server/index.ts:90`](../../packages/web/src/server/index.ts#L90)<br>[`packages/web/src/server/follow.ts:467`](../../packages/web/src/server/follow.ts#L467) |
| `respondToFork → forkThreadAt → AgentHost.forkThread` | [`POST /api/threads/:threadId/fork`](./routes.md) | path: `threadId`; body: `EnsoForkRequest` — `entryId`, the pi entry id of one of the thread's user messages; the fork is pi's `/fork` at position `before`, taken from the session file | [`packages/web/src/server/index.ts:104`](../../packages/web/src/server/index.ts#L104)<br>[`packages/web/src/server/follow.ts:799`](../../packages/web/src/server/follow.ts#L799) |
| `respondToModeChange → changeThreadMode` | [`POST /api/threads/:threadId/mode`](./routes.md) | path: `threadId`; body: `EnsoPermissionModeChange` | [`packages/web/src/server/index.ts:93`](../../packages/web/src/server/index.ts#L93)<br>[`packages/web/src/server/follow.ts:503`](../../packages/web/src/server/follow.ts#L503) |
| `respondToPrompt → promptThread` | [`POST /api/threads/:threadId/prompt`](./routes.md) | path: `threadId`; body: `EnsoPromptBody` | [`packages/web/src/server/index.ts:89`](../../packages/web/src/server/index.ts#L89)<br>[`packages/web/src/server/follow.ts:285`](../../packages/web/src/server/follow.ts#L285) |

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
| `observation frame` | [Observations](./observations.md) | [`packages/web/src/server/follow.ts:191`](../../packages/web/src/server/follow.ts#L191) |
| `follow connection` | [Routes](./routes.md) | [`packages/web/src/follow-connection.ts:480`](../../packages/web/src/follow-connection.ts#L480) |
| `to-agui chunk` | [Observations](./observations.md) | [`packages/web/src/to-agui.ts:76`](../../packages/web/src/to-agui.ts#L76) |
| `custom event router` | [Observations](./observations.md) | [`packages/web/src/custom-event-router.ts:209`](../../packages/web/src/custom-event-router.ts#L209) |

Kinds, in the union's order of declaration: `text-delta`, `thinking-delta`, `tool-call`, `tool-result`, `custom-entry`, `permission-mode`, `permission-mode-rejected`, `model`, `message-start`, `message-end`, `session-usage`, `turn-start`, `turn-end`, `provider-refused`, `provider-retry`, `provider-retry-ended`, `queue`, `prompt-rejected`, `extension-error`, `extension-ui-request`, `dialog-settled`, `run-ended`, `settled`, `unmapped`.
