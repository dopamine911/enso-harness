import { expect, test } from 'bun:test'
import type { MessagePart, UIMessage } from '@tanstack/ai-client'
import { createTranscriptSelector, type TranscriptSelection } from '../transcript-selection.ts'

/**
 * The transcript's selection, kept between chunks (#739). Per streamed chunk the page used to
 * select every message again — 3.65 ms at 5,319 messages, per token. These pin the two halves of
 * keeping it instead: a chunk re-selects only the message it changed (the rows it did not touch are
 * the SAME objects, which a whole-list rebuild never returns), and what the kept selection draws is
 * exactly what selecting the whole list draws — pairing across messages included.
 */

const textPart = (content: string): MessagePart => ({ type: 'text', content })
const message = (id: string, role: 'user' | 'assistant', parts: MessagePart[]): UIMessage => ({ id, role, parts })
const callPart = (id: string): MessagePart => ({
  type: 'tool-call',
  id,
  name: 'bash',
  arguments: '{"command":"ls"}',
  state: 'input-complete',
})
const resultPart = (toolCallId: string): MessagePart => ({
  type: 'tool-result',
  toolCallId,
  content: 'a.ts b.ts',
  state: 'complete',
})

/** What each row draws, comparably: its flags, and per part its key, kind and whether a call has its result. */
function drawn(selection: TranscriptSelection, messages: readonly UIMessage[]): unknown[] {
  return messages.map(({ id }) => {
    const row = selection.rowOf(id)
    return {
      id,
      hidden: row?.hidden,
      speaker: row?.speaker,
      promptName: row?.promptName,
      parts: row?.parts.map(({ partKey, selected }) => [
        partKey,
        selected.key,
        selected.key === 'toolCall' ? selected.result !== undefined : undefined,
      ]),
    }
  })
}

/** The oracle: a selector that has seen nothing before, which selects the whole list. */
const wholeList = (messages: readonly UIMessage[], promptsBefore = 0): unknown[] =>
  drawn(createTranscriptSelector()(messages, false, promptsBefore), messages)

test('a streamed chunk selects again only the message it changed: every other row is the same object (#739)', () => {
  const opening = [
    message('u1', 'user', [textPart('list the files')]),
    message('a1', 'assistant', [textPart('looking'), callPart('c1'), resultPart('c1')]),
    message('u2', 'user', [textPart('and the tests')]),
    message('a2', 'assistant', [textPart('the tests are')]),
  ]
  const select = createTranscriptSelector()
  const first = select(opening, true, 0)
  const before = opening.map(({ id }) => first.rowOf(id))
  // TanStack's shape for a delta: a new object for the message it changed, the rest kept.
  const streamed = [...opening.slice(0, 3), message('a2', 'assistant', [textPart('the tests are green')])]
  const next = select(streamed, true, 0)
  for (const [position, { id }] of opening.slice(0, 3).entries()) expect(next.rowOf(id)).toBe(before[position])
  expect(next.rowOf('a2')).not.toBe(before[3])
  expect(next.rowOf('a2')?.parts[0]?.selected.part).toBe(streamed[3]?.parts[0])
  // No message added or removed: the id set the lines are placed by is the same object.
  expect(next.messageIds).toBe(first.messageIds)
  expect(drawn(next, streamed)).toEqual(wholeList(streamed))
})

test('a result that lands on a LATER message completes the call in the earlier row, as selecting the whole list does (#280)', () => {
  const select = createTranscriptSelector()
  const calling = [message('u1', 'user', [textPart('list them')]), message('a1', 'assistant', [callPart('c3')])]
  select(calling, true, 0)
  expect(drawn(select(calling, true, 0), calling)).toEqual(wholeList(calling))
  // pi claims a queued prompt: the result belongs to the new message, the call stays where it was.
  const answered = [
    ...calling,
    message('u2', 'user', [textPart('queued')]),
    message('a2', 'assistant', [resultPart('c3'), textPart('two files')]),
  ]
  const selection = select(answered, true, 0)
  expect(selection.rowOf('a1')?.parts[0]?.selected).toMatchObject({ key: 'toolCall', result: { toolCallId: 'c3' } })
  expect(drawn(selection, answered)).toEqual(wholeList(answered))
  // A stop takes the queued prompt's bubbles back: a removal, so the whole list is selected again.
  expect(drawn(select(calling, false, 0), calling)).toEqual(wholeList(calling))
})

test('an empty attempt is hidden once a message follows it, and the speaker line is said once per turn (#382)', () => {
  const select = createTranscriptSelector()
  const attempt = [message('u1', 'user', [textPart('hi')]), message('a1', 'assistant', [])]
  expect(select(attempt, true, 0).rowOf('a1')?.hidden).toBe(false)
  const retried = [
    ...attempt,
    message('a2', 'assistant', [textPart('hello')]),
    message('a3', 'assistant', [textPart('more')]),
  ]
  const selection = select(retried, true, 0)
  expect(drawn(selection, retried)).toEqual(wholeList(retried))
  expect(selection.rowOf('a1')?.hidden).toBe(true)
  expect([selection.rowOf('a2')?.speaker, selection.rowOf('a3')?.speaker]).toEqual([true, false])
  expect([...selection.openRunMessageIds]).toEqual(['a3', 'a2', 'a1'])
})

test('a prompt is numbered among the branch’s prompts: counted on from the ones before the page (#739)', () => {
  const page = [message('u5', 'user', [textPart('continue')]), message('a5', 'assistant', [textPart('ok')])]
  const select = createTranscriptSelector()
  expect(select(page, false, 4).rowOf('u5')?.promptName).toBe('prompt 5: “continue”')
  // "Load earlier" moved the count back: the same messages are numbered again.
  const loaded = [message('u4', 'user', [textPart('go on')]), message('a4', 'assistant', [textPart('ok')]), ...page]
  const selection = select(loaded, false, 3)
  expect([selection.rowOf('u4')?.promptName, selection.rowOf('u5')?.promptName]).toEqual([
    'prompt 4: “go on”',
    'prompt 5: “continue”',
  ])
  expect(drawn(selection, loaded)).toEqual(wholeList(loaded, 3))
})
