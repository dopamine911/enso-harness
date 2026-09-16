import { EventType } from '@ag-ui/core'
import type { StreamChunk } from '@tanstack/ai'
import { ZEN_TOOL_RESULT_KEY, type ZenObservation } from '@zen/core'
import {
  ZEN_CUSTOM_EVENT_DIALOG,
  ZEN_CUSTOM_EVENT_DIALOG_SETTLED,
  ZEN_CUSTOM_EVENT_ENTRY,
  ZEN_CUSTOM_EVENT_MODE,
  ZEN_CUSTOM_EVENT_NOTIFY,
  ZEN_CUSTOM_EVENT_QUEUE,
  ZEN_CUSTOM_EVENT_UNMAPPED,
  ZEN_CUSTOM_EVENT_USAGE,
} from './custom-event-names.ts'

/**
 * `ZenObservation` → AG-UI `StreamChunk` (#24, #112).
 *
 * WHERE THIS RUNS, AND WHY
 * TanStack AI's chat client consumes `StreamChunk = AGUIEvent` — the Agent Client protocol
 * from `@ag-ui/core`. That is the client's in-memory chunk vocabulary, not the wire: the wire
 * carries observations (`GET /api/threads/:id/follow`), and the browser's connection adapter
 * (`follow-connection.ts`) runs THIS function on each one before handing the chunks to
 * TanStack. So the pipeline is three hops, the last one inside the page:
 *
 *     pi rpc event  →  ZenObservation  →  AG-UI StreamChunk  →  TanStack client
 *                   ^ map-events.ts    ^ this module, in the browser
 *
 * Nothing serialises the output of this module and nothing stores it (`docs/architecture.md`,
 * decided constraints). A renderer that stops speaking AG-UI deletes it and the adapter.
 *
 * ⚠⚠ WHERE #18's DESCRIPTOR RIDES, AND WHY IT IS NOT `metadata`
 * `ToolCallResultEvent` declares `content: string` and NOTHING ELSE — no metadata field. So
 * the two-surface descriptor cannot travel as metadata on the result the way it does inside
 * TanStack's own `ToolResultPart`.
 *
 * What makes it work is that AG-UI's `BaseEvent` declares `[k: string]: unknown`, so every
 * event accepts extra fields by design rather than by accident. The descriptor rides under
 * the same namespaced key it uses everywhere else, on the result event itself — so a
 * renderer receives text and descriptor together and needs no correlation.
 *
 * ⓘ If an intermediary ever strips unknown fields, the fallback is a `CUSTOM` event
 * (`{name, value}`) correlated by `toolCallId`. Not built, because it costs the renderer a
 * correlation step and nothing today strips them.
 */

/**
 * Identifiers AG-UI requires that pi does not supply.
 *
 * ⚠ AG-UI keys text and reasoning content by `messageId`, and pi's `message_update` carries
 * a `contentIndex` but no message id. A caller therefore has to supply the id for the
 * assistant message currently streaming — which is state this module deliberately does not
 * hold, so that it stays a pure function and the session owner stays the single source of
 * truth for what "the current message" is.
 */
export interface AguiIdentifiers {
  /** The assistant message being streamed. */
  messageId: string
  /** The run these events belong to. Required on RUN_FINISHED and RUN_ERROR. */
  runId: string
  threadId: string
}

/**
 * Map one observation.
 *
 * ⚠ Returns an ARRAY, because the mapping is not one-to-one: a `tool-call` becomes both a
 * `TOOL_CALL_START` and a `TOOL_CALL_ARGS`, and an in-flight tool result becomes nothing at
 * all — AG-UI has no partial-result event, so accumulated output before completion has
 * nowhere to go.
 *
 * ⚠⚠ That last point is a real loss and it is not worked around here. pi streams
 * `tool_execution_update` with accumulated output; AG-UI's tool vocabulary is
 * start/args/end/result with no progress event. Emitting a `TOOL_CALL_RESULT` per update
 * would tell the client the tool finished repeatedly. So partial output is dropped on this
 * hop, and long-running bash output will appear only when the tool completes. The fix is a
 * `CUSTOM` progress event the renderer understands; it is not built, and pretending
 * otherwise by faking a result would be worse than the gap.
 */
export function observationToAguiEvents(observation: ZenObservation, ids: AguiIdentifiers): StreamChunk[] {
  switch (observation.kind) {
    case 'text-delta':
      return [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: ids.messageId,
          delta: observation.delta,
        },
      ]

    case 'thinking-delta':
      // REASONING_*, not THINKING_* — the latter is deprecated in @ag-ui/core and slated
      // for removal in 1.0.0.
      return [
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: ids.messageId,
          delta: observation.delta,
        },
      ]

    case 'tool-call':
      return [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: observation.toolCallId,
          toolCallName: observation.toolName,
          parentMessageId: ids.messageId,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: observation.toolCallId,
          delta: JSON.stringify(observation.args ?? {}),
        },
      ]

    case 'tool-result': {
      // ⚠ Partial results are dropped — see the function header. Emitting a result per
      // update would tell the client the tool finished, repeatedly.
      if (!observation.complete) return []
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: ids.messageId,
          toolCallId: observation.toolCallId,
          content: observation.text,
          role: 'tool',
          // The descriptor, under the same namespaced key it uses everywhere else.
          // Legal because AG-UI's BaseEvent declares `[k: string]: unknown`.
          ...(observation.descriptor === undefined ? {} : { [ZEN_TOOL_RESULT_KEY]: observation.descriptor }),
          // ⚠ `isError` has no AG-UI field on a tool result, and it is the only signal a
          // REFUSED or ABORTED call has (a guard block; pi's abort mid-tool). TanStack's
          // processor reads `state: "output-error"` off the chunk (a non-spec extra, legal
          // as above) and marks the result and its call `error`, with the content as the
          // error text — the same shape `branch-to-messages` builds from the log, so a
          // live transcript and a resumed one agree (#130). Before this the flag rode as
          // `zenIsError`, which nothing read: live said done, resume said error.
          ...(observation.isError ? { state: 'output-error' } : {}),
        },
      ]
    }

    case 'extension-ui-request':
      // A blocking question the browser can render crosses whole as `zen.dialog` (#112):
      // the adapter's dialog store shows it, and the answer is a unary POST — no
      // interrupt, no run boundary. The run keeps going on the follow meanwhile.
      if (observation.blocking && observation.dialog !== undefined && observation.id.length > 0) {
        return [
          {
            type: EventType.CUSTOM,
            name: ZEN_CUSTOM_EVENT_DIALOG,
            value: { id: observation.id, dialog: observation.dialog },
          },
        ]
      }
      // ⚠ THE DEGENERATE CASE: a blocking request whose fields did not form a
      // `ZenDialogSpec` (or that carried no id). The connection declines it on pi's
      // behalf so the extension is not left hanging; the user still has to be told, or
      // a command that silently did nothing reads as a command that worked.
      //
      // ⚠ THE TENSE IS LOAD-BEARING AND IT WAS WRONG ONCE. An earlier version told the
      // user pi was STILL waiting — true of the state that motivated the fix, false of
      // the state after it, because the declining happens beside this line. So it
      // reported a hung agent at the exact moment the run was completing normally.
      // Describe the state a reader is in, not the one that made the code necessary.
      if (observation.blocking) {
        return [
          {
            type: EventType.RUN_ERROR,
            runId: ids.runId,
            message:
              `pi asked an interactive '${observation.method}' question (id ${observation.id}) ` +
              `whose content this surface could not read, so it was declined and the ` +
              `command did nothing.`,
          },
        ]
      }
      // `notify` carries a message meant for a HUMAN, so it crosses.
      if (observation.method === 'notify') {
        return [{ type: EventType.CUSTOM, name: ZEN_CUSTOM_EVENT_NOTIFY, value: observation }]
      }
      // ⚠ Everything else fire-and-forget — setStatus, setWidget, setTitle,
      // set_editor_text — is dropped, and the justification is NOT "we do not recognise
      // it". These are addressed to a TERMINAL: powerline widgets, LSP status lines,
      // editor text. A browser has no use for them, and forwarding them floods the
      // stream — measured at 40 of 43 events for a one-word prompt.
      //
      // That is the one legitimate reason to drop: the event is addressed to a different
      // surface. It is not the `unmapped` case, which exists for events we simply do not
      // model yet and which are always carried.
      return []

    case 'extension-error':
      return [
        {
          type: EventType.RUN_ERROR,
          runId: ids.runId,
          message: `${observation.extensionPath} failed on ${observation.event}: ${observation.error}`,
        },
      ]

    case 'run-ended':
      // ⚠ NOT RUN_FINISHED. `agent_end` is one low-level run and may be followed by an
      // automatic retry; telling the client the run finished here would show completion
      // mid-retry. STEP_FINISHED is the closest honest mapping.
      return [
        {
          type: EventType.STEP_FINISHED,
          stepName: observation.willRetry ? 'agent-run-will-retry' : 'agent-run',
        },
      ]

    case 'settled':
      return [
        {
          type: EventType.RUN_FINISHED,
          threadId: ids.threadId,
          runId: ids.runId,
        },
      ]

    case 'message-start':
      // The AG-UI view opens ONE assistant message per run (`TEXT_MESSAGE_START` at run
      // start) and closes it at settle, so per-message boundaries have no place in it —
      // the same acknowledged loss as partial tool output above. The follow carries them.
      return []

    case 'message-end':
      // One completed message's accounting (#45) — the thread-stats bar sums these.
      // CUSTOM because AG-UI has no usage vocabulary; the value is the whole observation
      // so the consumer reads `role` and `usage` off one shape declared in @zen/core. A
      // boundary without spend has nothing for this view.
      return observation.usage === undefined
        ? []
        : [
            {
              type: EventType.CUSTOM,
              name: ZEN_CUSTOM_EVENT_USAGE,
              value: observation,
            },
          ]

    case 'turn-start':
      return [{ type: EventType.STEP_STARTED, stepName: 'turn' }]

    case 'turn-end':
      return [{ type: EventType.STEP_FINISHED, stepName: 'turn' }]

    case 'queue':
      // Queue depth (#75). CUSTOM: AG-UI has no queue vocabulary.
      return [
        {
          type: EventType.CUSTOM,
          name: ZEN_CUSTOM_EVENT_QUEUE,
          value: observation,
        },
      ]

    case 'prompt-rejected':
      // pi refused the prompt at preflight (#112) — the run the client thinks it started never
      // did. A run error, so the client shows why instead of a spinner that never ends.
      return [{ type: EventType.RUN_ERROR, runId: ids.runId, message: observation.reason }]

    case 'dialog-settled':
      // The question stopped waiting (#114). CUSTOM: nothing on the run ended for it,
      // exactly as nothing started for the question. The browser drops the card by id.
      return [
        {
          type: EventType.CUSTOM,
          name: ZEN_CUSTOM_EVENT_DIALOG_SETTLED,
          value: { id: observation.id, outcome: observation.outcome },
        },
      ]

    case 'permission-mode':
      // The mode changed mid-run (L3): the same `zen.mode` chunk the run-start receipt
      // rides, with the same `{ mode, available }` value — one chunk, one shape, whether
      // the mode was read at start or changed since. The browser's mode store and the
      // transcript's mode line both fold this and nothing else.
      return [
        {
          type: EventType.CUSTOM,
          name: ZEN_CUSTOM_EVENT_MODE,
          value: { mode: observation.mode, available: observation.available },
        },
      ]

    case 'permission-mode-rejected':
      // The click did nothing and the user must be told (L3 step C): a warning notice,
      // through the same `zen.notify` chunk an extension's own notice rides, so the
      // notifications store renders it with no shape of its own.
      return [
        {
          type: EventType.CUSTOM,
          name: ZEN_CUSTOM_EVENT_NOTIFY,
          value: {
            message: `mode change to ${observation.mode} rejected: ${observation.reason}`,
            notifyType: 'warning',
            origin: 'run',
          },
        },
      ]

    case 'custom-entry':
      // An extension persisted state (#29) — a receipt, recorded and counted (the debug
      // pane's chunk tally) but rendered by nothing since L3 moved the mode onto its own
      // observation. Rides CUSTOM for the same reason unmapped does, below. ⚠ The value is
      // the whole observation, so a consumer dispatches on `customType` rather than on a
      // per-type chunk name — one chunk name per vendor entry type would put vendor
      // knowledge in the transport.
      return [
        {
          type: EventType.CUSTOM,
          name: ZEN_CUSTOM_EVENT_ENTRY,
          value: observation,
        },
      ]

    case 'unmapped':
      // ⚠ CUSTOM, not RAW. `@ag-ui/core` defines a RAW event and it looks made for this —
      // but TanStack NARROWS `AGUIEvent`, and RAW is not in the narrowed union, so a RAW
      // event is not a valid `StreamChunk`. Found by removing an `as unknown as
      // StreamChunk` cast: the cast compiled and would have put an event on the wire that
      // TanStack's client does not accept. CUSTOM is in the union and is the documented
      // extension point.
      //
      // The design rule from map-events.ts therefore survives the second hop: an
      // unrecognised event is carried, never discarded.
      return [
        {
          type: EventType.CUSTOM,
          name: ZEN_CUSTOM_EVENT_UNMAPPED,
          value: observation.event,
        },
      ]
  }
}
