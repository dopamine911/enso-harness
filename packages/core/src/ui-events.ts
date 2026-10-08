import { type Static, Type } from 'typebox'

/**
 * UI events (#737): the page announces its own state changes as DOM `CustomEvent`s on `document`,
 * dispatched by the component that renders the state, at the moment it renders it. Something
 * waiting on the page — the Dogfood Arena's `wait until attention`, the browser suite — listens
 * instead of sampling the accessibility tree and parsing words out of it (`THREAD_STATUS_WORDS`
 * stays the contract for a reader; this is the contract for a listener).
 *
 * ⚠ FROM THE RENDER, NEVER FROM THE SERVER. A listener's claim is "a person looking at the page
 * would have seen this": an event fired by the component that shows the state cannot fire for a
 * state the page failed to show, which a server-side hook would.
 *
 * The names and `detail` shapes live here so the web app (the dispatcher) and the arena (a
 * listener, which may import core only) share one definition.
 *
 * @group UI events
 */
export const ENSO_UI_EVENTS = {
  /** The shown thread's status bar: what the run is doing, and whether it needs the person. */
  threadStatus: 'enso:thread-status',
} as const

/** @group UI events */
export type EnsoUiEventName = (typeof ENSO_UI_EVENTS)[keyof typeof ENSO_UI_EVENTS]

/**
 * What the thread's status bar says a listener could act on: `running` while pi works (whatever
 * the bar's finer word — working, thinking, running a tool, responding), `question` while pi waits
 * on an answer, `idle` at rest (before the first prompt, after a reply, after a failed run),
 * `disconnected` once the thread's follow ended (#119). When several hold, the first of
 * `disconnected`, `question`, `idle`: a dead connection is said over a question nobody can answer
 * through it.
 *
 * @group UI events
 */
export const EnsoThreadStatusKind = Type.Union([
  Type.Literal('running'),
  Type.Literal('question'),
  Type.Literal('idle'),
  Type.Literal('disconnected'),
])
/** @group UI events */
export type EnsoThreadStatusKind = Static<typeof EnsoThreadStatusKind>

/**
 * `enso:thread-status`'s `detail`: dispatched by a thread's status bar on mount and whenever any
 * field changes. Every mounted pane keeps its bar (#472), so `shown` says whether this one is the
 * pane on screen — what the person sees — and a listener ignores the rest.
 *
 * @group UI events
 */
export const EnsoThreadStatusEvent = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
    /** True for the pane on screen; false for a mounted pane the rail has switched away from. */
    shown: Type.Boolean(),
    status: EnsoThreadStatusKind,
    /** The open question, with `status: 'question'`: its id is unique per question, its title the card's heading. */
    question: Type.Optional(
      Type.Object({ id: Type.String({ minLength: 1 }), title: Type.String() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
)
/** @group UI events */
export type EnsoThreadStatusEvent = Static<typeof EnsoThreadStatusEvent>
