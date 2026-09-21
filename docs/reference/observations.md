<!-- generated: scripts/docs/observations.ts -->
# Observation inventory

Generated from `ZenObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter and the browser chunk router. One vocabulary (#162 workstream 5): a CUSTOM chunk is named by the observation `kind` (or the frame `type`) it carries whole.

> Parser limitation: schemas must be direct identifiers in `ZenObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `custom(observation)` and explicit empty-array branches; router branches are `case '<kind>':` lines; browser store semantics remain explicit checked metadata.

A carrier marked **ELIDED** does not reach the browser in that state (#279): the observation is still numbered, still logged at `trace` and still counted in the `emitted` tail of `/api/threads/:id/events`, but no frame is written — the adapter emission for that state is `dropped`, so the bytes would be serialised and schema-checked for nothing. The `sent` tail claims only what crossed, and frame `seq` skips the elided numbers.

| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |
|---|---|---|---|---|---|
| `custom-entry` | [`ZenCustomEntry`](../../packages/core/src/observation.ts#L167) | [mapper](../../packages/web/src/host/map-events.ts#L335) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `custom-entry` (CUSTOM) | `recentChunks` only; recorded and counted, rendered by nothing (L3) |
| `dialog-settled` | [`ZenDialogSettled`](../../packages/core/src/observation.ts#L143) | [mapper](../../packages/web/src/host/map-events.ts#L318) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `dialog-settled` (CUSTOM) | `recentChunks`; `dialog` |
| `extension-error` | [`ZenExtensionError`](../../packages/core/src/observation.ts#L294) | [mapper](../../packages/web/src/host/map-events.ts#L342) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.RUN_ERROR` | TanStack chat state |
| `extension-ui-request` | [`ZenExtensionUiRequest`](../../packages/core/src/observation.ts#L109) | [mapper](../../packages/web/src/host/map-events.ts#L151) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.RUN_ERROR`<br>`extension-ui-request` (CUSTOM)<br>`dropped` | `recentChunks`; `dialog` (a blocking question; or `notifications` if unreadable); `notifications` (a notify)<br>TanStack chat state<br>nothing consumes the dropped branch |
| `message-end` | [`ZenMessageEnd`](../../packages/core/src/observation.ts#L233) | [mapper](../../packages/web/src/host/map-events.ts#L217) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `message-end` (CUSTOM)<br>`dropped` | `recentChunks`; `stats`<br>nothing consumes the dropped branch |
| `message-start` | [`ZenMessageStart`](../../packages/core/src/observation.ts#L210) | [mapper](../../packages/web/src/host/map-events.ts#L197) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `dropped` | nothing consumes the dropped branch |
| `permission-mode` | [`ZenPermissionMode`](../../packages/core/src/observation.ts#L182) | [mapper](../../packages/web/src/host/map-events.ts#L185) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `permission-mode` (CUSTOM) | `recentChunks`; `permissionMode`; `modeLines` |
| `permission-mode-rejected` | [`ZenPermissionModeRejected`](../../packages/core/src/observation.ts#L196) | [prompt route](../../packages/web/src/server/follow.ts#L375) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `permission-mode-rejected` (CUSTOM) | `recentChunks`; `notifications` (a warning) |
| `prompt-rejected` | [`ZenPromptRejected`](../../packages/core/src/observation.ts#L286) | [prompt route](../../packages/web/src/server/follow.ts#L227) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.RUN_ERROR` | TanStack chat state |
| `queue` | [`ZenQueue`](../../packages/core/src/observation.ts#L272) | [mapper](../../packages/web/src/host/map-events.ts#L261) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `queue` (CUSTOM) | `recentChunks`; `queue` |
| `run-ended` | [`ZenRunEnded`](../../packages/core/src/observation.ts#L302) | [mapper](../../packages/web/src/host/map-events.ts#L349) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.STEP_FINISHED` | TanStack chat state |
| `settled` | [`ZenSettled`](../../packages/core/src/observation.ts#L308) | [mapper](../../packages/web/src/host/map-events.ts#L352) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.RUN_FINISHED` | TanStack chat state |
| `text-delta` | [`ZenTextDelta`](../../packages/core/src/observation.ts#L27) | [mapper](../../packages/web/src/host/map-events.ts#L237) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.TEXT_MESSAGE_CONTENT` | TanStack chat state |
| `thinking-delta` | [`ZenThinkingDelta`](../../packages/core/src/observation.ts#L34) | [mapper](../../packages/web/src/host/map-events.ts#L240) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.REASONING_MESSAGE_CONTENT` | TanStack chat state |
| `tool-call` | [`ZenToolCall`](../../packages/core/src/observation.ts#L42) | [mapper](../../packages/web/src/host/map-events.ts#L265) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.TOOL_CALL_START`<br>`EventType.TOOL_CALL_ARGS` | TanStack chat state |
| `tool-result` | [`ZenToolResultObservation`](../../packages/core/src/observation.ts#L57) | [mapper](../../packages/web/src/host/map-events.ts#L276) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) — [ELIDED](../../packages/web/src/server/follow.ts#L108) while `complete: false` | `EventType.TOOL_CALL_RESULT`<br>`dropped` | TanStack chat state<br>nothing consumes the dropped branch |
| `turn-end` | [`ZenTurnEnd`](../../packages/core/src/observation.ts#L250) | [mapper](../../packages/web/src/host/map-events.ts#L257) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.STEP_FINISHED` | TanStack chat state |
| `turn-start` | [`ZenTurnStart`](../../packages/core/src/observation.ts#L248) | [mapper](../../packages/web/src/host/map-events.ts#L253) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `EventType.STEP_STARTED` | TanStack chat state |
| `unmapped` | [`ZenUnmapped`](../../packages/core/src/observation.ts#L317) | [mapper](../../packages/web/src/host/map-events.ts#L186) | [`observation` frame](../../packages/web/src/server/follow.ts#L140) | `unmapped` (CUSTOM) | `recentChunks` only; nothing else consumes it |

## Chunks that are not observations

| Chunk | Carries | Browser consumer / store |
|---|---|---|
| `snapshot` | the follow's `snapshot` frame, whole ([`follow.ts`](../../packages/core/src/follow.ts)) | `recentChunks`; `permissionMode`; `modeLines`; `dialog` (the complete open list); `generation`; `disconnected` |
| `status` | the follow's `status` frame, whole ([`follow.ts`](../../packages/core/src/follow.ts)) | `recentChunks`; `generation`; `disconnected` |
| `follow-ended` | the adapter, when the follow closes under the page ([`follow-connection.ts`](../../packages/web/src/follow-connection.ts)) | `recentChunks`; `disconnected`; `notifications` |

## Diagnostics

- Schemas with no producer: none
- CUSTOM kinds the router records but does not route: `custom-entry`, `unmapped`
- Kinds with an unclassified cell: none

Inventory: 19 union members; 8 ride CUSTOM by kind; 3 chunks that are not observations; every chunk name has a checked browser classification.
