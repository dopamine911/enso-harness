import type { EnsoContextCategory, EnsoContextMakeup, EnsoContextRequest } from '@enso/core'

/**
 * What the Context view derives from `EnsoThreadContext` before it draws (#361): the category
 * order and names, totals, the prompt-granularity roll-up and the delta series — dsh-context's
 * `categories.ts`, `headline.ts` and trend aggregation, over our wire. Pure, so the rules are
 * pinned without a DOM.
 */

/** dsh's order: what pi writes first, then the conversation. The stacks draw bottom to top in it. */
export const CONTEXT_CATEGORIES: readonly EnsoContextCategory[] = [
  'system',
  'tools',
  'user',
  'injected',
  'assistant',
  'toolResults',
]

export const CATEGORY_LABEL: Readonly<Record<EnsoContextCategory, string>> = {
  system: 'system prompt',
  tools: 'tool schemas',
  user: 'user messages',
  injected: 'injected context',
  assistant: 'assistant messages',
  toolResults: 'tool results',
}

/** The theme's chart colours (`styles/global.css`), one per category, close to dsh's. */
export const CATEGORY_COLOR: Readonly<Record<EnsoContextCategory, string>> = {
  system: 'var(--chart-1)',
  tools: 'var(--chart-6)',
  user: 'var(--chart-2)',
  injected: 'var(--chart-4)',
  assistant: 'var(--chart-3)',
  toolResults: 'var(--chart-5)',
}

export function totalOf(makeup: EnsoContextMakeup): number {
  return CONTEXT_CATEGORIES.reduce((sum, category) => sum + makeup[category], 0)
}

/** The trend's two granularities: every model request, or each prompt's last one. */
export type TrendGranularity = 'turn' | 'prompt'
/** Each bar's whole makeup, or its signed change from the bar before. */
export type TrendMode = 'total' | 'delta'

/**
 * One bar per prompt: the prompt's LAST request — the context it ended with, which is what a
 * prompt costs the next one. dsh's turn roll-up, named our way (the glossary's prompt).
 */
export function lastRequestPerPrompt(requests: readonly EnsoContextRequest[]): EnsoContextRequest[] {
  const last = new Map<number, EnsoContextRequest>()
  for (const request of requests) last.set(request.prompt, request)
  return [...last.values()]
}

/** `current − previous`, per category; the first bar's change is from an empty context. */
export function changeOf(current: EnsoContextMakeup, previous: EnsoContextMakeup | undefined): EnsoContextMakeup {
  const change = { ...current }
  if (previous === undefined) return change
  for (const category of CONTEXT_CATEGORIES) change[category] = current[category] - previous[category]
  return change
}

/**
 * The share of `part` in `whole`, for a bar's width or a legend's percent — zero, not NaN, when
 * nothing is there to share.
 */
export function shareOf(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0
}
