<!-- generated: scripts/docs/observations.ts -->
# Observation inventory

Generated from `EnsoObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter and the browser chunk router. One vocabulary (#162 workstream 5): a CUSTOM chunk is named by the observation `kind` (or the frame `type`) it carries whole.

> Parser limitation: schemas must be direct identifiers in `EnsoObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `custom(observation)` and explicit empty-array branches; router branches are `case '<kind>':` lines; browser store semantics remain explicit checked metadata.

A carrier marked **ELIDED** does not reach the browser in that state (#279): the observation is still numbered, still logged at `trace` and still counted in the `emitted` tail of `/api/threads/:id/events`, but no frame is written — the adapter emission for that state is `dropped`, so the bytes would be serialised and schema-checked for nothing. The `sent` tail claims only what crossed, and frame `seq` skips the elided numbers.

| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |
|---|---|---|---|---|---|
| `branch-compacted` | [`EnsoBranchCompacted`](../../packages/core/src/observation.ts#L574) | [mapper](../../packages/web/src/host/map-events.ts#L286) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `branch-compacted` (CUSTOM) | `recentChunks`; `branchCompacted` (the pane re-reads the thread's messages once idle, #348) |
| `custom-entry` | [`EnsoCustomEntry`](../../packages/core/src/observation.ts#L247) | [mapper](../../packages/web/src/host/map-events.ts#L427) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `custom-entry` (CUSTOM) | `recentChunks`; a guard refusal (`enso-guard-denial`, #387) lands in `guardDenials` — every other entry is rendered by nothing (L3) |
| `dialog-settled` | [`EnsoDialogSettled`](../../packages/core/src/observation.ts#L216) | [mapper](../../packages/web/src/host/map-events.ts#L387) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `dialog-settled` (CUSTOM) | `recentChunks`; `dialog` |
| `extension-error` | [`EnsoExtensionError`](../../packages/core/src/observation.ts#L538) | [mapper](../../packages/web/src/host/map-events.ts#L434) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.RUN_ERROR` | TanStack chat state |
| `extension-ui-request` | [`EnsoExtensionUiRequest`](../../packages/core/src/observation.ts#L165) | [mapper](../../packages/web/src/host/map-events.ts#L169) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.RUN_ERROR`<br>`extension-ui-request` (CUSTOM)<br>`dropped` | `recentChunks`; `dialog` (a blocking question; or `notifications` if unreadable); `notifications` (a notify)<br>TanStack chat state<br>nothing consumes the dropped branch |
| `login` | [`EnsoLoginObservation`](../../packages/core/src/observation.ts#L609) | [mapper](../../packages/web/src/host/map-events.ts#L403) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `login` (CUSTOM) | `recentChunks`; `login` (the composer offers Stop for a login waiting on its provider, #348) |
| `message-end` | [`EnsoMessageEnd`](../../packages/core/src/observation.ts#L382) | [mapper](../../packages/web/src/host/map-events.ts#L249) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `dropped` | nothing consumes the dropped branch |
| `message-start` | [`EnsoMessageStart`](../../packages/core/src/observation.ts#L352) | [mapper](../../packages/web/src/host/map-events.ts#L226) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `dropped` | nothing consumes the dropped branch |
| `model` | [`EnsoModelObservation`](../../packages/core/src/observation.ts#L298) | [mapper](../../packages/web/src/host/map-events.ts#L396) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `model` (CUSTOM) | `recentChunks`; `model` (the composer chip and thinking level, #338 slice 2) |
| `permission-mode` | [`EnsoPermissionMode`](../../packages/core/src/observation.ts#L269) | [mapper](../../packages/web/src/host/map-events.ts#L393) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `permission-mode` (CUSTOM) | `recentChunks`; `permissionMode`; `modeLines` |
| `permission-mode-rejected` | [`EnsoPermissionModeRejected`](../../packages/core/src/observation.ts#L331) | [prompt route](../../packages/web/src/server/follow.ts#L538) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `permission-mode-rejected` (CUSTOM) | `recentChunks`; `notifications` (a warning) |
| `prompt-rejected` | [`EnsoPromptRejected`](../../packages/core/src/observation.ts#L521) | [prompt route](../../packages/web/src/server/follow.ts#L315) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.RUN_ERROR` | TanStack chat state |
| `provider-refused` | [`EnsoProviderRefused`](../../packages/core/src/observation.ts#L467) | [mapper](../../packages/web/src/host/map-events.ts#L407) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `provider-refused` (CUSTOM) | `recentChunks`; `notifications` (an error); `refusal` (the status bar's class word, #340) |
| `provider-retry` | [`EnsoProviderRetrying`](../../packages/core/src/observation.ts#L484) | [mapper](../../packages/web/src/host/map-events.ts#L261) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `provider-retry` (CUSTOM) | `recentChunks`; `notifications` (a warning, #340) |
| `provider-retry-ended` | [`EnsoProviderRetryEnded`](../../packages/core/src/observation.ts#L501) | [mapper](../../packages/web/src/host/map-events.ts#L274) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `provider-retry-ended` (CUSTOM) | `recentChunks`; `notifications` (an error, when no retry got through — #380 review) |
| `queue` | [`EnsoQueue`](../../packages/core/src/observation.ts#L448) | [mapper](../../packages/web/src/host/map-events.ts#L330) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `queue` (CUSTOM) | `recentChunks`; `queue` |
| `run-ended` | [`EnsoRunEnded`](../../packages/core/src/observation.ts#L551) | [mapper](../../packages/web/src/host/map-events.ts#L441) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.STEP_FINISHED` | TanStack chat state |
| `session-usage` | [`EnsoSessionUsageObservation`](../../packages/core/src/observation.ts#L317) | [mapper](../../packages/web/src/host/map-events.ts#L399) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `session-usage` (CUSTOM) | `recentChunks`; `usage` (the status bar's cost and context meter, #45); clears `refusal` once output grows (#340) |
| `settled` | [`EnsoSettled`](../../packages/core/src/observation.ts#L562) | [mapper](../../packages/web/src/host/map-events.ts#L444) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.RUN_FINISHED` | TanStack chat state |
| `text-delta` | [`EnsoTextDelta`](../../packages/core/src/observation.ts#L43) | [mapper](../../packages/web/src/host/map-events.ts#L306) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.TEXT_MESSAGE_CONTENT` | TanStack chat state |
| `thinking-delta` | [`EnsoThinkingDelta`](../../packages/core/src/observation.ts#L54) | [mapper](../../packages/web/src/host/map-events.ts#L309) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.REASONING_MESSAGE_CONTENT` | TanStack chat state |
| `tool-call` | [`EnsoToolCall`](../../packages/core/src/observation.ts#L67) | [mapper](../../packages/web/src/host/map-events.ts#L334) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.TOOL_CALL_START`<br>`EventType.TOOL_CALL_ARGS` | TanStack chat state |
| `tool-result` | [`EnsoToolResultObservation`](../../packages/core/src/observation.ts#L85) | [mapper](../../packages/web/src/host/map-events.ts#L345) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) — [ELIDED](../../packages/web/src/server/follow.ts#L162) while `complete: false` | `EventType.TOOL_CALL_RESULT`<br>`dropped` | TanStack chat state<br>nothing consumes the dropped branch |
| `turn-end` | [`EnsoTurnEnd`](../../packages/core/src/observation.ts#L419) | [mapper](../../packages/web/src/host/map-events.ts#L326) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.STEP_FINISHED` | TanStack chat state |
| `turn-start` | [`EnsoTurnStart`](../../packages/core/src/observation.ts#L409) | [mapper](../../packages/web/src/host/map-events.ts#L322) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `EventType.STEP_STARTED` | TanStack chat state |
| `unmapped` | [`EnsoUnmapped`](../../packages/core/src/observation.ts#L624) | [mapper](../../packages/web/src/host/map-events.ts#L215) | [`observation` frame](../../packages/web/src/server/follow.ts#L194) | `unmapped` (CUSTOM) | `recentChunks` only; nothing else consumes it |

## Chunks that are not observations

| Chunk | Carries | Browser consumer / store |
|---|---|---|
| `snapshot` | the follow's `snapshot` frame, whole ([`follow.ts`](../../packages/core/src/follow.ts)) | `recentChunks`; `permissionMode`; `modeLines`; `model`; `cwd`; `usage`; `refusal` (the status bar's class word off the branch's last reply, #381); `dialog` (the complete open list); `generation`; `disconnected` |
| `status` | the follow's `status` frame, whole ([`follow.ts`](../../packages/core/src/follow.ts)) | `recentChunks`; `generation`; `disconnected` |
| `follow-ended` | the adapter, when the follow closes under the page ([`follow-connection.ts`](../../packages/web/src/follow-connection.ts)) | `recentChunks`; `disconnected`; `notifications` |

## Diagnostics

- Schemas with no producer: none
- CUSTOM kinds the router records but does not route: `unmapped`
- Kinds with an unclassified cell: none

Inventory: 26 union members; 14 ride CUSTOM by kind; 3 chunks that are not observations; every chunk name has a checked browser classification.
