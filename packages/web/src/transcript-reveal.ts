import type { EnsoPromptStats, EnsoThreadStats, EnsoTurnStats } from '@enso/core'

/**
 * From a point or a row in the stats drawer to the transcript row it describes (#359) —
 * pi-livecraft's `onNavigate({ kind: 'turn' | 'message' | 'tool' })`, over our transcript.
 *
 * ⚠ THE TRANSCRIPT ON SCREEN IS NOT THE BRANCH, ROW FOR ROW. A resumed thread draws one bubble
 * per pi message (`transcript-to-messages.ts`); a LIVE run draws ONE assistant bubble for all its
 * turns (`follow-connection.ts` `openRun`), and a prompt another tab queued is no user bubble here
 * at all. So each target is found by what BOTH shapes carry:
 *   - a tool call by its `toolCallId`, which every step row carries (`data-tool-call-id`);
 *   - a prompt by its place among the user bubbles when their count is the branch's, and by its
 *     text otherwise (`promptBubbleIndex`);
 *   - a turn by its first tool call; a turn that made none by its prompt's assistant bubbles — the
 *     one at its place among the prompt's turns when there is a bubble per turn (a resumed thread),
 *     else the last (a live run's one bubble). NOT simply the last: a failed turn pi retries stays
 *     on the branch with no call (`_prepareRetry` keeps it in raw history), and the retry that
 *     follows under the same prompt is the last bubble (PR #360 review).
 * What cannot be found is said by the drawer, never guessed at.
 */

export type StatsTarget =
  | { readonly kind: 'prompt'; readonly prompt: number }
  | { readonly kind: 'turn'; readonly turn: number }
  | { readonly kind: 'tool-call'; readonly toolCallId: string }

/**
 * Reveals a target in the pane's transcript; `false` when it is not there to reveal. A prompt or a
 * turn is found through the thread's stats; a tool call by its id alone, so the session eval's
 * signals (#727), which hold no stats, reveal theirs with none.
 */
export type RevealStatsTarget = (target: StatsTarget, stats?: EnsoThreadStats) => boolean

const USER_BUBBLES = '[data-role="user"]'
const BUBBLES = '[data-role="user"], [data-role="assistant"]'

/**
 * Letters and digits only, lower-cased: a user bubble renders its text as markdown, so `**x**`
 * reads `x` on screen while the stats keep the typed characters.
 */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * How `contentToText` (`host/map-events.ts`) names a part that is not text — `[image content]` —
 * in the prompt text the stats carry. A bubble draws the image, not those words, so they go.
 */
const NON_TEXT_PART = /\[[\w-]+ content\]/g

/**
 * `branch-stats.ts` cuts a long prompt's text to 120 characters and ends it `…`. Only such a text
 * is a prefix of its bubble; any other must read as the bubble does, all of it (PR #360 review:
 * with a prefix, the stem `hi` also matched a `hi there` bubble).
 */
const TRUNCATED = '…'

/** A prompt's stats text, compared as a bubble is; and whether it is only the text's start. */
function promptStem(prompt: EnsoPromptStats): { readonly stem: string; readonly truncated: boolean } {
  return { stem: comparable(prompt.text.replace(NON_TEXT_PART, '')), truncated: prompt.text.endsWith(TRUNCATED) }
}

/**
 * Which user bubble shows prompt `prompt` (1-based, as `EnsoPromptStats.prompt`), or undefined.
 * Equal counts are the resumed shape and a plain live one: the bubbles ARE the prompts, in order.
 * Unequal, a queued prompt is missing or extra, and the prompt is found by text — the n-th bubble
 * that reads as it, where n counts the earlier prompts with the same text ("continue", twice).
 */
export function promptBubbleIndex(
  bubbleTexts: readonly string[],
  promptStats: readonly EnsoPromptStats[],
  prompt: number,
): number | undefined {
  const prompted = promptStats.filter((stats) => stats.prompt > 0)
  const position = prompted.findIndex((stats) => stats.prompt === prompt)
  const wanted = prompted[position]
  if (wanted === undefined) return undefined
  if (bubbleTexts.length === prompted.length) return position
  const { stem, truncated } = promptStem(wanted)
  if (stem.length === 0) return undefined
  const occurrence = prompted.slice(0, position).filter((stats) => promptStem(stats).stem === stem).length
  const readsAs = (text: string): boolean => (truncated ? comparable(text).startsWith(stem) : comparable(text) === stem)
  let seen = 0
  for (const [bubbleIndex, bubbleText] of bubbleTexts.entries()) {
    if (!readsAs(bubbleText)) continue
    if (seen === occurrence) return bubbleIndex
    seen += 1
  }
  return undefined
}

function userBubbleOf(root: ParentNode, stats: EnsoThreadStats, prompt: number): Element | undefined {
  const bubbles = [...root.querySelectorAll(USER_BUBBLES)]
  const index = promptBubbleIndex(
    bubbles.map((bubble) => bubble.textContent ?? ''),
    stats.promptStats,
    prompt,
  )
  return index === undefined ? undefined : bubbles[index]
}

function toolCallRow(root: ParentNode, toolCallId: string): Element | undefined {
  return root.querySelector(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`) ?? undefined
}

/** The assistant bubbles after `prompt`'s bubble (from the top, for prompt 0) and before the next user bubble. */
function assistantBubblesOf(root: ParentNode, stats: EnsoThreadStats, prompt: number): Element[] | undefined {
  const bubbles = [...root.querySelectorAll(BUBBLES)]
  const opening = prompt === 0 ? undefined : userBubbleOf(root, stats, prompt)
  if (prompt !== 0 && opening === undefined) return undefined
  const after = bubbles.slice(opening === undefined ? 0 : bubbles.indexOf(opening) + 1)
  const nextPrompt = after.findIndex((bubble) => bubble.getAttribute('data-role') === 'user')
  return nextPrompt === -1 ? after : after.slice(0, nextPrompt)
}

/**
 * A turn that made no call: its own bubble when the prompt has one per turn (resumed), else the
 * prompt's last (live: one bubble holds every turn of the run).
 */
function turnBubbleOf(root: ParentNode, stats: EnsoThreadStats, turn: EnsoTurnStats): Element | undefined {
  const replies = assistantBubblesOf(root, stats, turn.prompt)
  if (replies === undefined) return undefined
  const modelCalls = stats.turnStats.filter((candidate) => candidate.prompt === turn.prompt)
  if (replies.length === modelCalls.length) return replies[modelCalls.indexOf(turn)]
  return replies.at(-1)
}

/** The transcript element a target names, under `root` (one pane's conversation), or undefined. */
export function locateStatsTarget(
  root: ParentNode,
  stats: EnsoThreadStats | undefined,
  target: StatsTarget,
): Element | undefined {
  if (target.kind === 'tool-call') return toolCallRow(root, target.toolCallId)
  if (stats === undefined) return undefined
  if (target.kind === 'prompt')
    return target.prompt === 0 ? (root.querySelector(BUBBLES) ?? undefined) : userBubbleOf(root, stats, target.prompt)
  const turn = stats.turnStats.find((candidate) => candidate.turn === target.turn)
  if (turn === undefined) return undefined
  const firstCall = stats.callStats.find((call) => call.turn === target.turn)
  return firstCall === undefined ? turnBubbleOf(root, stats, turn) : toolCallRow(root, firstCall.toolCallId)
}

/** A ring and a tint that fade: the row the eye just landed on, then the transcript as it was. */
const HIGHLIGHT: Keyframe[] = [
  {
    boxShadow: '0 0 0 calc(var(--spacing) / 2) currentColor',
    backgroundColor: 'color-mix(in oklab, currentColor 18%, transparent)',
  },
  { boxShadow: '0 0 0 calc(var(--spacing) / 2) transparent', backgroundColor: 'transparent' },
]
const HIGHLIGHT_MS = 2000

/**
 * Ring `element` for a moment, where it already is: an incident card the windowed list scrolled to
 * itself (#588), whose own scroll a second one would fight.
 */
export function ringElement(element: Element): void {
  // ⓘ A DOM without the Web Animations API (the test DOM) still scrolls; the ring is decoration.
  if (typeof element.animate === 'function') element.animate(HIGHLIGHT, { duration: HIGHLIGHT_MS, easing: 'ease-out' })
}

/** Scroll `element` to the middle of its scroller and ring it for a moment. */
export function revealElement(element: Element): void {
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  ringElement(element)
}
