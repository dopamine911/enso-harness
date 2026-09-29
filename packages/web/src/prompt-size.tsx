import { type EnsoSystemPromptDraft, type EnsoSystemPromptPreview, estimateTextTokens } from '@enso/core'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { type EditorDraft, fileBytes } from './prompt-editor-state.ts'
import { fetchSystemPromptPreview, type SystemPromptPreviewRead } from './prompt-library-connection.ts'

/**
 * What a prompt costs, always in view while it is written (#443): the file's bytes, exact; the
 * body's tokens, `≈` — `estimateTextTokens`, the function the Context tab prices system text with —
 * and, once pi has rendered it, its share of the model's window. For a system or append prompt the
 * share is of the WHOLE system prompt pi sends with it (tools and all), and the breakdown under it
 * says where that total comes from: a short prompt that replaces pi's preamble still carries the
 * tool definitions, and the bar must not suggest otherwise.
 *
 * ⚠ Hand-built, not ported: upstream's nearest part, ai-elements `context.tsx`, is a hover card over
 * a conversation's spend (`tokenlens`, the AI SDK's usage type). This is an always-visible line of
 * three numbers over text being edited, and a hover card would hide the one thing it exists to show.
 */

/** pi's rendering of a prompt as the editor has it — none for a session prompt or an empty body. */
export type HeadState = { readonly kind: 'none' } | { readonly kind: 'loading' } | SystemPromptPreviewRead

/** How long typing must pause before the draft is rendered again. */
const DRAFT_PREVIEW_PAUSE_MS = 300

const count = (value: number): string => value.toLocaleString('en')

/** The draft as pi would render it, re-asked when the text rests — on `threadId`'s session. */
export function useDraftHead(threadId: string | undefined, draft: EditorDraft, fetchImpl?: FetchLike): HeadState {
  const [head, setHead] = useState<HeadState>({ kind: 'none' })
  const renderable = draft.category !== 'session' && draft.body.trim().length > 0
  const request: EnsoSystemPromptDraft | undefined =
    renderable && draft.category !== 'session'
      ? { mode: draft.category, text: draft.body, name: draft.name.trim() || 'draft' }
      : undefined
  const key = request === undefined ? undefined : JSON.stringify(request)
  useEffect(() => {
    if (threadId === undefined || key === undefined) {
      setHead({ kind: 'none' })
      return
    }
    let current = true
    setHead({ kind: 'loading' })
    const timer = setTimeout(() => {
      void fetchSystemPromptPreview(threadId, { draft: JSON.parse(key) as EnsoSystemPromptDraft }, fetchImpl).then(
        (read) => {
          if (current) setHead(read)
        },
      )
    }, DRAFT_PREVIEW_PAUSE_MS)
    return (): void => {
      current = false
      clearTimeout(timer)
    }
  }, [threadId, key, fetchImpl])
  return head
}

/** The share of the window, when the model has one; `tokens` over it, one decimal. */
function windowShare(tokens: number, preview: EnsoSystemPromptPreview | undefined): string | undefined {
  const window = preview?.contextWindow ?? null
  return window === null
    ? undefined
    : `${((tokens / window) * 100).toFixed(1)}% of the model’s ${count(window)}-token window`
}

export function PromptSizeBar({
  draft,
  head,
  window,
}: {
  draft: EditorDraft
  head: HeadState
  /** Any preview on this thread — pi's default at least — for the window a session prompt is measured against. */
  window: EnsoSystemPromptPreview | undefined
}): React.ReactNode {
  const tokens = estimateTextTokens(draft.body)
  const whole = head.kind === 'loaded' ? head.preview : undefined
  const share = whole === undefined ? windowShare(tokens, window) : windowShare(whole.totalTokens, whole)
  return (
    <p
      aria-label="prompt size"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 font-mono text-xs text-muted-foreground"
    >
      <span>{count(fileBytes(draft))} bytes</span>
      <span>≈{count(tokens)} tokens</span>
      {whole === undefined ? null : <span>whole system prompt ≈{count(whole.totalTokens)} tokens</span>}
      {share === undefined ? null : <span>{share}</span>}
    </p>
  )
}

/** Where the whole system prompt's tokens come from: each section, whose it is, and the tool definitions. */
export function PromptBreakdown({ head }: { head: HeadState }): React.ReactNode {
  if (head.kind === 'none') return null
  if (head.kind === 'loading') return <p className="px-4 py-2 text-xs text-muted-foreground">rendering with pi…</p>
  if (head.kind === 'unavailable') {
    return <p className="px-4 py-2 text-xs text-destructive">breakdown unavailable: {head.detail}</p>
  }
  const { sections, tools, totalTokens } = head.preview
  const toolTokens = tools.reduce((sum, tool) => sum + tool.tokens, 0)
  return (
    <table aria-label="what the model receives" className="w-full text-xs">
      <tbody className="divide-y">
        {sections.map((section) => (
          <tr key={section.name}>
            <td className="px-4 py-1 font-mono">{section.name}</td>
            <td className="px-2 py-1 text-muted-foreground">{section.origin === 'library' ? 'this prompt' : 'pi'}</td>
            <td className="px-4 py-1 text-right font-mono">≈{count(section.tokens)}</td>
          </tr>
        ))}
        <tr>
          <td className="px-4 py-1 font-mono">tool definitions</td>
          <td className="px-2 py-1 text-muted-foreground">pi · {tools.length}</td>
          <td className="px-4 py-1 text-right font-mono">≈{count(toolTokens)}</td>
        </tr>
        <tr className="font-semibold">
          <td colSpan={2} className="px-4 py-1">
            total
          </td>
          <td className="px-4 py-1 text-right font-mono">≈{count(totalTokens)}</td>
        </tr>
      </tbody>
    </table>
  )
}
