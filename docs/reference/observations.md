<!-- generated: scripts/docs/observations.ts -->
# Observation inventory

Generated from `ZenObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter, all custom event names, their emitters, and the browser custom-event router.

> Parser limitation: schemas must be direct identifiers in `ZenObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `ZEN_CUSTOM_EVENT_*`, and explicit empty-array branches; browser store semantics remain explicit checked metadata.

| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |
|---|---|---|---|---|---|
| `custom-entry` | [`ZenCustomEntry`](../../packages/core/src/observation.ts#L163) | [mapper](../../packages/web/src/rpc/map-events.ts#L316) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `zen.entry` (CUSTOM) | `recentChunks`; `modeLines`; `permissionMode` |
| `dialog-settled` | [`ZenDialogSettled`](../../packages/core/src/observation.ts#L139) | [mapper](../../packages/web/src/rpc/map-events.ts#L302) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `zen.dialog-settled` (CUSTOM) | `recentChunks`; `dialog` |
| `extension-error` | [`ZenExtensionError`](../../packages/core/src/observation.ts#L250) | [mapper](../../packages/web/src/rpc/map-events.ts#L323) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.RUN_ERROR` | TanStack chat state |
| `extension-ui-request` | [`ZenExtensionUiRequest`](../../packages/core/src/observation.ts#L108) | [mapper](../../packages/web/src/rpc/map-events.ts#L151) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.RUN_ERROR`<br>`zen.dialog` (CUSTOM)<br>`zen.notify` (CUSTOM)<br>`dropped` | `recentChunks`; `dialog` (or `notifications` if malformed)<br>`recentChunks`; `notifications`<br>TanStack chat state<br>nothing consumes the dropped branch |
| `message-end` | [`ZenMessageEnd`](../../packages/core/src/observation.ts#L199) | [mapper](../../packages/web/src/rpc/map-events.ts#L205) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `zen.usage` (CUSTOM)<br>`dropped` | `recentChunks`; `stats`<br>nothing consumes the dropped branch |
| `message-start` | [`ZenMessageStart`](../../packages/core/src/observation.ts#L176) | [mapper](../../packages/web/src/rpc/map-events.ts#L185) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `dropped` | nothing consumes the dropped branch |
| `prompt-rejected` | [`ZenPromptRejected`](../../packages/core/src/observation.ts#L242) | [prompt route](../../packages/web/src/server/follow.ts#L203) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.RUN_ERROR` | TanStack chat state |
| `queue` | [`ZenQueue`](../../packages/core/src/observation.ts#L229) | [mapper](../../packages/web/src/rpc/map-events.ts#L248) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `zen.queue` (CUSTOM) | `recentChunks`; `queue` |
| `run-ended` | [`ZenRunEnded`](../../packages/core/src/observation.ts#L258) | [mapper](../../packages/web/src/rpc/map-events.ts#L330) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.STEP_FINISHED` | TanStack chat state |
| `settled` | [`ZenSettled`](../../packages/core/src/observation.ts#L264) | [mapper](../../packages/web/src/rpc/map-events.ts#L333) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.RUN_FINISHED` | TanStack chat state |
| `text-delta` | [`ZenTextDelta`](../../packages/core/src/observation.ts#L26) | [mapper](../../packages/web/src/rpc/map-events.ts#L225) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.TEXT_MESSAGE_CONTENT` | TanStack chat state |
| `thinking-delta` | [`ZenThinkingDelta`](../../packages/core/src/observation.ts#L33) | [mapper](../../packages/web/src/rpc/map-events.ts#L228) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.REASONING_MESSAGE_CONTENT` | TanStack chat state |
| `tool-call` | [`ZenToolCall`](../../packages/core/src/observation.ts#L41) | [mapper](../../packages/web/src/rpc/map-events.ts#L252) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.TOOL_CALL_START`<br>`EventType.TOOL_CALL_ARGS` | TanStack chat state |
| `tool-result` | [`ZenToolResultObservation`](../../packages/core/src/observation.ts#L56) | [mapper](../../packages/web/src/rpc/map-events.ts#L263) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.TOOL_CALL_RESULT`<br>`dropped` | TanStack chat state<br>nothing consumes the dropped branch |
| `turn-end` | [`ZenTurnEnd`](../../packages/core/src/observation.ts#L214) | [mapper](../../packages/web/src/rpc/map-events.ts#L245) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.STEP_FINISHED` | TanStack chat state |
| `turn-start` | [`ZenTurnStart`](../../packages/core/src/observation.ts#L212) | [mapper](../../packages/web/src/rpc/map-events.ts#L241) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `EventType.STEP_STARTED` | TanStack chat state |
| `unmapped` | [`ZenUnmapped`](../../packages/core/src/observation.ts#L273) | [mapper](../../packages/web/src/rpc/map-events.ts#L231) | [`observation` frame](../../packages/web/src/server/follow.ts#L114) | `zen.unmapped` (CUSTOM) | `recentChunks` only; nothing else consumes it |

## Diagnostics

- Schemas with no producer: none
- Custom names with no emission: none
- Emissions with no router branch: `zen.unmapped` (`ZEN_CUSTOM_EVENT_UNMAPPED`)

Inventory: 17 union members; 11 custom event constants; all custom constants have checked browser classifications.
