import { summarizeToolInput } from '@enso/core'
// ⚠ Only `TextPart` crosses from the package's renderers. `ThinkingPart` looked like its
// sibling but renders PLAIN text inside hardcoded off-theme chrome — the Reasoning shell
// in `ai-elements/reasoning.tsx` replaces it (see that file's header).
import type { ChatUISelectedPart, ChatUISelectedToolPart } from '@tanstack/ai-client/ui'
import { TextPart } from '@tanstack/ai-react/ui'
import { ChevronRightIcon, CircleCheckIcon, CircleSlashIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react'
import { Reasoning, ReasoningContent, ReasoningTrigger } from './components/ai-elements/reasoning.tsx'
import { type EnsoRendererMap, EnsoToolResult, type ToolResultState, toolResultState } from './EnsoToolResult.tsx'
import { GuardRefusal, useGuardDenial } from './guard-refusal.tsx'
import { cn } from './lib/utils.ts'
import { TEXT_PART_COMPONENTS } from './markdown-image.tsx'

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

/** The call's input carries a `command` — a shell line, which Ledger prints after a `$ ` (#407). */
function isCommandInput(input: unknown): boolean {
  return typeof input === 'object' && input !== null && 'command' in input
}

/** A result's text, as the fallback renderer prints it; undefined before the result lands. */
function resultText(result: ChatUISelectedToolPart['result']): string | undefined {
  if (result === undefined) return undefined
  if (typeof result.content === 'string') return result.content
  return result.content.map((part) => JSON.stringify(part)).join('\n')
}

/** The glyph before a step: a check, a cross, the spinner while pi runs it, a slash once cut off. */
const STEP_GLYPH: Record<ToolResultState['status'], React.ReactNode> = {
  pending: <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-evidence" />,
  aborted: <CircleSlashIcon className="size-4 shrink-0 text-muted-foreground" />,
  done: <CircleCheckIcon className="size-4 shrink-0 text-ok" />,
  error: <CircleXIcon className="size-4 shrink-0 text-refuse" />,
}

/** The state word at the row's end, in the state's colour. A finished step says nothing more. */
const STEP_WORD: Record<ToolResultState['status'], React.ReactNode> = {
  pending: <span className="text-evidence">running…</span>,
  aborted: <span className="text-muted-foreground">aborted</span>,
  done: null,
  error: <span className="text-refuse">error</span>,
}

/**
 * A tool call as one compact row — `✓ read  packages/web/src/x.ts  ›` — with IN and OUT folded
 * beneath it (#90 PR 2; Copilot Chat's step rows are the reference, the design direction's step
 * row the look). What the agent is doing reads step by step instead of as a wall of output.
 * Done/pending/error is `toolResultState`, the one definition the status bar and
 * `EnsoToolResult` also read; an error opens itself, and outlines the row in the refusal colour,
 * because a failure behind a click is a failure missed.
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
  // A guard refused it (#387): a receipt, drawn as one — not a failed step with the word `error`.
  const refusedBy = useGuardDenial(selected.part.id)
  if (refusedBy !== undefined) {
    return (
      <GuardRefusal
        toolCallId={selected.part.id}
        toolName={selected.part.name}
        asked={summary}
        asCommand={isCommandInput(input)}
        reason={resultText(selected.result)}
        rule={refusedBy}
      />
    )
  }
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
      className={cn(
        'group my-1 max-w-3xl rounded-md border bg-card ledger:rounded-xs',
        // Ink (#407): marginalia — a finished step is a ruled line in the margin, not a box; an
        // error keeps its box, because a failure behind a click is a failure missed.
        status === 'error'
          ? 'border-refuse'
          : 'ink:rounded-none ink:border-transparent ink:border-b-border ink:bg-transparent',
      )}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-3 marker:hidden hover:bg-popover">
        <span aria-hidden="true">{STEP_GLYPH[status]}</span>
        <span className="shrink-0 font-mono text-sm">{selected.part.name}</span>
        {/* `min-w-0`: a flex child's default `min-width: auto` never shrinks below its
				    content, so without it `truncate` cannot engage (PR #93 review). */}
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">{summary}</span>
        <span className="shrink-0 text-xs font-semibold tracking-wider uppercase">{STEP_WORD[status]}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
      </summary>
      <dl className="grid grid-cols-label-value border-t font-mono text-sm ink:bg-card">
        <dt className="px-3 py-2 text-xs leading-6 font-semibold text-muted-foreground uppercase">in</dt>
        <dd className="min-w-0 px-3 py-2">
          <pre className="max-h-56 overflow-y-auto break-words whitespace-pre-wrap">
            {input === undefined ? selected.part.arguments : JSON.stringify(input, null, 2)}
          </pre>
        </dd>
        <dt className="border-t border-dashed px-3 py-2 text-xs leading-6 font-semibold text-muted-foreground uppercase">
          out
        </dt>
        {/* ⚠ THE INTEGRATION POINT #18 EXISTS FOR. Every tool result renders through
				    `EnsoToolResult`: the descriptor is read from the result's metadata, and an
				    absent result (the call is still in flight) renders the visible pending state. */}
        <dd className="min-w-0 border-t border-dashed px-3 py-2">
          <EnsoToolResult result={selected.result} runOpen={runOpen} renderers={renderers} />
        </dd>
      </dl>
    </details>
  )
}

/** The collapsible Reasoning shell around the thinking text. */
function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }): React.ReactNode {
  return (
    <Reasoning isStreaming={isStreaming} className="mb-1">
      <ReasoningTrigger className="-ml-2 min-h-8 w-fit rounded-md px-2 hover:bg-popover" />
      <ReasoningContent className="mt-1 border-l-2 pl-4 leading-relaxed">{content}</ReasoningContent>
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
      <div className="prose max-w-none leading-relaxed dark:prose-invert prose-headings:font-heading prose-p:my-3 [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0">
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
    <pre className="overflow-x-auto rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
      {selected.part.type}: {JSON.stringify(selected.part)}
    </pre>
  )
}
