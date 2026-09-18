import { expect, test } from 'bun:test'
import { createFixtureChat } from '../fixture-conversation.ts'

/**
 * The compatibility probe that used to live in a PR body (#218).
 *
 * ⚠ Enforcement of a dependency FACT, not a unit test of the fixture's prose. The styling
 * page is scripted through `@shadcn/helpers/tanstack-ai`, whose peer range names
 * `@tanstack/ai` 0.40 while this repo runs 0.53 — deliberately, on the strength of one
 * observation: thinking, tool-call, tool-result and text parts all materialize. That
 * observation was a manual probe recorded in prose (`fixture-conversation.ts`'s header),
 * which is why `bun run check` and `bun run e2e` both passed with the helper entirely
 * unexercised — no test imports it and no e2e spec visits `?fixture`. This is that probe,
 * in the tree, so a `@tanstack/ai` bump or a new 0.2.x of the helper goes RED here instead
 * of silently breaking the styling loop. The version pair it is a probe OF is pinned in
 * `test/dependency-gate.test.ts`; the two are one gate in two halves.
 *
 * `get()` materializes the scripted turns synchronously — no transport, no clock — so this
 * reads the helper's part-building end to end without a DOM or a timer.
 *
 * ⚠ What it does NOT cover, because the helper cannot produce it: the error turn
 * materializes no part at all (`writer.error` is a stream chunk, not a message part), so
 * `RunProblem`'s styling is verified on the live page, and a #27 dialog interrupt has no
 * writer operation at all — stated in the fixture's own header.
 */

interface MaterializedPart {
  readonly type: string
}

/** Every part kind the scripted conversation materializes, deduplicated. */
function materializedPartKinds(): string[] {
  const messages = createFixtureChat().get() as ReadonlyArray<{ parts?: readonly MaterializedPart[] }>
  const kinds = new Set(messages.flatMap((message) => (message.parts ?? []).map((part) => part.type)))
  return [...kinds].sort()
}

test('⚠ the fixture materializes thinking, tool-call, tool-result and text through @shadcn/helpers (#218)', () => {
  expect(materializedPartKinds()).toEqual(['text', 'thinking', 'tool-call', 'tool-result'])
})
