import { type Static, type TNumber, type TOptional, Type } from 'typebox'
import { ARENA_VIEW, POINT_FIELDS } from './actions.ts'
import { ARENA_READ_REGIONS } from './read-regions.ts'

/**
 * Dogfood Arena's agent tool (#556, #584): the parameters of `act`, the ONE tool the agent under
 * test is given (`agent.ts`). Each call is one move a person makes in a browser — performed by the
 * recorder on its page. Two shapes, one per perception (#680): a tree agent reads the page and names
 * controls; a visual agent sees a screenshot and points at x,y.
 *
 * Every field but `action` is optional: the schema tells the model the shape, and the recorder's
 * own parser (`actions.ts#parseArenaAction`) is the check — it refuses a selector, a
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

/** An optional number field with what it is for: the model reads the description. */
const numberField = (description: string): TOptional<TNumber> => Type.Optional(Type.Number({ description }))

/** The fields both perceptions share: keys, paths, waits, tabs, notes, the stop. */
const SHARED_FIELDS = {
  key: Type.Optional(Type.String({ description: 'press: Enter, Escape, Control+K, …' })),
  path: Type.Optional(Type.String({ description: 'goto: a path on Enso’s page, like "/"' })),
  ms: numberField('wait: milliseconds, at most 60000'),
  until: Type.Optional(Type.String({ description: 'wait: "attention" (Enso needs you or is done) or "change"' })),
  tab: Type.Optional(Type.Integer({ minimum: 0, description: 'switch-tab, close-tab: a tab number from `tabs`' })),
  note: Type.Optional(Type.String({ description: 'note: wish | friction | retrospective' })),
  trying: Type.Optional(Type.String({ description: 'note: what you were trying to do' })),
  happened: Type.Optional(Type.String({ description: 'note: what happened instead' })),
  wanted: Type.Optional(Type.String({ description: 'note, a wish: what you wanted to be there' })),
  reason: Type.Optional(Type.String({ description: 'stop: why' })),
}

/** The actions both perceptions take, after each one's own. */
const SHARED_ACTIONS =
  'press | goto | back | reload | screenshot | wait | note | accept-dialog | dismiss-dialog | tabs | switch-tab | close-tab | restart-enso | stop'

/**
 * The tree agent's `act` parameters: the action's name and every field an action can carry.
 *
 * @group Dogfood Arena
 */
export const ArenaActToolParameters = Type.Object({
  action: Type.String({ description: `read | click | fill | hover | select | ${SHARED_ACTIONS}` }),
  target: Type.Optional(ArenaTargetParameters),
  text: Type.Optional(Type.String({ description: 'fill: what to type; accept-dialog: a prompt dialog’s answer' })),
  option: Type.Optional(Type.String({ description: 'select: the option' })),
  region: Type.Optional(
    Type.String({
      description: `read: ${Object.keys(ARENA_READ_REGIONS).join(' | ')}; by default the open dialog, else chat`,
    }),
  ),
  full: Type.Optional(
    Type.Boolean({ description: 'read: true for the region whole, not what changed since your last read of it' }),
  ),
  ...SHARED_FIELDS,
})
/** @group Dogfood Arena */
export type ArenaActToolParameters = Static<typeof ArenaActToolParameters>

const ON_THE_VIEW = `on the ${ARENA_VIEW.width}×${ARENA_VIEW.height} screenshot`

/**
 * The visual agent's `act` parameters (#680): points on the screenshot it was shown, keys and text.
 * No target and no `read`: it knows the page only by the picture. The point's wire names are the
 * models' and the protocol's convention, `x` and `y` (`POINT_FIELDS`).
 *
 * @group Dogfood Arena
 */
export const ArenaVisualActToolParameters = Type.Object({
  action: Type.String({ description: `click | move | scroll | drag | type | ${SHARED_ACTIONS}` }),
  [POINT_FIELDS.horizontal]: numberField(`click, move, scroll, drag: pixels from the left ${ON_THE_VIEW}`),
  [POINT_FIELDS.vertical]: numberField(`click, move, scroll, drag: pixels from the top ${ON_THE_VIEW}`),
  toX: numberField(`drag: where to release, from the left ${ON_THE_VIEW}`),
  toY: numberField(`drag: where to release, from the top ${ON_THE_VIEW}`),
  dx: numberField('scroll: pixels sideways (right is positive)'),
  dy: numberField('scroll: pixels down (up is negative)'),
  button: Type.Optional(Type.String({ description: 'click: "right" or "middle"; left by default' })),
  double: Type.Optional(Type.Boolean({ description: 'click: a double click' })),
  text: Type.Optional(
    Type.String({ description: 'type: what to type into whatever has focus; accept-dialog: a prompt dialog’s answer' }),
  ),
  ...SHARED_FIELDS,
})
/** @group Dogfood Arena */
export type ArenaVisualActToolParameters = Static<typeof ArenaVisualActToolParameters>
