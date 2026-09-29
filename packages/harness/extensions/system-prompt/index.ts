import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type EnsoSystemPromptChoice, recordedSystemPrompt } from '@enso/core'

/**
 * A thread's library system prompt, applied on EVERY surface (#443): at each prompt's run start,
 * the branch's last `enso-system-prompt` entry is put into the run's prompt options — a `system`
 * prompt as pi's custom preamble, an `append` prompt after whatever pi appends — so a thread started
 * with a prompt in the web and resumed in the terminal (`bun run enso`, then `/resume`) runs the text
 * it started with, not pi's default.
 *
 * ⚠ THE RUN'S OPTIONS, NOT A FORCED PROMPT. pi hands `before_agent_start` a copy of its prompt
 * options (`emitBeforeAgentStart` → `normalizeBuildSystemPromptOptions`) and builds the request's
 * sections from that copy after the handlers ran (`_preparePromptAndToolLoadout`). Setting
 * `customPrompt` or extending `appendSystemPrompt` there gives the same structured sections the web
 * host's loader gives (`host/system-prompt.ts`), which pi diffs against the transcript: the same
 * text is no change, and the prompt cache holds. Returning `systemPrompt` from the handler instead
 * would FORCE an opaque head with no sections — a different head from the web's, and a different
 * one from what the log already records.
 *
 * ⚠ IDEMPOTENT WITH THE WEB HOST. The host's loader already answers with the choice, so in the web
 * the options arrive holding it: a preamble set again is the same preamble, and an addendum that
 * already ends with the text is left alone. Written as an extension so the terminal — which has no
 * host — gets it at all.
 *
 * ⚠ AN ENTRY THAT DOES NOT READ IS SAID, NOT SWALLOWED. The web host refuses to build such a thread;
 * the terminal cannot refuse a session pi already opened, so the run goes on with pi's default and
 * the extension says so in an error notice — never silently. A Continue (#436) emits no
 * `before_agent_start`; its request carries the head the transcript already holds.
 */

/** pi's joiner for the texts it appends (`agent-session.js` `_rebuildSystemPrompt`). */
const APPEND_SEPARATOR = '\n\n'

/** The run's prompt options with the choice in them — the same shape the web host's loader produces. */
export function applySystemPrompt(
  options: Pick<BeforeAgentStartEvent['systemPromptOptions'], 'customPrompt' | 'appendSystemPrompt'>,
  choice: EnsoSystemPromptChoice,
): void {
  if (choice.mode === 'system') {
    options.customPrompt = choice.text
    return
  }
  const appended = options.appendSystemPrompt ?? ''
  // Already there when it ends the addendum — the web host's loader put it. Nothing is lost if an
  // APPEND_SYSTEM.md happens to end with the same text: the text is in the prompt either way.
  if (appended === choice.text || appended.endsWith(`${APPEND_SEPARATOR}${choice.text}`)) return
  options.appendSystemPrompt = appended.length === 0 ? choice.text : `${appended}${APPEND_SEPARATOR}${choice.text}`
}

/** What the notice says when the branch's record does not read. */
export const UNREADABLE_SYSTEM_PROMPT_NOTICE =
  "Enso: this thread's recorded system prompt does not read — this run uses pi's default system prompt"

export default function systemPrompt(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event: BeforeAgentStartEvent, context: ExtensionContext): undefined => {
    const recorded = recordedSystemPrompt(context.sessionManager.getBranch())
    if (recorded.kind === 'chosen') applySystemPrompt(event.systemPromptOptions, recorded.choice)
    if (recorded.kind === 'unreadable') context.ui.notify(UNREADABLE_SYSTEM_PROMPT_NOTICE, 'error')
    return undefined
  })
}
