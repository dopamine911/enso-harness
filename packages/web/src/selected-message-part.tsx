// ⚠ Only `TextPart` crosses from the package's renderers. `ThinkingPart` looked like its
// sibling but renders PLAIN text inside hardcoded off-theme chrome — the Reasoning shell
// in `ai-elements/reasoning.tsx` replaces it (see that file's header).

import type { ChatUISelectedPart, ChatUISelectedToolPart } from '@tanstack/ai-client/ui'
import { TextPart, type TextPartProps } from '@tanstack/ai-react/ui'
import { Reasoning, ReasoningContent, ReasoningTrigger } from './components/ai-elements/reasoning.tsx'
import { type EnsoRendererMap, EnsoToolResult, type ToolResultState, toolResultState } from './EnsoToolResult.tsx'
import { MarkdownImage } from './markdown-image.tsx'

/** The intrinsic elements `TextPart` renders through ours — a remote image waits for a click (`markdown-image.tsx`). */
const TEXT_PART_COMPONENTS: NonNullable<TextPartProps['components']> = { img: MarkdownImage }

/**
 * The argument a step row is summarised by, in precedence. Each of pi's built-ins and the
 * harness tools names its subject one of these ways: bash `command`, grep/find `pattern`,
 * read/write/edit/ls `path`, web_search `query`, web_fetch `url`. `pattern` precedes `path`
 * because grep and find carry both and the pattern is what you would ask about. A tool
 * that names its subject some other way (an MCP tool, say) falls back to its first string
 * argument — a guess, but a visible one, better than a bare name.
 */
const SUMMARY_KEYS = ['command', 'pattern', 'path', 'query', 'url'] as const
/** One line of a step row; a multi-line bash command shows its first line and an ellipsis. */
const SUMMARY_MAX_CHARS = 80

/** The head of the first line; an ellipsis whenever that is less than the whole value. */
function clipToOneLine(value: string): string {
  const head = (value.split('\n', 1)[0] ?? '').slice(0, SUMMARY_MAX_CHARS)
  return head.length < value.length ? `${head}…` : head
}

/** The one-line subject of a tool call, or undefined when its input names nothing usable. */
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) return clipToOneLine(candidate)
  }
  for (const candidate of Object.values(record)) {
    if (typeof candidate === 'string' && candidate.length > 0) return clipToOneLine(candidate)
  }
  return undefined
}

/**
 * The call's input as an object. TanStack parses it onto the selected part once the
 * arguments finish streaming; before that only the raw (possibly partial) JSON string
 * exists, so a parse failure here is the normal mid-stream state, not an error.
 */
function readToolInput(selected: ChatUISelectedToolPart): unknown {
  if (selected.input !== undefined) return selected.input
  try {
    return JSON.parse(selected.part.arguments)
  } catch {
    return undefined
  }
}

const STEP_DOT: Record<ToolResultState['status'], string> = {
  pending: 'size-2 shrink-0 animate-pulse rounded-full bg-foreground',
  aborted: 'size-2 shrink-0 rounded-full border border-muted-foreground/60',
  done: 'size-2 shrink-0 rounded-full bg-muted-foreground/60',
  error: 'size-2 shrink-0 rounded-full bg-destructive',
}

/**
 * A tool call as one compact row — `● read  packages/web/src/x.ts` — with IN and OUT folded
 * beneath it (#90 PR 2; Copilot Chat's step rows are the reference). What the agent is
 * doing reads step by step instead of as a wall of output. Done/pending/error is
 * `toolResultState`, the one definition the status bar and `EnsoToolResult` also read; an
 * error opens itself, because a failure behind a click is a failure missed.
 */
function ToolCallRow({
  selected,
  runOpen,
  renderers,
}: {
  selected: ChatUISelectedToolPart
  runOpen: boolean
  renderers: EnsoRendererMap
}): React.ReactNode {
  const input = readToolInput(selected)
  const summary = summarizeToolInput(input)
  const { status } = toolResultState(selected.result, runOpen)
  return (
    // Only an error opens itself: its body is a reason the reader needs (the guard's refusal,
    // the command's stderr). `aborted` has nothing more inside — its whole story is the one
    // word on the row (the run ended first), so opening it would show a static line.
    // `data-tool-call-id`: where the stats drawer's rows land (#359) — the one key a live run's
    // bubble and a resumed thread's share (`transcript-reveal.ts`).
    <details
      data-enso-tool-call={status}
      data-tool-call-id={selected.part.id}
      open={status === 'error'}
      className="group my-1"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 font-mono text-muted-foreground text-xs marker:hidden">
        <span aria-hidden="true" className={STEP_DOT[status]} />
        <span className="text-foreground">{selected.part.name}</span>
        {/* `min-w-0`: a flex child's default `min-width: auto` never shrinks below its
				    content, so without it `truncate` cannot engage (PR #93 review). */}
        {summary === undefined ? null : <span className="min-w-0 truncate">{summary}</span>}
        {status === 'pending' ? <span>running…</span> : null}
        {status === 'aborted' ? <span>aborted</span> : null}
        {status === 'error' ? <span className="text-destructive">error</span> : null}
      </summary>
      <div className="mt-1 ml-1 flex flex-col gap-1 border-l pl-3">
        <div className="font-mono text-muted-foreground text-xs uppercase">in</div>
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
          {input === undefined ? selected.part.arguments : JSON.stringify(input, null, 2)}
        </pre>
        <div className="font-mono text-muted-foreground text-xs uppercase">out</div>
        {/* ⚠ THE INTEGRATION POINT #18 EXISTS FOR. Every tool result renders through
				    `EnsoToolResult`: the descriptor is read from the result's metadata, and an
				    absent result (the call is still in flight) renders the visible pending state. */}
        <EnsoToolResult result={selected.result} runOpen={runOpen} renderers={renderers} />
      </div>
    </details>
  )
}

/** The collapsible Reasoning shell around the thinking text. */
function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }): React.ReactNode {
  return (
    <Reasoning isStreaming={isStreaming}>
      <ReasoningTrigger />
      <ReasoningContent>{content}</ReasoningContent>
    </Reasoning>
  )
}

/**
 * The per-part dispatcher — ours, on the library's own selection. A leaf module with no
 * dependency on the `createChatHook` factory, so it is directly testable.
 *
 * ⚠ WHY THE BOUND `Parts` COMPONENT IS NOT USED (found by the fixture, 2026-09-03):
 * TanStack's dispatcher routes every `toolCall` selected part EXCLUSIVELY to
 * `toolsComponents[name]` — an exact-name lookup with NO fallback — and a miss renders
 * NOTHING beyond a console warning ("Missing tools.bash component"). pi's tool set is
 * dynamic (extensions, MCP servers), so no static name map can be complete, and an
 * unanticipated tool vanishing silently is exactly the failure mode this page refuses
 * everywhere else. (`partsComponents.toolCall` is admitted by the TYPE but unreachable
 * in the dispatcher — noted as an upstream mismatch in the #31 PR.)
 *
 * So the `message` slot in main.tsx runs the library's OWN selection pipeline —
 * `selectChatUI` pairs each tool result to its call across the whole message list
 * (`result` rides on the selected part), `automaticPartsForMessage` drops the paired
 * duplicates — and this switch does only the last hop, part → component. This is not the
 * hand-rolled chat of mistake 1 in main.tsx's header: the vocabulary, pairing and
 * ordering are TanStack's exported selectors; only the final dispatch table is ours, so
 * an unknown TOOL renders through the mandatory textual contract and an unknown PART
 * KIND falls through to the visible debug block.
 *
 * `isStreaming` is true only for the trailing part of the trailing message while a run
 * is in flight — the caller computes it, because only the caller can see the whole list.
 * `runOpen` is coarser: the message's run is in flight at all (#130). A tool call reads
 * that one — two calls in one message are both live while the run is, and only the
 * second is trailing — so a call with no result is `running…` while the run is open and
 * `aborted` once it is not.
 */
export function SelectedMessagePart({
  selected,
  isStreaming,
  runOpen,
  renderers,
}: {
  selected: ChatUISelectedPart
  isStreaming: boolean
  runOpen: boolean
  renderers: EnsoRendererMap
}): React.ReactNode {
  if (selected.key === 'toolCall') return <ToolCallRow selected={selected} runOpen={runOpen} renderers={renderers} />
  // An UNMATCHED result (its call never streamed — a protocol wrinkle, not a normal
  // state) still renders through the same contract rather than vanishing.
  if (selected.key === 'toolResult') {
    return <EnsoToolResult result={selected.part} runOpen={runOpen} renderers={renderers} />
  }
  // TextPart is the markdown pipeline of record (`@tanstack/markdown`: raw HTML escaped,
  // executable URLs dropped; a remote image behind a click, ours). `prose` is
  // @tailwindcss/typography — TextPart emits bare markdown HTML with no classes of its own, so
  // the typography plugin is what styles it.
  if (selected.part.type === 'text') {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <TextPart components={TEXT_PART_COMPONENTS} content={selected.part.content} />
      </div>
    )
  }
  if (selected.part.type === 'thinking') {
    return <ThinkingBlock content={selected.part.content} isStreaming={isStreaming} />
  }
  // The user's image (#68): inline bytes, as the composer sent it and as pi stored it — the
  // snapshot carries the same part back on reload. A `url` source falls through to the
  // visible block below: nothing on this wire produces one, and rendering a remote URL
  // would be a fetch this page never asked for.
  if (selected.part.type === 'image' && selected.part.source.type === 'data') {
    return (
      <img
        alt="attached by the user"
        className="my-2 max-h-96 max-w-full rounded-md border"
        src={`data:${selected.part.source.mimeType};base64,${selected.part.source.value}`}
      />
    )
  }
  // ⚠ An unhandled part kind renders VISIBLY rather than vanishing. `audio`, `video`,
  // `document`, `structuredOutput` and `uiResource` are all in the vocabulary and it will
  // grow — and a silently skipped part is indistinguishable from one that was never sent.
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/50 p-2 text-muted-foreground text-xs">
      {selected.part.type}: {JSON.stringify(selected.part)}
    </pre>
  )
}
