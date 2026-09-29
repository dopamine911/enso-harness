import type { EnsoContextCategory, EnsoThreadSystemPrompt } from '@enso/core'
import { createContext, useContext } from 'react'
import { categoryLabel, elementLabel } from './thread-context-analysis.ts'

/**
 * The thread's system prompt, for the Context view's labels (#443): a custom prompt is visible in
 * the evidence — the system-prompt row says which prompt it is, and the section the prompt wrote says
 * so — not only in the dialog that chose it. Provided where the context is read (`whenRead`), so the
 * Context tab and `/context` alike; pi's default where nothing provides it.
 */
export const ThreadSystemPromptContext = createContext<EnsoThreadSystemPrompt>(null)

/** A category's name on its row, as this thread's system prompt makes it. */
export function useCategoryLabel(): (category: EnsoContextCategory) => string {
  const prompt = useContext(ThreadSystemPromptContext)
  return (category) => categoryLabel(category, prompt)
}

/** An element's label, with the library prompt's name beside the section it wrote. */
export function useElementLabel(): (element: { readonly key: string; readonly label: string }) => string {
  const prompt = useContext(ThreadSystemPromptContext)
  return (element) => elementLabel(element, prompt)
}
