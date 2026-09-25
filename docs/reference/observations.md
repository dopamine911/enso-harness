<!-- generated: scripts/docs/observations.ts -->
# Observation inventory

Generated from `EnsoObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter and the browser chunk router. One vocabulary (#162 workstream 5): a CUSTOM chunk is named by the observation `kind` (or the frame `type`) it carries whole.

> Parser limitation: schemas must be direct identifiers in `EnsoObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `custom(observation)` and explicit empty-array branches; router branches are `case '<kind>':` lines; browser store semantics remain explicit checked metadata.

A carrier marked **ELIDED** does not reach the browser in that state (#279): the observation is still numbered, still logged at `trace` and still counted in the `emitted` tail of `/api/threads/:id/events`, but no frame is written — the adapter emission for that state is `dropped`, so the bytes would be serialised and schema-checked for nothing. The `sent` tail claims only what crossed, and frame `seq` skips the elided numbers.

| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |
|---|---|---|---|---|---|
| `custom-entry` | [`EnsoCustomEntry`](../../packages/core/src/observation.ts#L231) | [mapper](../../packages/web/src/host/map-events.ts#L402) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `custom-entry` (CUSTOM) | `recentChunks` only; recorded and counted, rendered by nothing (L3) |
| `dialog-settled` | [`EnsoDialogSettled`](../../packages/core/src/observation.ts#L200) | [mapper](../../packages/web/src/host/map-events.ts#L369) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `dialog-settled` (CUSTOM) | `recentChunks`; `dialog` |
| `extension-error` | [`EnsoExtensionError`](../../packages/core/src/observation.ts#L522) | [mapper](../../packages/web/src/host/map-events.ts#L409) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.RUN_ERROR` | TanStack chat state |
| `extension-ui-request` | [`EnsoExtensionUiRequest`](../../packages/core/src/observation.ts#L156) | [mapper](../../packages/web/src/host/map-events.ts#L170) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.RUN_ERROR`<br>`extension-ui-request` (CUSTOM)<br>`dropped` | `recentChunks`; `dialog` (a blocking question; or `notifications` if unreadable); `notifications` (a notify)<br>TanStack chat state<br>nothing consumes the dropped branch |
| `message-end` | [`EnsoMessageEnd`](../../packages/core/src/observation.ts#L366) | [mapper](../../packages/web/src/host/map-events.ts#L245) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `dropped` | nothing consumes the dropped branch |
| `message-start` | [`EnsoMessageStart`](../../packages/core/src/observation.ts#L336) | [mapper](../../packages/web/src/host/map-events.ts#L222) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `dropped` | nothing consumes the dropped branch |
| `model` | [`EnsoModelObservation`](../../packages/core/src/observation.ts#L282) | [mapper](../../packages/web/src/host/map-events.ts#L378) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `model` (CUSTOM) | `recentChunks`; `model` (the composer chip and thinking level, #338 slice 2) |
| `permission-mode` | [`EnsoPermissionMode`](../../packages/core/src/observation.ts#L253) | [mapper](../../packages/web/src/host/map-events.ts#L375) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `permission-mode` (CUSTOM) | `recentChunks`; `permissionMode`; `modeLines` |
| `permission-mode-rejected` | [`EnsoPermissionModeRejected`](../../packages/core/src/observation.ts#L315) | [prompt route](../../packages/web/src/server/follow.ts#L422) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `permission-mode-rejected` (CUSTOM) | `recentChunks`; `notifications` (a warning) |
| `prompt-rejected` | [`EnsoPromptRejected`](../../packages/core/src/observation.ts#L505) | [prompt route](../../packages/web/src/server/follow.ts#L271) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.RUN_ERROR` | TanStack chat state |
| `provider-refused` | [`EnsoProviderRefused`](../../packages/core/src/observation.ts#L451) | [mapper](../../packages/web/src/host/map-events.ts#L385) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `provider-refused` (CUSTOM) | `recentChunks`; `notifications` (an error); `refusal` (the status bar's class word, #340) |
| `provider-retry` | [`EnsoProviderRetrying`](../../packages/core/src/observation.ts#L468) | [mapper](../../packages/web/src/host/map-events.ts#L257) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `provider-retry` (CUSTOM) | `recentChunks`; `notifications` (a warning, #340) |
| `provider-retry-ended` | [`EnsoProviderRetryEnded`](../../packages/core/src/observation.ts#L485) | [mapper](../../packages/web/src/host/map-events.ts#L270) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `provider-retry-ended` (CUSTOM) | `recentChunks`; `notifications` (an error, when no retry got through — #380 review) |
| `queue` | [`EnsoQueue`](../../packages/core/src/observation.ts#L432) | [mapper](../../packages/web/src/host/map-events.ts#L312) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `queue` (CUSTOM) | `recentChunks`; `queue` |
| `run-ended` | [`EnsoRunEnded`](../../packages/core/src/observation.ts#L535) | [mapper](../../packages/web/src/host/map-events.ts#L416) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.STEP_FINISHED` | TanStack chat state |
| `session-usage` | [`EnsoSessionUsageObservation`](../../packages/core/src/observation.ts#L301) | [mapper](../../packages/web/src/host/map-events.ts#L381) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `session-usage` (CUSTOM) | `recentChunks`; `usage` (the status bar's cost and context meter, #45); clears `refusal` once output grows (#340) |
| `settled` | [`EnsoSettled`](../../packages/core/src/observation.ts#L546) | [mapper](../../packages/web/src/host/map-events.ts#L419) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.RUN_FINISHED` | TanStack chat state |
| `text-delta` | [`EnsoTextDelta`](../../packages/core/src/observation.ts#L43) | [mapper](../../packages/web/src/host/map-events.ts#L288) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.TEXT_MESSAGE_CONTENT` | TanStack chat state |
| `thinking-delta` | [`EnsoThinkingDelta`](../../packages/core/src/observation.ts#L54) | [mapper](../../packages/web/src/host/map-events.ts#L291) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.REASONING_MESSAGE_CONTENT` | TanStack chat state |
| `tool-call` | [`EnsoToolCall`](../../packages/core/src/observation.ts#L67) | [mapper](../../packages/web/src/host/map-events.ts#L316) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.TOOL_CALL_START`<br>`EventType.TOOL_CALL_ARGS` | TanStack chat state |
| `tool-result` | [`EnsoToolResultObservation`](../../packages/core/src/observation.ts#L85) | [mapper](../../packages/web/src/host/map-events.ts#L327) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) — [ELIDED](../../packages/web/src/server/follow.ts#L147) while `complete: false` | `EventType.TOOL_CALL_RESULT`<br>`dropped` | TanStack chat state<br>nothing consumes the dropped branch |
| `turn-end` | [`EnsoTurnEnd`](../../packages/core/src/observation.ts#L403) | [mapper](../../packages/web/src/host/map-events.ts#L308) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.STEP_FINISHED` | TanStack chat state |
| `turn-start` | [`EnsoTurnStart`](../../packages/core/src/observation.ts#L393) | [mapper](../../packages/web/src/host/map-events.ts#L304) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `EventType.STEP_STARTED` | TanStack chat state |
| `unmapped` | [`EnsoUnmapped`](../../packages/core/src/observation.ts#L558) | [mapper](../../packages/web/src/host/map-events.ts#L211) | [`observation` frame](../../packages/web/src/server/follow.ts#L179) | `unmapped` (CUSTOM) | `recentChunks` only; nothing else consumes it |

## Chunks that are not observations

| Chunk | Carries | Browser consumer / store |
|---|---|---|
| `snapshot` | the follow's `snapshot` frame, whole ([`follow.ts`](../../packages/core/src/follow.ts)) | `recentChunks`; `permissionMode`; `modeLines`; `model`; `cwd`; `usage`; `refusal` (the status bar's class word off the branch's last reply, #381); `dialog` (the complete open list); `generation`; `disconnected` |
| `status` | the follow's `status` frame, whole ([`follow.ts`](../../packages/core/src/follow.ts)) | `recentChunks`; `generation`; `disconnected` |
| `follow-ended` | the adapter, when the follow closes under the page ([`follow-connection.ts`](../../packages/web/src/follow-connection.ts)) | `recentChunks`; `disconnected`; `notifications` |

## Diagnostics

- Schemas with no producer: none
- CUSTOM kinds the router records but does not route: `custom-entry`, `unmapped`
- Kinds with an unclassified cell: none

Inventory: 24 union members; 12 ride CUSTOM by kind; 3 chunks that are not observations; every chunk name has a checked browser classification.
