import type { ToolResultPart } from '@tanstack/ai'
import { readZenToolResultDescriptor, type ZenToolResultDescriptor } from '@zen/core'

/**
 * The web renderer for a zen tool result — the React half of #18's contract.
 *
 * Shaped to be usable as a `toolsComponents` entry in TanStack AI's `createChatUI`, whose
 * `ToolProps` is `{ part, result?, interrupt? }`. We take only `result` so this stays
 * testable without constructing a full chat-UI options type.
 *
 * ⚠ THE FALLBACK IS THE POINT, NOT A COURTESY
 * An unknown `kind` renders the envelope's `content`. A type-tag design's characteristic
 * failure is an unrenderable payload displaying as nothing — which looks identical to a
 * successful empty result. Every early return below ends in visible output.
 */

/** Renderers keyed by descriptor `kind`. Absent keys are not an error — see the fallback. */
export type ZenRendererMap = Record<string, (props: Record<string, unknown>) => React.ReactNode>

/**
 * What one tool call is in, read off its result — the ONE definition (PR #93 review).
 *
 * Pending is "no result has paired yet" — TanStack's own selection pairs results to calls
 * across the whole message list — WHILE the message's run is still open. The same absence once
 * the run has ended is `aborted` (#130): pi emits no result for a call its abort interrupted
 * (and a torn tail on resume has none either), so without the run's state a stopped call read
 * `running…` forever — a state presented as live when it is not (`architecture.md`, invariant
 * 5). Error is the envelope's `error`, not the descriptor's. The step row, the status bar's
 * `running <tool>`, and this renderer all read this; a fifth state is added here and nowhere
 * else. The narrowed result rides along so a consumer that branches on `status` has it typed
 * for that branch.
 */
export type ToolResultState =
  | { readonly status: 'pending' }
  | { readonly status: 'aborted' }
  | { readonly status: 'error'; readonly result: ToolResultPart; readonly error: string }
  | { readonly status: 'done'; readonly result: ToolResultPart }

/** `runOpen`: the run this call belongs to is still in flight — the caller knows (`sessionGenerating && isLastMessage`), the result cannot. */
export function toolResultState(result: ToolResultPart | undefined, runOpen: boolean): ToolResultState {
  if (result === undefined) return runOpen ? { status: 'pending' } : { status: 'aborted' }
  if (result.error !== undefined) return { status: 'error', result, error: result.error }
  return { status: 'done', result }
}

function TextFallback({ result }: { result: ToolResultPart }): React.ReactNode {
  // `content` is `string | ContentPart[]`; only the string form is safe to print directly.
  const text =
    typeof result.content === 'string' ? result.content : result.content.map((part) => JSON.stringify(part)).join('\n')
  return (
    <pre data-zen-tool-result="text" className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
      {text}
    </pre>
  )
}

function TruncationNote({
  truncated,
}: {
  truncated: NonNullable<ZenToolResultDescriptor['truncated']>
}): React.ReactNode {
  // Rendered here, from data — the terminal renders the same fields differently.
  return (
    <p data-zen-truncation className="text-muted-foreground text-xs">
      showing {truncated.shown} of {truncated.total} {truncated.unit}
    </p>
  )
}

export function ZenToolResult({
  result,
  runOpen,
  renderers,
}: {
  /**
   * ⚠ Explicitly `| undefined` rather than optional. `exactOptionalPropertyTypes` is on,
   * so `result?: T` would reject a caller passing a `T | undefined` it holds — and an
   * absent result is a real state here (the call is in flight), not an omitted prop.
   */
  result: ToolResultPart | undefined
  /** The call's run is still in flight — see {@link toolResultState}. */
  runOpen: boolean
  renderers: ZenRendererMap
}): React.ReactNode {
  const state = toolResultState(result, runOpen)
  // No result yet — the call is in flight. Say so rather than rendering nothing.
  if (state.status === 'pending') {
    return (
      <p data-zen-tool-result="pending" className="animate-pulse text-muted-foreground text-xs">
        running…
      </p>
    )
  }
  // No result and the run is over (#130): the call was interrupted — by a stop, the
  // server going away, or a torn tail on resume. Still, not pulsing; the words say why.
  if (state.status === 'aborted') {
    return (
      <p data-zen-tool-result="aborted" className="text-muted-foreground text-xs">
        aborted — the run ended before this call returned
      </p>
    )
  }

  // An errored result is the envelope's business, not the descriptor's.
  if (state.status === 'error') {
    return (
      <pre
        data-zen-tool-result="error"
        className="overflow-x-auto rounded-md border border-destructive/50 bg-destructive/10 p-3 font-mono text-destructive text-xs"
      >
        {state.error}
      </pre>
    )
  }

  const descriptor = readZenToolResultDescriptor(state.result.metadata)
  if (descriptor === undefined) return <TextFallback result={state.result} />

  const render = renderers[descriptor.kind]
  // ⚠ Unknown kind: fall through to text. This is the branch that makes an unrecognised
  // descriptor visible instead of blank, and it is the one worth a test.
  if (render === undefined) return <TextFallback result={state.result} />

  return (
    <div data-zen-tool-result="descriptor" data-zen-kind={descriptor.kind}>
      {render(descriptor.props)}
      {descriptor.truncated !== undefined ? <TruncationNote truncated={descriptor.truncated} /> : null}
    </div>
  )
}
