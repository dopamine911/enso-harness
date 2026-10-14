import { type TObject, type TProperties, Type } from 'typebox'

/**
 * The shapes the #904 wire schemas (`providers.ts`, `model-roles.ts`) are built from: an object
 * that holds its listed keys and no other, and a string that is never empty.
 */

/**
 * An object of `properties` and no other key.
 *
 * @group Providers
 */
export function closedObject<Properties extends TProperties>(properties: Properties): TObject<Properties> {
  return Type.Object(properties, { additionalProperties: false })
}

/**
 * A string with at least one character: an id, a name, a model's option id.
 *
 * @group Providers
 */
export const NonEmptyString = Type.String({ minLength: 1 })
