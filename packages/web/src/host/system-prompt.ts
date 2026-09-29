import type { ResourceLoader, SessionEntry } from '@earendil-works/pi-coding-agent'
import { type EnsoSystemPromptChoice, type EnsoThreadSystemPrompt, recordedSystemPrompt } from '@enso/core'

/**
 * A session's system prompt from the library (#443), handed to pi through pi's OWN mechanism.
 *
 * ⚠ THE RESOURCE LOADER, NOT AN EXTENSION HOOK. pi builds the prompt from its resource loader's
 * `getSystemPrompt()` (a custom preamble, `SYSTEM.md`'s role) and `getAppendSystemPrompt()`
 * (`APPEND_SYSTEM.md`'s), re-read every time it rebuilds (`agent-session.js` `_rebuildSystemPrompt`).
 * The host hands pi a loader that answers those two with the thread's choice and everything else
 * from pi's own ({@link withSystemPrompt}). A `before_agent_start` handler returning `systemPrompt`
 * would work too, but it is per-run by construction — exactly the rewrite the prompt cache must
 * not see — and would put a prompt decision in the harness extensions that the terminal loads.
 *
 * ⚠ THE SESSION EXISTS BEFORE THE CHOICE. The Start dialog builds the session when it opens
 * (#390), so the choice arrives on a live session: the loader's answer changes, and
 * `setActiveToolsByName(getActiveToolNames())` — pi's public call that rebuilds the prompt for the
 * same tools — makes pi read it again. Nothing has been sent yet, so no cached prefix is lost.
 *
 * ⚠ FIXED FOR LIFE, AND IT TRAVELS. The choice is appended to pi's log as a custom entry
 * (`enso-system-prompt`, text included) BEFORE the first request, and a session built
 * over a branch that carries one starts with it (`@enso/core`'s `recordedSystemPrompt`) — a resumed thread
 * and a fork run the text they started with, not whatever the library file says now. A choice is
 * refused once the branch holds a message: from then on the prompt that went — pi's default, or the
 * last one chosen — is the session's ({@link decideSystemPrompt}).
 *
 * pi's default is today's behaviour, unchanged: no choice, and the loader answers as pi's does —
 * including a `SYSTEM.md` or `APPEND_SYSTEM.md` pi finds in the agent dir or a trusted project.
 */

/** What a choice does to a session: apply it, nothing (it already runs it), or a refusal's reason. */
export type SystemPromptDecision =
  | { readonly kind: 'apply' }
  | { readonly kind: 'same' }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * The rule, once — the host and the server's fake both apply it. `current` is the session's
 * choice, `hasSentRequest` whether its branch holds a message yet. Until the first request a choice
 * may be REPLACED — nothing is cached yet, and a Start refused at a later step (a model with no key)
 * must be able to try again with another prompt; the branch's last entry is the one that counts.
 * From the first request on, the prompt is the session's for life.
 */
export function decideSystemPrompt(
  current: EnsoSystemPromptChoice | undefined,
  next: EnsoSystemPromptChoice,
  hasSentRequest: boolean,
): SystemPromptDecision {
  if (current !== undefined && current.id === next.id && current.mode === next.mode && current.sha256 === next.sha256) {
    return { kind: 'same' }
  }
  if (!hasSentRequest) return { kind: 'apply' }
  const running = current === undefined ? "pi's default system prompt" : `the system prompt ${current.name}`
  return {
    kind: 'refused',
    reason: `this session has already sent ${running} and keeps it for its whole life; start a new thread for ${next.name}`,
  }
}

/** The branch's system prompt as a view shows it: the choice without its text, pi's default, or unreadable. */
export function threadSystemPrompt(branch: readonly SessionEntry[]): EnsoThreadSystemPrompt {
  const recorded = recordedSystemPrompt(branch)
  if (recorded.kind === 'none') return null
  if (recorded.kind === 'unreadable') return 'unreadable'
  const { id, name, mode, sha256 } = recorded.choice
  return { id, name, mode, sha256 }
}

/** True once the branch holds a message: a request has gone, with whatever prompt it had. */
export function hasSentRequest(branch: readonly SessionEntry[]): boolean {
  return branch.some((entry) => entry.type === 'message')
}

/**
 * pi's loader, answering the two prompt reads with the thread's choice: `system` as the custom
 * preamble, `append` after whatever pi would append. Every other member is pi's own, bound to it.
 */
export function withSystemPrompt(
  loader: ResourceLoader,
  current: () => EnsoSystemPromptChoice | undefined,
): ResourceLoader {
  const getSystemPrompt = (): string | undefined => {
    const choice = current()
    return choice?.mode === 'system' ? choice.text : loader.getSystemPrompt()
  }
  const getAppendSystemPrompt = (): string[] => {
    const choice = current()
    const base = loader.getAppendSystemPrompt()
    return choice?.mode === 'append' ? [...base, choice.text] : base
  }
  return new Proxy(loader, {
    get(target, property, _receiver): unknown {
      if (property === 'getSystemPrompt') return getSystemPrompt
      if (property === 'getAppendSystemPrompt') return getAppendSystemPrompt
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
