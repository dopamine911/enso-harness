<!-- generated: scripts/docs/observations.ts -->
# Observation inventory

Generated from `EnsoObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter and the browser chunk router. One vocabulary (#162 workstream 5): a CUSTOM chunk is named by the observation `kind` (or the frame `type`) it carries whole.

> Parser limitation: schemas must be direct identifiers in `EnsoObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `custom(observation)` and explicit empty-array branches; router branches are `case '<kind>':` lines; browser store semantics remain explicit checked metadata.

A carrier marked **ELIDED** does not reach the browser in that state (#279): the observation is still numbered, still logged at `trace` and still counted in the `emitted` tail of `/api/threads/:id/events`, but no frame is written — the adapter emission for that state is `dropped`, so the bytes would be serialised and schema-checked for nothing. The `sent` tail claims only what crossed, and frame `seq` skips the elided numbers.

| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |
|---|---|---|---|---|---|
| `custom-entry` | [`EnsoCustomEntry`](../../packages/core/src/observation.ts#L229) | [mapper](../../packages/web/src/host/map-events.ts#L354) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `custom-entry` (CUSTOM) | `recentChunks` only; recorded and counted, rendered by nothing (L3) |
| `dialog-settled` | [`EnsoDialogSettled`](../../packages/core/src/observation.ts#L198) | [mapper](../../packages/web/src/host/map-events.ts#L334) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `dialog-settled` (CUSTOM) | `recentChunks`; `dialog` |
| `extension-error` | [`EnsoExtensionError`](../../packages/core/src/observation.ts#L449) | [mapper](../../packages/web/src/host/map-events.ts#L361) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.RUN_ERROR` | TanStack chat state |
| `extension-ui-request` | [`EnsoExtensionUiRequest`](../../packages/core/src/observation.ts#L154) | [mapper](../../packages/web/src/host/map-events.ts#L152) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.RUN_ERROR`<br>`extension-ui-request` (CUSTOM)<br>`dropped` | `recentChunks`; `dialog` (a blocking question; or `notifications` if unreadable); `notifications` (a notify)<br>TanStack chat state<br>nothing consumes the dropped branch |
| `message-end` | [`EnsoMessageEnd`](../../packages/core/src/observation.ts#L345) | [mapper](../../packages/web/src/host/map-events.ts#L232) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `message-end` (CUSTOM)<br>`dropped` | `recentChunks`; `stats`<br>nothing consumes the dropped branch |
| `message-start` | [`EnsoMessageStart`](../../packages/core/src/observation.ts#L315) | [mapper](../../packages/web/src/host/map-events.ts#L209) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `dropped` | nothing consumes the dropped branch |
| `model` | [`EnsoModelObservation`](../../packages/core/src/observation.ts#L280) | [mapper](../../packages/web/src/host/map-events.ts#L197) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `model` (CUSTOM) | `recentChunks`; `model` (the composer chip and thinking level, #338 slice 2) |
| `permission-mode` | [`EnsoPermissionMode`](../../packages/core/src/observation.ts#L251) | [mapper](../../packages/web/src/host/map-events.ts#L186) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `permission-mode` (CUSTOM) | `recentChunks`; `permissionMode`; `modeLines` |
| `permission-mode-rejected` | [`EnsoPermissionModeRejected`](../../packages/core/src/observation.ts#L294) | [prompt route](../../packages/web/src/server/follow.ts#L411) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `permission-mode-rejected` (CUSTOM) | `recentChunks`; `notifications` (a warning) |
| `prompt-rejected` | [`EnsoPromptRejected`](../../packages/core/src/observation.ts#L432) | [prompt route](../../packages/web/src/server/follow.ts#L268) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.RUN_ERROR` | TanStack chat state |
| `queue` | [`EnsoQueue`](../../packages/core/src/observation.ts#L411) | [mapper](../../packages/web/src/host/map-events.ts#L277) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `queue` (CUSTOM) | `recentChunks`; `queue` |
| `run-ended` | [`EnsoRunEnded`](../../packages/core/src/observation.ts#L462) | [mapper](../../packages/web/src/host/map-events.ts#L368) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.STEP_FINISHED` | TanStack chat state |
| `settled` | [`EnsoSettled`](../../packages/core/src/observation.ts#L473) | [mapper](../../packages/web/src/host/map-events.ts#L371) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.RUN_FINISHED` | TanStack chat state |
| `text-delta` | [`EnsoTextDelta`](../../packages/core/src/observation.ts#L42) | [mapper](../../packages/web/src/host/map-events.ts#L253) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.TEXT_MESSAGE_CONTENT` | TanStack chat state |
| `thinking-delta` | [`EnsoThinkingDelta`](../../packages/core/src/observation.ts#L53) | [mapper](../../packages/web/src/host/map-events.ts#L256) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.REASONING_MESSAGE_CONTENT` | TanStack chat state |
| `tool-call` | [`EnsoToolCall`](../../packages/core/src/observation.ts#L66) | [mapper](../../packages/web/src/host/map-events.ts#L281) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.TOOL_CALL_START`<br>`EventType.TOOL_CALL_ARGS` | TanStack chat state |
| `tool-result` | [`EnsoToolResultObservation`](../../packages/core/src/observation.ts#L84) | [mapper](../../packages/web/src/host/map-events.ts#L292) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) — [ELIDED](../../packages/web/src/server/follow.ts#L146) while `complete: false` | `EventType.TOOL_CALL_RESULT`<br>`dropped` | TanStack chat state<br>nothing consumes the dropped branch |
| `turn-end` | [`EnsoTurnEnd`](../../packages/core/src/observation.ts#L382) | [mapper](../../packages/web/src/host/map-events.ts#L273) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.STEP_FINISHED` | TanStack chat state |
| `turn-start` | [`EnsoTurnStart`](../../packages/core/src/observation.ts#L372) | [mapper](../../packages/web/src/host/map-events.ts#L269) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `EventType.STEP_STARTED` | TanStack chat state |
| `unmapped` | [`EnsoUnmapped`](../../packages/core/src/observation.ts#L485) | [mapper](../../packages/web/src/host/map-events.ts#L187) | [`observation` frame](../../packages/web/src/server/follow.ts#L178) | `unmapped` (CUSTOM) | `recentChunks` only; nothing else consumes it |

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

Inventory: 20 union members; 9 ride CUSTOM by kind; 3 chunks that are not observations; every chunk name has a checked browser classification.
