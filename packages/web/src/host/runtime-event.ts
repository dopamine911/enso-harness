import { type Static, type TObject, Type } from 'typebox'

/**
 * The runtime's event, as the host receives it — BELOW the thread-runtime seam since #162
 * workstream 4 (L2). Until then this shape was `@enso/core`'s, handed to subscribers and read
 * by a mapper above the host; now the host maps it to `EnsoObservation` before anything
 * subscribes, and the shape is the host's own business. It is the rpc wire shape #69's
 * transport defined, which `session-events.ts` still replicates from the runtime's typed
 * events because the mapper and its tests consume exactly that.
 *
 * ⚠ OPEN ON PURPOSE. Only `type` is constrained, so an unmodelled event validates and is
 * carried (as `unmapped`) rather than rejected: the runtime's event list will grow, and a
 * closed schema would turn a new event type into "the host is broken".
 *
 * ⚠ Open-object types need an explicit intersection: `additionalProperties: Type.Unknown()`
 * makes the SCHEMA accept extra fields, but `Static<>` does not synthesise an index
 * signature from it (typebox 1.3.25). Both halves are needed.
 */
type OpenRecord = Record<string, unknown>

const openObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T): TObject<T> =>
  Type.Object(properties, { additionalProperties: Type.Unknown() })

export const RuntimeEventSchema = openObject({
  type: Type.String({ minLength: 1 }),
})
export type RuntimeEvent = Static<typeof RuntimeEventSchema> & OpenRecord

/**
 * How an event reached the mapper (#96): `replayed` from the host's until-first-subscriber
 * buffer (the session's own start), or `live`.
 *
 * The mapper turns it into an observation's `origin`. The event tail's `held`/`dropped`
 * provenances (#97) never reach the mapper.
 */
export type EventDelivery = 'live' | 'replayed'
