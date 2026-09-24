import type { EnsoPromptStats, EnsoThreadStats } from '@enso/core'

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
 *   - a turn by its first tool call; a turn that made none is its prompt's reply — pi ends a run
 *     on the turn that calls no tool, so that turn is the answer, drawn last before the next prompt.
 * What cannot be found is said by the drawer, never guessed at.
 */

export type StatsTarget =
  | { readonly kind: 'prompt'; readonly prompt: number }
  | { readonly kind: 'turn'; readonly turn: number }
  | { readonly kind: 'tool-call'; readonly toolCallId: string }

/** Reveals a target in the pane's transcript; `false` when it is not there to reveal. */
export type RevealStatsTarget = (target: StatsTarget, stats: EnsoThreadStats) => boolean

const USER_BUBBLES = '[data-role="user"]'
const BUBBLES = '[data-role="user"], [data-role="assistant"]'

/**
 * Letters and digits only, lower-cased: a user bubble renders its text as markdown, so `**x**`
 * reads `x` on screen while the stats keep the typed characters.
 */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** A prompt's stats text as a prefix of its bubble's: no image marker, no truncation ellipsis. */
function promptStem(prompt: EnsoPromptStats): string {
  return comparable(prompt.text.replaceAll('[image content]', '').replace(/…$/, ''))
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
  const stem = promptStem(wanted)
  if (stem.length === 0) return undefined
  const occurrence = prompted.slice(0, position).filter((stats) => promptStem(stats) === stem).length
  let seen = 0
  for (const [bubbleIndex, text] of bubbleTexts.entries()) {
    if (!comparable(text).startsWith(stem)) continue
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

/** The last assistant bubble after `prompt`'s bubble (before any, for prompt 0) and before the next. */
function replyOf(root: ParentNode, stats: EnsoThreadStats, prompt: number): Element | undefined {
  const bubbles = [...root.querySelectorAll(BUBBLES)]
  const opening = prompt === 0 ? undefined : userBubbleOf(root, stats, prompt)
  if (prompt !== 0 && opening === undefined) return undefined
  let reply: Element | undefined
  for (const bubble of bubbles.slice(opening === undefined ? 0 : bubbles.indexOf(opening) + 1)) {
    if (bubble.getAttribute('data-role') === 'user') break
    reply = bubble
  }
  return reply
}

/** The transcript element a target names, under `root` (one pane's conversation), or undefined. */
export function locateStatsTarget(root: ParentNode, stats: EnsoThreadStats, target: StatsTarget): Element | undefined {
  switch (target.kind) {
    case 'tool-call':
      return toolCallRow(root, target.toolCallId)
    case 'prompt':
      return target.prompt === 0 ? (root.querySelector(BUBBLES) ?? undefined) : userBubbleOf(root, stats, target.prompt)
    case 'turn': {
      const turn = stats.turnStats.find((candidate) => candidate.turn === target.turn)
      if (turn === undefined) return undefined
      const firstCall = stats.callStats.find((call) => call.turn === target.turn)
      return firstCall === undefined ? replyOf(root, stats, turn.prompt) : toolCallRow(root, firstCall.toolCallId)
    }
  }
}

/** A ring and a tint that fade: the row the eye just landed on, then the transcript as it was. */
const HIGHLIGHT: Keyframe[] = [
  { boxShadow: '0 0 0 2px currentColor', backgroundColor: 'color-mix(in oklab, currentColor 18%, transparent)' },
  { boxShadow: '0 0 0 2px transparent', backgroundColor: 'transparent' },
]
const HIGHLIGHT_MS = 2000

/** Scroll `element` to the middle of its scroller and ring it for a moment. */
export function revealElement(element: Element): void {
  element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // ⓘ A DOM without the Web Animations API (the test DOM) still scrolls; the ring is decoration.
  if (typeof element.animate === 'function') element.animate(HIGHLIGHT, { duration: HIGHLIGHT_MS, easing: 'ease-out' })
}
