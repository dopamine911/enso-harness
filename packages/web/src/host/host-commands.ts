import type { EnsoHostCommandRun, EnsoModelChoice, EnsoModelState, RuntimeCommand } from '@enso/core'

/**
 * The `host` command source (#338 slice 2) — the rows the host appends to `listCommands()` and
 * the decision behind `runHostCommand`, as PURE functions over a model state and a model list.
 *
 * Why a module and not two closures in `agent-host.ts`: the fake runtime
 * (`server/__tests__/fake-hosted-thread.ts`) must produce the same rows and refuse with the
 * same words, or the server tests drive a seam the real host does not implement. One copy of
 * the row shape and of the wording is the same argument `event-tail.ts` makes for the tail.
 *
 * What the rows ARE: `/model` is a `select` over the models pi could run right now
 * (`modelRuntime.getAvailableSnapshot()` — authenticated providers only, which is why choosing
 * one is the fix for "the default is Cursor, I have no Cursor" without a scratch-file edit,
 * #341), `/thinking` a `level` over what the current model offers. Both carry the current
 * `value` as an option id; the `/commands` route drops it for a `remembered` list, because a
 * thread with no live session has no current value — see `withoutHostValues`.
 *
 * ⚠ A model's option id is `provider/id`, joined and never split: a model id may itself
 * contain `/` (an openrouter id does), so a run's `value` is matched against the joined id of
 * every available model rather than parsed back into two parts.
 */

/**
 * A refusal the host DECIDED (PR #344 review): an unknown command, a model not on offer, a
 * level the model does not have, a provider pi has no credentials for. The route says exactly
 * this class as 422 with the reason verbatim; any other throw is a fault and stays a 500 —
 * a `TypeError` from a moved pi API must not reach the user as "your choice was refused".
 */
export class HostCommandRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'HostCommandRefused'
  }
}

const HOST_COMMAND_MODEL = 'model'
const HOST_COMMAND_THINKING = 'thinking'

/** A model as its `HostCommandOption.id`. */
function modelOptionId(model: Pick<EnsoModelChoice, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

/** The two host rows, in the contract's order: `model`, then `thinking`. */
export function hostCommandRows(state: EnsoModelState, models: readonly EnsoModelChoice[]): RuntimeCommand[] {
  return [
    {
      name: HOST_COMMAND_MODEL,
      source: 'host',
      kind: 'select',
      description: 'switch the model',
      ...(state.model === null ? {} : { value: modelOptionId(state.model) }),
      options: models.map((model) => ({ id: modelOptionId(model), label: model.name, detail: model.provider })),
    },
    {
      name: HOST_COMMAND_THINKING,
      source: 'host',
      kind: 'level',
      description: 'set the thinking level',
      value: state.thinkingLevel,
      options: state.availableThinkingLevels.map((level) => ({ id: level, label: level })),
    },
  ]
}

/**
 * The same list for a thread with no live session: host rows keep their `options` (every
 * session offers the same) and lose their `value` (this thread has none yet). pi's rows pass
 * through untouched.
 */
export function withoutHostValues(commands: readonly RuntimeCommand[]): RuntimeCommand[] {
  return commands.map((command) => {
    if (command.source !== 'host' || command.value === undefined) return command
    const { value: _value, ...withoutValue } = command
    return withoutValue
  })
}

/** What a run asks for once checked: the model to set, the level to set, or why neither. */
export type HostCommandDecision<Model extends EnsoModelChoice> =
  | { readonly kind: 'model'; readonly model: Model }
  | { readonly kind: 'thinking'; readonly level: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Check a run against what the session offers now. Every refusal is a sentence the route says
 * verbatim as its 422 and the browser shows as a warning; the successful decisions carry the
 * exact object to hand pi (`Model` is pi's own type when the real host calls this — `setModel`
 * takes the registry's object, not a `{ provider, id }` pair).
 */
export function decideHostCommand<Model extends EnsoModelChoice>(
  run: EnsoHostCommandRun,
  state: EnsoModelState,
  models: readonly Model[],
): HostCommandDecision<Model> {
  switch (run.name) {
    case HOST_COMMAND_MODEL: {
      if (run.value === undefined) return { kind: 'refused', reason: 'model needs a value: one of its options' }
      const model = models.find((candidate) => modelOptionId(candidate) === run.value)
      if (model === undefined) return { kind: 'refused', reason: `model ${run.value} is not available here` }
      return { kind: 'model', model }
    }
    case HOST_COMMAND_THINKING: {
      if (run.value === undefined) return { kind: 'refused', reason: 'thinking needs a value: one of its levels' }
      if (!state.availableThinkingLevels.includes(run.value)) {
        const offeredBy = state.model === null ? 'the session' : state.model.name
        return {
          kind: 'refused',
          reason: `thinking level ${run.value} is not offered by ${offeredBy}; available: ${state.availableThinkingLevels.join(', ')}`,
        }
      }
      return { kind: 'thinking', level: run.value }
    }
    default:
      return { kind: 'refused', reason: `no host command named ${run.name}` }
  }
}
