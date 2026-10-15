import { summarizeToolInput } from '@enso/core'
// ⚠ Only `TextPart` crosses from the package's renderers. `ThinkingPart` looked like its
// sibling but renders PLAIN text inside hardcoded off-theme chrome — the Reasoning shell
// in `ai-elements/reasoning.tsx` replaces it (see that file's header).
import type { ChatUISelectedPart, ChatUISelectedToolPart } from '@tanstack/ai-client/ui'
import { TextPart } from '@tanstack/ai-react/ui'
import { CheckIcon, ChevronRightIcon, CircleDashedIcon, CircleSlashIcon, type LucideIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Reasoning, ReasoningContent, ReasoningTrigger } from './components/ai-elements/reasoning.tsx'
import { type EnsoRendererMap, EnsoToolResult, type ToolResultState, toolResultState } from './EnsoToolResult.tsx'
import { cn } from './lib/utils.ts'
import { TEXT_PART_COMPONENTS } from './markdown-image.tsx'
import { PILL } from './step-pill.ts'
import { ToolRefusal, useToolRefusal } from './tool-refusal.tsx'
import { bashExitCode, ToolInput, toolTextView } from './tool-views.tsx'

/** The raw view's renderers: none, so a result prints as its text (#920). */
const NO_RENDERERS: EnsoRendererMap = {}

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

/**
 * The pill at a step's end (#417, the prototype's `.pill`): its state as a glyph and a word in the
 * state's colour, ringed in that colour — `✓ ok`, `running…`, `error`, `aborted`. A refused step is
 * `ToolRefusal`'s receipt, never a pill here.
 * ⚠ The pending glyph stands still (#739): a spinner keeps the compositor ticking for as long as the
 * step runs; a frozen spinner reads as hung, so pending gets its own static shape.
 */
const STEP_PILL: Record<
  ToolResultState['status'],
  { readonly tone: string; readonly Glyph: LucideIcon; readonly word: string }
> = {
  pending: { tone: 'text-evidence', Glyph: CircleDashedIcon, word: 'running…' },
  aborted: { tone: 'text-muted-foreground', Glyph: CircleSlashIcon, word: 'aborted' },
  done: { tone: 'text-ok', Glyph: CheckIcon, word: 'ok' },
  error: { tone: 'text-refuse', Glyph: XIcon, word: 'error' },
}

/**
 * A step's state pill — {@link STEP_PILL}. A failed `bash` says how it ended (#920): `exited 1`, not
 * just `error` — what the exit means is the output's business.
 */
function StepPill({ status, word }: { status: ToolResultState['status']; word?: string | undefined }): React.ReactNode {
  const pill = STEP_PILL[status]
  return (
    <span className={cn(PILL, pill.tone)}>
      <pill.Glyph aria-hidden="true" className="size-2.5" />
      {word ?? pill.word}
    </span>
  )
}

/**
 * A tool call as one compact row — `›  read  packages/web/src/x.ts  (✓ ok)` — with IN and OUT folded
 * beneath it (#90 PR 2; Copilot Chat's step rows are the reference, the prototype's `details.tool`
 * the look, #417: the chevron leads and turns as the row opens, the state is a pill at the end).
 * What the agent is doing reads step by step instead of as a wall of output.
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
  const state = toolResultState(selected.result, runOpen)
  const { status } = state
  // The model's JSON and the result's text as they came, one click away (#920) — never the default.
  const [raw, setRaw] = useState(false)
  const exitCode = state.status === 'error' && selected.part.name === 'bash' ? bashExitCode(state.error) : undefined
  // Something refused it (#387, #523): a receipt, drawn as one — not a failed step with the word `error`.
  const refusal = useToolRefusal(selected.part.id)
  if (refusal !== undefined) {
    return (
      <ToolRefusal
        toolCallId={selected.part.id}
        toolName={selected.part.name}
        asked={summary}
        asCommand={isCommandInput(input)}
        reason={resultText(selected.result)}
        refusal={refusal}
      />
    )
  }
  return (
    // Only an error opens itself: its body is a reason the reader needs (the guard's refusal,
    // the command's stderr). `aborted` has nothing more inside — its whole story is the one
    // word on the row (the run ended first), so opening it would show a static line.
    // `data-tool-call-id`: where the stats drawer's rows land (#359) — the one key a live run's
    // bubble and a resumed thread's share (`transcript-reveal.ts`).
    // `[[data-tool-call-id]+&]`: a step straight after a step sits 8px under it, not the turn's 12px.
    <details
      data-enso-tool-call={status}
      data-tool-call-id={selected.part.id}
      open={status === 'error'}
      className={cn(
        'group rounded-sm border bg-card ledger:rounded-xs [[data-tool-call-id]+&]:-mt-1',
        // Ink (#407): marginalia — a finished step is a ruled line in the margin, not a box; an
        // error keeps its box, because a failure behind a click is a failure missed.
        status === 'error'
          ? 'border-refuse'
          : 'ink:rounded-none ink:border-transparent ink:border-b-border ink:bg-transparent',
      )}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-detail marker:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-open:rotate-90"
        />
        <span className="shrink-0 font-mono font-semibold">{selected.part.name}</span>
        {/* `min-w-0`: a flex child's default `min-width: auto` never shrinks below its
				    content, so without it `truncate` cannot engage. */}
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{summary}</span>
        <StepPill status={status} word={exitCode === undefined ? undefined : `exited ${exitCode}`} />
      </summary>
      <dl className="relative grid grid-cols-label-value border-t font-mono text-xs leading-relaxed text-muted-foreground ink:bg-card">
        <dt className="px-3 py-3 font-semibold uppercase">in</dt>
        {/* `pr-14`: clear of the `raw` switch in the corner. */}
        <dd className="min-w-0 py-3 pr-14">
          <button
            type="button"
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
            className={cn(
              'absolute top-2 right-3 rounded-xs border px-1.5 text-detail hover:text-foreground',
              raw ? 'border-border-strong text-foreground' : 'text-muted-foreground',
            )}
          >
            raw
          </button>
          {raw || input === undefined ? (
            <pre data-enso-tool-input="raw" className="max-h-60 overflow-y-auto break-words whitespace-pre-wrap">
              {input === undefined ? selected.part.arguments : JSON.stringify(input, null, 2)}
            </pre>
          ) : (
            <ToolInput name={selected.part.name} input={input} />
          )}
        </dd>
        <dt className="border-t border-dashed px-3 py-3 font-semibold uppercase">out</dt>
        {/* ⚠ THE INTEGRATION POINT #18 EXISTS FOR. Every tool result renders through
				    `EnsoToolResult`: the descriptor is read from the result's metadata, and an
				    absent result (the call is still in flight) renders the visible pending state.
				    Raw: no renderer and no tool view, so the result's text prints as it came. */}
        <dd className="min-w-0 border-t border-dashed py-3 pr-3">
          <EnsoToolResult
            result={selected.result}
            runOpen={runOpen}
            renderers={raw ? NO_RENDERERS : renderers}
            view={raw ? undefined : toolTextView(selected.part.name)}
          />
        </dd>
      </dl>
    </details>
  )
}

/**
 * The collapsible Reasoning shell around the thinking text, in the prototype's `details.thought`
 * (#417): a 28px muted summary whose chevron points right and turns down as it opens, then the
 * text behind a 2px rule. The vendored trigger draws a down chevron flipped by `rotate-180`; the
 * classes here re-aim that same icon (`svg:last-child`) instead of replacing the trigger's words.
 */
function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming: boolean }): React.ReactNode {
  return (
    <Reasoning isStreaming={isStreaming} className="mb-0">
      <ReasoningTrigger className="min-h-7 w-fit text-detail [&>svg:last-child]:size-3 [&>svg:last-child]:-rotate-90 [&>svg:last-child]:transition-transform [&>svg:last-child]:duration-150 [&>svg:last-child]:ease-snap data-[state=open]:[&>svg:last-child]:rotate-0" />
      {/* `trimEnd`: the newlines pi leaves after a thought would draw as blank lines inside the rule. */}
      <ReasoningContent className="mt-2 max-w-reading border-l-2 border-border-strong pl-4">
        {content.trimEnd()}
      </ReasoningContent>
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
 * So the transcript runs the library's OWN selection pipeline (`transcript-selection.ts`) —
 * `selectChatUI` pairs each tool result to its call across the whole message list
 * (`result` rides on the selected part), `automaticPartsForMessage` drops the paired
 * duplicates — and this switch does only the last hop, part → component. This is not the
 * hand-rolled chat `thread-pane.tsx`'s header warns against: the vocabulary, pairing and
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
  // the typography plugin is what styles it. Sized as the prototype's (#417): 15px, a prompt at
  // 1.55 in its bubble, pi's prose at 1.65 and no wider than a comfortable line.
  if (selected.part.type === 'text') {
    return (
      <div className="prose max-w-none text-message group-[.is-assistant]:max-w-reading group-[.is-assistant]:leading-relaxed dark:prose-invert prose-headings:font-heading prose-p:my-3 [&>div>:first-child]:mt-0 [&>div>:last-child]:mb-0">
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
