import type {
  EnsoContextCategory,
  EnsoContextMakeup,
  EnsoContextRequest,
  EnsoFileOperation,
  EnsoThreadSystemPrompt,
} from '@enso/core'

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

/**
 * What the thread's system prompt is called — on its Context row (#443) and on the composer's
 * locked chip (#878). ⚠ THE ROW HOLDS pi's BASE SECTIONS, so the name says what those are: a
 * `system` prompt replaced pi's preamble, and is named alone; an `append` prompt left pi's default
 * in place and added to it — its text is the `addendum`, which the categories file under `injected`
 * (`thread-context.ts`), so the row says `pi default + <name>` rather than claim tokens it does not hold.
 */
export function systemPromptName(prompt: EnsoThreadSystemPrompt): string {
  if (prompt === null) return 'pi default'
  if (prompt === 'unreadable') return 'unreadable record'
  return prompt.mode === 'append' ? `pi default + ${prompt.name}` : prompt.name
}

/** A category's name on its row; the system prompt's says which prompt it is. */
export function categoryLabel(category: EnsoContextCategory, prompt: EnsoThreadSystemPrompt): string {
  return category === 'system' ? `${CATEGORY_LABEL.system} · ${systemPromptName(prompt)}` : CATEGORY_LABEL[category]
}

/** The element a library prompt wrote, by its key: a `system` prompt's preamble, an `append` prompt's addendum. */
const LIBRARY_SECTION_KEY = {
  system: 'system:section:preamble',
  append: 'system:section:addendum',
} as const

/** An element's label, with the library prompt's name beside the section it wrote. */
export function elementLabel(
  element: { readonly key: string; readonly label: string },
  prompt: EnsoThreadSystemPrompt,
): string {
  if (prompt === null || prompt === 'unreadable') return element.label
  return element.key === LIBRARY_SECTION_KEY[prompt.mode] ? `${element.label} · ${prompt.name}` : element.label
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

/**
 * The file operations up to `turn` (every one when undefined), newest first — the trend's picked
 * request, so File Activity says what the agent had done to files by then. A search's own path and
 * each file it matched are rows of their own, as dsh draws them.
 */
export function operationsUpTo(
  operations: readonly EnsoFileOperation[],
  turn: number | undefined,
): EnsoFileOperation[] {
  return operations.filter((operation) => turn === undefined || operation.turn <= turn).toReversed()
}

/** A path as the card shows it: under the thread's tree, `./`-relative; elsewhere, as given. */
export function displayPath(path: string, cwd: string | undefined): string {
  // The tree itself — a search over `.` — reads `./`, not `./.` (#407).
  if (path === '.' || path === './' || (cwd !== undefined && path.replace(/\/$/, '') === cwd.replace(/\/$/, '')))
    return './'
  if (cwd === undefined) return path
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (path.startsWith(root)) return `./${path.slice(root.length)}`
  return path.startsWith('/') || path.startsWith('./') || path.startsWith('~') ? path : `./${path}`
}
