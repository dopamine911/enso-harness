<!-- generated: scripts/docs/observations.ts -->
# Observation inventory

Generated from `ZenObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter, all custom event names, their emitters, and the browser custom-event router.

> Parser limitation: schemas must be direct identifiers in `ZenObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `ZEN_CUSTOM_EVENT_*`, and explicit empty-array branches; browser store semantics remain explicit checked metadata.

| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |
|---|---|---|---|---|---|
| `custom-entry` | [`ZenCustomEntry`](../../packages/core/src/observation.ts#L164) | [mapper](../../packages/web/src/rpc/map-events.ts#L332) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `zen.entry` (CUSTOM) | `recentChunks` only; recorded and counted, rendered by nothing (L3) |
| `dialog-settled` | [`ZenDialogSettled`](../../packages/core/src/observation.ts#L140) | [mapper](../../packages/web/src/rpc/map-events.ts#L315) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `zen.dialog-settled` (CUSTOM) | `recentChunks`; `dialog` |
| `extension-error` | [`ZenExtensionError`](../../packages/core/src/observation.ts#L277) | [mapper](../../packages/web/src/rpc/map-events.ts#L339) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.RUN_ERROR` | TanStack chat state |
| `extension-ui-request` | [`ZenExtensionUiRequest`](../../packages/core/src/observation.ts#L109) | [mapper](../../packages/web/src/rpc/map-events.ts#L152) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.RUN_ERROR`<br>`zen.dialog` (CUSTOM)<br>`zen.notify` (CUSTOM)<br>`dropped` | `recentChunks`; `dialog` (or `notifications` if malformed)<br>`recentChunks`; `notifications`<br>TanStack chat state<br>nothing consumes the dropped branch |
| `message-end` | [`ZenMessageEnd`](../../packages/core/src/observation.ts#L226) | [mapper](../../packages/web/src/rpc/map-events.ts#L218) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `zen.usage` (CUSTOM)<br>`dropped` | `recentChunks`; `stats`<br>nothing consumes the dropped branch |
| `message-start` | [`ZenMessageStart`](../../packages/core/src/observation.ts#L203) | [mapper](../../packages/web/src/rpc/map-events.ts#L198) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `dropped` | nothing consumes the dropped branch |
| `permission-mode` | [`ZenPermissionMode`](../../packages/core/src/observation.ts#L178) | [mapper](../../packages/web/src/rpc/map-events.ts#L186) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `zen.mode` (CUSTOM) | `recentChunks`; `permissionMode`; `modeLines` |
| `permission-mode-rejected` | [`ZenPermissionModeRejected`](../../packages/core/src/observation.ts#L190) | [prompt route](../../packages/web/src/server/follow.ts#L348) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `zen.notify` (CUSTOM) | `recentChunks`; `notifications` |
| `prompt-rejected` | [`ZenPromptRejected`](../../packages/core/src/observation.ts#L269) | [prompt route](../../packages/web/src/server/follow.ts#L204) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.RUN_ERROR` | TanStack chat state |
| `queue` | [`ZenQueue`](../../packages/core/src/observation.ts#L256) | [mapper](../../packages/web/src/rpc/map-events.ts#L261) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `zen.queue` (CUSTOM) | `recentChunks`; `queue` |
| `run-ended` | [`ZenRunEnded`](../../packages/core/src/observation.ts#L285) | [mapper](../../packages/web/src/rpc/map-events.ts#L346) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.STEP_FINISHED` | TanStack chat state |
| `settled` | [`ZenSettled`](../../packages/core/src/observation.ts#L291) | [mapper](../../packages/web/src/rpc/map-events.ts#L349) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.RUN_FINISHED` | TanStack chat state |
| `text-delta` | [`ZenTextDelta`](../../packages/core/src/observation.ts#L27) | [mapper](../../packages/web/src/rpc/map-events.ts#L238) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.TEXT_MESSAGE_CONTENT` | TanStack chat state |
| `thinking-delta` | [`ZenThinkingDelta`](../../packages/core/src/observation.ts#L34) | [mapper](../../packages/web/src/rpc/map-events.ts#L241) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.REASONING_MESSAGE_CONTENT` | TanStack chat state |
| `tool-call` | [`ZenToolCall`](../../packages/core/src/observation.ts#L42) | [mapper](../../packages/web/src/rpc/map-events.ts#L265) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.TOOL_CALL_START`<br>`EventType.TOOL_CALL_ARGS` | TanStack chat state |
| `tool-result` | [`ZenToolResultObservation`](../../packages/core/src/observation.ts#L57) | [mapper](../../packages/web/src/rpc/map-events.ts#L276) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.TOOL_CALL_RESULT`<br>`dropped` | TanStack chat state<br>nothing consumes the dropped branch |
| `turn-end` | [`ZenTurnEnd`](../../packages/core/src/observation.ts#L241) | [mapper](../../packages/web/src/rpc/map-events.ts#L258) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.STEP_FINISHED` | TanStack chat state |
| `turn-start` | [`ZenTurnStart`](../../packages/core/src/observation.ts#L239) | [mapper](../../packages/web/src/rpc/map-events.ts#L254) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `EventType.STEP_STARTED` | TanStack chat state |
| `unmapped` | [`ZenUnmapped`](../../packages/core/src/observation.ts#L300) | [mapper](../../packages/web/src/rpc/map-events.ts#L187) | [`observation` frame](../../packages/web/src/server/follow.ts#L115) | `zen.unmapped` (CUSTOM) | `recentChunks` only; nothing else consumes it |

## Diagnostics

- Schemas with no producer: none
- Custom names with no emission: none
- Emissions with no router branch: `zen.entry` (`ZEN_CUSTOM_EVENT_ENTRY`), `zen.unmapped` (`ZEN_CUSTOM_EVENT_UNMAPPED`)

Inventory: 19 union members; 11 custom event constants; all custom constants have checked browser classifications.
