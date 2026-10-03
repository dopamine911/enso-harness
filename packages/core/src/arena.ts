import { type Static, Type } from 'typebox'

/**
 * Dogfood Arena's agent tool (#556, #584): the parameters of `act`, the ONE tool the agent under
 * test is given (`scripts/arena/agent.ts`). Each call is one move a person makes in a browser —
 * read the page, click, type, go to a path — performed by the recorder on its page.
 *
 * Every field but `action` is optional: the schema tells the model the shape, and the recorder's
 * own parser (`scripts/arena/actions.ts#parseArenaAction`) is the check — it refuses a selector, a
 * script, a `goto` off the page or onto `/api`, and records the refusal.
 */

/** A target as a reader of the page names it: a role and accessible name, visible text, a label or a placeholder. Never a selector. */
const ArenaTargetParameters = Type.Object({
  role: Type.Optional(Type.String({ description: 'an ARIA role: button, textbox, link, tab, dialog, …' })),
  name: Type.Optional(Type.String({ description: 'the accessible name, with role' })),
  text: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  placeholder: Type.Optional(Type.String()),
  exact: Type.Optional(Type.Boolean()),
  nth: Type.Optional(Type.Integer({ minimum: 0 })),
})

/**
 * The `act` tool's parameters: the action's name and every field an action can carry.
 *
 * @group Dogfood Arena
 */
export const ArenaActToolParameters = Type.Object({
  action: Type.String({
    description:
      'read | click | fill | press | hover | select | goto | back | reload | screenshot | wait | note | restart-enso | stop',
  }),
  target: Type.Optional(ArenaTargetParameters),
  text: Type.Optional(Type.String({ description: 'fill: what to type' })),
  key: Type.Optional(Type.String({ description: 'press: Enter, Escape, Control+K, …' })),
  path: Type.Optional(Type.String({ description: 'goto: a path on Enso’s page, like "/"' })),
  option: Type.Optional(Type.String({ description: 'select: the option' })),
  ms: Type.Optional(Type.Number({ description: 'wait: milliseconds, at most 60000' })),
  note: Type.Optional(Type.String({ description: 'note: wish | friction | retrospective' })),
  trying: Type.Optional(Type.String()),
  happened: Type.Optional(Type.String()),
  wanted: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String({ description: 'stop: why' })),
})
/** @group Dogfood Arena */
export type ArenaActToolParameters = Static<typeof ArenaActToolParameters>
