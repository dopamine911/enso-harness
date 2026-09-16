import { expect, test } from 'bun:test'
import { Check } from 'typebox/value'
import {
  isZenToolResultDescriptor,
  PromptImageContent,
  ZenObservation,
  ZenToolResultDescriptor,
  ZenUsage,
} from '../index.ts'

/**
 * These prove the TypeBox conversion bought RUNTIME VALIDATION and a JSON Schema, not just
 * types. Without them the schemas would be decorative — the "built claims need a caller"
 * failure, applied to a refactor of my own.
 */

// --- the schemas really are JSON Schema objects, which is the reason for choosing TypeBox
test('a schema is literally a JSON Schema object', () => {
  expect(ZenToolResultDescriptor).toMatchObject({ type: 'object' })
  expect(ZenToolResultDescriptor.required).toContain('kind')
  expect(ZenToolResultDescriptor.required).toContain('props')
  // optional fields are absent from `required`, which is what an OpenAPI consumer reads
  expect(ZenToolResultDescriptor.required).not.toContain('truncated')
})

test('the observation union is expressed as a JSON Schema union', () => expect(ZenObservation).toHaveProperty('anyOf'))

// --- and the validators actually reject
test('the descriptor validator rejects every malformed shape', () => {
  expect(isZenToolResultDescriptor({ kind: 'diff', props: {} })).toBe(true)
  expect(isZenToolResultDescriptor({ kind: '', props: {} })).toBe(false)
  expect(isZenToolResultDescriptor({ kind: 'diff' })).toBe(false)
  expect(isZenToolResultDescriptor({ props: {} })).toBe(false)
  expect(isZenToolResultDescriptor('diff')).toBe(false)
  expect(isZenToolResultDescriptor(null)).toBe(false)
})

test('a negative truncation count is rejected, not silently rendered', () =>
  expect(isZenToolResultDescriptor({ kind: 'd', props: {}, truncated: { shown: -1, total: 5, unit: 'lines' } })).toBe(
    false,
  ))

test('an unknown truncation unit is rejected by the schema', () =>
  expect(isZenToolResultDescriptor({ kind: 'd', props: {}, truncated: { shown: 1, total: 5, unit: 'furlongs' } })).toBe(
    false,
  ))

test('usage rejects non-integer token counts', () => {
  expect(Check(ZenUsage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(true)
  expect(Check(ZenUsage, { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(false)
  expect(Check(ZenUsage, { input: 1, output: 2 })).toBe(false)
})

// --- pi wire schemas
test('image content is validated, so a malformed attachment fails at the boundary', () => {
  expect(Check(PromptImageContent, { type: 'image', data: 'aGk=', mimeType: 'image/png' })).toBe(true)
  expect(Check(PromptImageContent, { type: 'file', data: 'aGk=', mimeType: 'image/png' })).toBe(false)
  expect(Check(PromptImageContent, { type: 'image', data: 'aGk=' })).toBe(false)
})
