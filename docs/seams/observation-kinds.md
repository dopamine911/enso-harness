<!-- generated: scripts/docs/observation-kinds.ts -->
# Observation kinds

Generated from `packages/core/src/observation.ts` (the union), `packages/web/src/rpc/map-events.ts`
(the mapper), `packages/web/src/server/follow.ts` (the one route that announces an observation
itself) and `packages/web/src/rpc/to-agui.ts` (the browser adapter). One row per kind the union
declares. "Adapter emits" is what the state layer sees for that kind — an `EventType.*` stream
event, or a custom event by its wire name.

| Kind | Schema | Produced by | Adapter emits |
|---|---|---|---|
| `text-delta` | `ZenTextDelta` | the mapper | `TEXT_MESSAGE_CONTENT` |
| `thinking-delta` | `ZenThinkingDelta` | the mapper | `REASONING_MESSAGE_CONTENT` |
| `tool-call` | `ZenToolCall` | the mapper | `TOOL_CALL_START`, `TOOL_CALL_ARGS` |
| `tool-result` | `ZenToolResultObservation` | the mapper | `TOOL_CALL_RESULT` |
| `extension-ui-request` | `ZenExtensionUiRequest` | the mapper | `CUSTOM`, `zen.dialog`, `RUN_ERROR`, `zen.notify` |
| `dialog-settled` | `ZenDialogSettled` | the mapper | `CUSTOM`, `zen.dialog-settled` |
| `custom-entry` | `ZenCustomEntry` | the mapper | `CUSTOM`, `zen.entry` |
| `message-start` | `ZenMessageStart` | the mapper | dropped (no chunk) |
| `message-end` | `ZenMessageEnd` | the mapper | `CUSTOM`, `zen.usage` |
| `turn-start` | `ZenTurnStart` | the mapper | `STEP_STARTED` |
| `turn-end` | `ZenTurnEnd` | the mapper | `STEP_FINISHED` |
| `queue` | `ZenQueue` | the mapper | `CUSTOM`, `zen.queue` |
| `prompt-rejected` | `ZenPromptRejected` | the prompt route (`follow.ts`) | `RUN_ERROR` |
| `extension-error` | `ZenExtensionError` | the mapper | `RUN_ERROR` |
| `run-ended` | `ZenRunEnded` | the mapper | `STEP_FINISHED` |
| `settled` | `ZenSettled` | the mapper | `RUN_FINISHED` |
| `unmapped` | `ZenUnmapped` | the mapper | `CUSTOM`, `zen.unmapped` |
