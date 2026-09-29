import { toToolDeclaration } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import {
  type EnsoSystemPromptChoice,
  type EnsoSystemPromptPreview,
  type EnsoSystemPromptSection,
  estimateTextTokens,
} from '@enso/core'

/**
 * A system prompt before it is sent (#443): what a thread's next request would carry with a given
 * library prompt — or pi's default — section by section, priced as the Context tab prices it.
 *
 * ⚠ pi RENDERS IT; WE ONLY SPLIT IT. pi builds the prompt from options it does not expose outside a
 * command's context, with a builder its package does not export (`buildSystemPromptSections`). What
 * it does expose is the rendering, `AgentSession.systemPrompt` — the preamble, then every other
 * section inside its `<name>` tags, joined by blank lines (pi-ai `getSystemMessageText`). So the
 * host asks pi for the rendering under the candidate ({@link renderedUnder}) and splits it here
 * ({@link splitRenderedPrompt}). What the host knows it checks exactly: the preamble when it is a
 * custom one, and the addendum always — pi renders `getAppendSystemPrompt()` joined by blank lines
 * as `<addendum>` (`system-prompt.js` `promptSections.addendum`), so an append text holding
 * pi-looking tags cannot fabricate sections. The rest is split at tag boundaries, each name at
 * most once; a rendering that does not fit is refused rather than shown wrong. The total never
 * depends on the split: it is the whole rendering's price split the same way the Context tab
 * splits pi's stored sections.
 *
 * ⚠ A SWAP, SYNCHRONOUS AND UNDONE. The candidate is put in the loader's place, pi rebuilds (the
 * same public call `setSystemPrompt` uses), the rendering is read, and the thread's own choice is
 * put back and rebuilt — no `await` in between, so no request can see the candidate. Refused while
 * a run is in flight: pi's rendering is then the run's, not the base the swap changes.
 *
 * The tool definitions are pi-ai's own declarations of the session's executable tools
 * (`toToolDeclaration`) — the objects pi sends as `toolsAdded` — priced as `context-elements.ts`
 * prices each one.
 */

/** A section as pi renders it: its name and its text, tags included for all but the preamble. */
export interface RenderedSection {
  readonly name: string
  readonly text: string
}

const SECTION_SEPARATOR = '\n\n'
const SECTION_OPEN = /^<([a-z][a-z0-9_-]*)>\n/

/** Where the section that opens `rest` ends: the first `\n</name>` that ends the text or precedes another section. */
function sectionEnd(rest: string, name: string, from: number): number | undefined {
  const close = `\n</${name}>`
  for (let at = rest.indexOf(close, from); at !== -1; at = rest.indexOf(close, at + 1)) {
    const after = at + close.length
    if (after === rest.length || rest.startsWith(`${SECTION_SEPARATOR}<`, after)) return after
  }
  return undefined
}

/**
 * Where the addendum that opens `rest` ends, matched WHOLE against the one the host handed pi: its
 * text is the user's and may hold `</addendum>` or any other tag, so no close inside it is a boundary.
 */
function addendumEnd(rest: string, addendum: string | undefined): number | undefined {
  if (addendum === undefined || !rest.startsWith(addendum)) return undefined
  const after = addendum.length
  return after === rest.length || rest.startsWith(SECTION_SEPARATOR, after) ? after : undefined
}

/** What the host knows of the rendering: a custom preamble, and the addendum pi was handed. */
export interface KnownSections {
  readonly preamble: string | undefined
  /** The appends joined as pi joins them; `undefined` when there are none (pi renders no addendum). */
  readonly addendum: string | undefined
}

/**
 * pi's rendering as its sections, or `undefined` when it does not fit what the host knows.
 * `preamble` is the preamble when the host knows it (a custom one); pi's own has no section tag in
 * it, so without one the preamble ends where the first section opens. The addendum is matched
 * whole: its text is the user's and may hold anything, including `</addendum>` and other tags.
 */
export function splitRenderedPrompt(rendered: string, known: KnownSections): RenderedSection[] | undefined {
  const firstSection = rendered.indexOf(`${SECTION_SEPARATOR}<`)
  const head = known.preamble ?? (firstSection === -1 ? rendered : rendered.slice(0, firstSection))
  if (head.length === 0 || !rendered.startsWith(head)) return undefined
  const sections: RenderedSection[] = [{ name: 'preamble', text: head }]
  const seen = new Set(['preamble'])
  const addendum = known.addendum === undefined ? undefined : `<addendum>\n${known.addendum}\n</addendum>`
  let rest = rendered.slice(head.length)
  while (rest.length > 0) {
    if (!rest.startsWith(SECTION_SEPARATOR)) return undefined
    rest = rest.slice(SECTION_SEPARATOR.length)
    const open = SECTION_OPEN.exec(rest)
    const name = open?.[1]
    if (open === null || name === undefined || seen.has(name)) return undefined
    const end = name === 'addendum' ? addendumEnd(rest, addendum) : sectionEnd(rest, name, open[0].length - 1)
    if (end === undefined) return undefined
    seen.add(name)
    sections.push({ name, text: rest.slice(0, end) })
    rest = rest.slice(end)
  }
  // An addendum pi was handed but did not render means the rendering is not what the host thinks.
  return addendum !== undefined && !seen.has('addendum') ? undefined : sections
}

/**
 * Whose words a section is: the candidate's preamble is the library's; the addendum is the
 * library's only when it is the candidate's text alone. ⚠ When pi's `APPEND_SYSTEM.md` shares the
 * addendum with it, the section is labelled `pi` — the schema has one origin per section, and
 * calling pi's text the library's would be the worse lie.
 */
function originOf(
  name: string,
  candidate: EnsoSystemPromptChoice | null,
  baseAppends: readonly string[],
): EnsoSystemPromptSection['origin'] {
  if (candidate?.mode === 'system' && name === 'preamble') return 'library'
  if (candidate?.mode === 'append' && name === 'addendum' && baseAppends.length === 0) return 'library'
  return 'pi'
}

/** The swap: `setChoice` puts a choice in the loader's place; pi rebuilds for the same tools and renders. */
export function renderedUnder(
  session: AgentSession,
  setChoice: (choice: EnsoSystemPromptChoice | undefined) => void,
  candidate: EnsoSystemPromptChoice | undefined,
  kept: EnsoSystemPromptChoice | undefined,
): string {
  const tools = session.getActiveToolNames()
  setChoice(candidate)
  session.setActiveToolsByName(tools)
  const rendered = session.systemPrompt
  setChoice(kept)
  session.setActiveToolsByName(tools)
  return rendered
}

/** What a preview is made from: pi's rendering, what the host knows of it, and the session's tools and window. */
export interface PreviewInputs {
  readonly rendered: string
  /** The preamble when the host knows it: the candidate's, or a `SYSTEM.md` pi's loader found. */
  readonly preamble: string | undefined
  /** pi's own appends (`APPEND_SYSTEM.md`), from its loader — the candidate's `append` text is added here. */
  readonly baseAppends: readonly string[]
  readonly candidate: EnsoSystemPromptChoice | null
  readonly tools: readonly Parameters<typeof toToolDeclaration>[0][]
  readonly contextWindow: number | undefined
}

/** The preview, from pi's rendering and the session's executable tools; `undefined` when it does not split. */
export function previewOf({
  rendered,
  preamble,
  baseAppends,
  candidate,
  tools,
  contextWindow,
}: PreviewInputs): EnsoSystemPromptPreview | undefined {
  const appends = candidate?.mode === 'append' ? [...baseAppends, candidate.text] : baseAppends
  // pi renders no addendum when the join is empty (`system-prompt.js`: `if (appendSystemPrompt)`).
  const joined = appends.join(SECTION_SEPARATOR)
  const addendum = joined === '' ? undefined : joined
  const split = splitRenderedPrompt(rendered, { preamble, addendum })
  if (split === undefined) return undefined
  const sections = split.map(({ name, text }) => ({
    name,
    origin: originOf(name, candidate, baseAppends),
    text,
    tokens: estimateTextTokens(text),
  }))
  const declared = tools.map((tool) => ({
    name: tool.name,
    tokens: estimateTextTokens(JSON.stringify(toToolDeclaration(tool))),
  }))
  const totalTokens = [...sections, ...declared].reduce((sum, item) => sum + item.tokens, 0)
  const prompt = candidate === null ? null : { id: candidate.id, name: candidate.name, mode: candidate.mode }
  return { prompt, sections, tools: declared, totalTokens, contextWindow: contextWindow ?? null }
}
