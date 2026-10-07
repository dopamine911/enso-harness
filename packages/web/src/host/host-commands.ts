import {
  ENSO_CONTEXT_COMMAND,
  ENSO_FORK_COMMAND,
  type EnsoHostCommandRun,
  type EnsoModelChoice,
  type EnsoModelState,
  type HostCommandOption,
  type RuntimeCommand,
} from '@enso/core'

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
 * `value` as an option id. A thread with no session gets `catalogueRows` instead (#484): the
 * same `/model` options with no value, the flows, and nothing a session alone has.
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
export function modelOptionId(model: Pick<EnsoModelChoice, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

/** The `/model` options: one per model pi could run right now, each carrying its own thinking levels (#391). */
function modelOptions<Model extends EnsoModelChoice>(
  models: readonly Model[],
  thinkingLevelsOf: (model: Model) => readonly string[],
): HostCommandOption[] {
  return models.map((model) => ({
    id: modelOptionId(model),
    label: model.name,
    detail: model.provider,
    thinkingLevels: [...thinkingLevelsOf(model)],
  }))
}

const MODEL_ROW = { name: HOST_COMMAND_MODEL, source: 'host', kind: 'select', description: 'switch the model' } as const

/**
 * The two host rows, in the contract's order: `model`, then `thinking`. Each `/model` option
 * carries that model's thinking levels (#391), read by `thinkingLevelsOf` — the host passes the
 * runtime's own rule, so this module stays free of the vendor's model type.
 */
export function hostCommandRows<Model extends EnsoModelChoice>(
  state: EnsoModelState,
  models: readonly Model[],
  thinkingLevelsOf: (model: Model) => readonly string[],
): RuntimeCommand[] {
  return [
    {
      ...MODEL_ROW,
      ...(state.model === null ? {} : { value: modelOptionId(state.model) }),
      options: modelOptions(models, thinkingLevelsOf),
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
 * The rows a thread with NO session is offered (#484): `/model` over the same models, then the
 * `flow` rows among `flows` — `/login` and, when something is stored, `/logout`, as `hostFlowRows`
 * builds them. ⚠ Not `/thinking`, `/compact` (an action) or a view, and none of pi's rows: each
 * belongs to a session, and the Start dialog is what a thread without one offers. `/thinking`'s
 * levels are the chosen model's, carried on its `/model` option.
 *
 * `/model`'s `value` is the configured default (`provider/id`, pi's `defaultProvider` and
 * `defaultModel`) when it is among the models: the Start dialog preselects it, as pi starts a
 * session on it (#674). A default that is not offered is no value, and the dialog takes its first.
 */
export function catalogueRows<Model extends EnsoModelChoice>(
  models: readonly Model[],
  thinkingLevelsOf: (model: Model) => readonly string[],
  flows: readonly RuntimeCommand[],
  configuredDefault?: string,
): RuntimeCommand[] {
  const options = modelOptions(models, thinkingLevelsOf)
  const offered = options.some((option) => option.id === configuredDefault)
  return [
    { ...MODEL_ROW, options, ...(offered && configuredDefault !== undefined ? { value: configuredDefault } : {}) },
    ...flows.filter((row) => row.kind === 'flow'),
  ]
}

/**
 * The `view` rows, last in the list: rows the PAGE does. `/context` opens the Context view over
 * the chat (#361 phase 5); `/fork` forks the thread at its last user message through the fork
 * route and opens the fork (#433). A view reads or posts to its own routes, so the row carries no
 * options and no value, and a run of it through `…/command` — the palette never sends one — is
 * refused below.
 */
export const HOST_VIEW_ROWS: readonly RuntimeCommand[] = [
  { name: ENSO_CONTEXT_COMMAND, source: 'host', kind: 'view', description: 'show what the context is made of' },
  {
    name: ENSO_FORK_COMMAND,
    source: 'host',
    kind: 'view',
    description: 'fork a new thread from before the last prompt, holding its words to send again',
  },
]

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
    case ENSO_CONTEXT_COMMAND:
    case ENSO_FORK_COMMAND:
      return { kind: 'refused', reason: `/${run.name} opens in the page; there is nothing for the host to run` }
    default:
      return { kind: 'refused', reason: `no host command named ${run.name}` }
  }
}
