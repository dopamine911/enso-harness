import { type EnsoToolResultDescriptor, readEnsoToolResultDescriptor } from '@enso/core'
import type { ToolResultPart } from '@tanstack/ai'
import { useContext } from 'react'
import { constantStore, ThreadStoresContext, useStore } from './store.ts'

/**
 * The web renderer for a enso tool result — the React half of #18's contract.
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

/**
 * Renderers keyed by descriptor `kind`. Absent keys are not an error — see the fallback. A renderer
 * declines a descriptor by returning `null`, `undefined`, a boolean or `''`, and the text is shown
 * instead of a blank box. Only those values are seen: an empty array or fragment, or an element
 * whose component renders `null`, is drawn as given — a renderer that declines returns `null`.
 */
export type EnsoRendererMap = Record<string, (props: Record<string, unknown>) => React.ReactNode>

/**
 * What one tool call is in, read off its result — the ONE definition.
 *
 * Pending is "no result has paired yet" — TanStack's own selection pairs results to calls
 * across the whole message list — WHILE the message's run is still open. The same absence once
 * the run has ended is `aborted` (#130): pi emits no result for a call its abort interrupted
 * (and a torn tail on resume has none either), so without the run's state a stopped call read
 * `running…` forever — a state presented as live when it is not (`architecture.md`, invariant
 * 5). Error is the envelope's `error`, not the descriptor's — or `state: 'error'` with no `error`
 * field, which TanStack's `updateToolResultPart` produces when the error is empty; its reason is
 * then the string content. The step row, the status bar's
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
  if (result.state === 'error') {
    return { status: 'error', result, error: typeof result.content === 'string' ? result.content : '' }
  }
  return { status: 'done', result }
}

/**
 * How one tool's text result reads for a person (#920) — `bash`'s output as a terminal, `read`'s line
 * count over a folded preview — given by the step row for the tool it draws. Absent, the text prints
 * as it came.
 */
export type ToolTextView = (text: string) => React.ReactNode

function TextFallback({ result, view }: { result: ToolResultPart; view: ToolTextView | undefined }): React.ReactNode {
  // `content` is `string | ContentPart[]`; only the string form is safe to print directly.
  const text =
    typeof result.content === 'string' ? result.content : result.content.map((part) => JSON.stringify(part)).join('\n')
  if (view !== undefined) return <div data-enso-tool-result="text">{view(text)}</div>
  return (
    <pre
      data-enso-tool-result="text"
      className="max-h-60 overflow-y-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
    >
      {text}
    </pre>
  )
}

function TruncationNote({
  truncated,
}: {
  truncated: NonNullable<EnsoToolResultDescriptor['truncated']>
}): React.ReactNode {
  // Rendered here, from data — the terminal renders the same fields differently.
  return (
    <p data-enso-truncation className="text-xs text-muted-foreground">
      showing {truncated.shown} of {truncated.total} {truncated.unit}
    </p>
  )
}

const NO_DESCRIPTORS = constantStore<ReadonlyMap<string, EnsoToolResultDescriptor>>(new Map())

/**
 * A result's #18 descriptor: the one the follow connection handed the thread's store LIVE (#411 —
 * TanStack keeps none on the part), else the one a stored result carries in its metadata.
 */
function useDescriptor(result: ToolResultPart | undefined): EnsoToolResultDescriptor | undefined {
  const stores = useContext(ThreadStoresContext)
  const live = useStore(stores?.toolResultDescriptors ?? NO_DESCRIPTORS)
  if (result === undefined) return undefined
  return live.get(result.toolCallId) ?? readEnsoToolResultDescriptor(result.metadata)
}

export function EnsoToolResult({
  result,
  runOpen,
  renderers,
  view,
}: {
  /**
   * ⚠ Explicitly `| undefined` rather than optional. `exactOptionalPropertyTypes` is on,
   * so `result?: T` would reject a caller passing a `T | undefined` it holds — and an
   * absent result is a real state here (the call is in flight), not an omitted prop.
   */
  result: ToolResultPart | undefined
  /** The call's run is still in flight — see {@link toolResultState}. */
  runOpen: boolean
  renderers: EnsoRendererMap
  /** The tool's own reading of a text result, when no descriptor renderer draws it. */
  view?: ToolTextView | undefined
}): React.ReactNode {
  const state = toolResultState(result, runOpen)
  const descriptor = useDescriptor(result)
  // No result yet — the call is in flight. Say so rather than rendering nothing; in words and colour,
  // not a pulse (#739: an animation keeps the compositor ticking for as long as the call runs).
  if (state.status === 'pending') {
    return (
      <p data-enso-tool-result="pending" className="text-xs text-evidence">
        running…
      </p>
    )
  }
  // No result and the run is over (#130): the call was interrupted — by a stop, the
  // server going away, or a torn tail on resume. Muted, not the running colour; the words say why.
  if (state.status === 'aborted') {
    return (
      <p data-enso-tool-result="aborted" className="text-xs text-muted-foreground">
        aborted — the run ended before this call returned
      </p>
    )
  }

  // An errored result is the envelope's business, not the descriptor's. It WRAPS: it is usually
  // a sentence — a guard's denial names its rule and says why — and on one scrolling line the
  // reason sat past the box's edge behind a scrollbar that only shows on hover. Line breaks the
  // error carries (a stderr) are kept.
  if (state.status === 'error') {
    return (
      <pre data-enso-tool-result="error" className="font-mono text-xs break-words whitespace-pre-wrap text-refuse">
        {state.error}
      </pre>
    )
  }

  if (descriptor === undefined) return <TextFallback result={state.result} view={view} />

  // A renderer that draws nothing — its props did not check (a stored descriptor from another
  // version, a tool's malformed one) — is an unknown kind too (#920): the text, never a blank.
  const drawn = renderers[descriptor.kind]?.(descriptor.props)
  // ⚠ Unknown kind: fall through to text. This is the branch that makes an unrecognised
  // descriptor visible instead of blank, and it is the one worth a test. The truncation is data,
  // not the renderer's (#411): it is said under the text too — the text of every pi tool's
  // truncated result lands here.
  // A decline is any of the empty values `EnsoRendererMap` lists, not only `null`.
  if (drawn === undefined || drawn === null || typeof drawn === 'boolean' || drawn === '') {
    return (
      <div data-enso-kind={descriptor.kind}>
        <TextFallback result={state.result} view={view} />
        {descriptor.truncated !== undefined ? <TruncationNote truncated={descriptor.truncated} /> : null}
      </div>
    )
  }

  return (
    <div data-enso-tool-result="descriptor" data-enso-kind={descriptor.kind}>
      {drawn}
      {descriptor.truncated !== undefined ? <TruncationNote truncated={descriptor.truncated} /> : null}
    </div>
  )
}
