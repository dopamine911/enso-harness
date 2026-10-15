import { expect, test } from 'bun:test'
import type { UIMessage } from '@tanstack/ai-client'
import { parsePartialJson, pendingWrite } from '../live-request.ts'

/**
 * #913: a `write` or an `edit` the run has in hand and has not applied — read off arguments cut
 * anywhere while they stream, and off the transcript once the call is whole.
 */

test('arguments cut anywhere read as far as they go: mid-string, mid-escape, between a key and its value', () => {
  expect(parsePartialJson('{"path":"site/a.html","content":"<p>a\\nb')).toEqual({
    path: 'site/a.html',
    content: '<p>a\nb',
  })
  // An escape cut in half is dropped, not misread.
  expect(parsePartialJson('{"content":"a\\')).toEqual({ content: 'a' })
  expect(parsePartialJson('{"content":"a\\u00')).toEqual({ content: 'a' })
  expect(parsePartialJson('{"content":"a\\u00e9')).toEqual({ content: 'aé' })
  // A key cut short, or one with no value yet, is absent.
  expect(parsePartialJson('{"path":"x","cont')).toEqual({ path: 'x' })
  expect(parsePartialJson('{"path":"x","content":')).toEqual({ path: 'x' })
  // A quote escaped inside the content is content, not the start of a key.
  expect(parsePartialJson('{"content":"say \\"path\\": no","path":"p"}')).toEqual({
    content: 'say "path": no',
    path: 'p',
  })
  expect(parsePartialJson('{"path":"p","edits":[{"oldText":"a","newText":"b"},{"oldText":"c')).toEqual({
    path: 'p',
    edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c' }],
  })
  expect(parsePartialJson('')).toBeUndefined()
})

const NONE = new Map<string, unknown>()
const user = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', content: 'go' }] })
const writeCall = (id: string, args: string): UIMessage['parts'][number] => ({
  type: 'tool-call',
  id,
  name: 'write',
  arguments: args,
  state: 'input-complete',
})
const assistant = (id: string, parts: UIMessage['parts']): UIMessage => ({ id, role: 'assistant', parts })
const ARGS = '{"path":"site/a.html","content":"<p>hi</p>"}'

test('the call being composed is pending while it streams; a call that is not a file change is not', () => {
  const composing = { toolCallId: 'w1', toolName: 'write', args: '{"path":"site/a.html","content":"<p>h' }
  expect(pendingWrite([user('u')], composing, NONE, true)).toMatchObject({
    state: 'composing',
    change: { tool: 'write', path: 'site/a.html', content: '<p>h', size: composing.args.length },
  })
  expect(pendingWrite([user('u')], { ...composing, toolName: 'bash', args: '{"command":"ls' }, NONE, true)).toBe(
    undefined,
  )
})

test('⚠ whole and unanswered it stays not applied; applied it is gone; refused or failed it says so — never applied', () => {
  const asked = [user('u'), assistant('a', [writeCall('w1', ARGS)])]
  expect(pendingWrite(asked, undefined, NONE, true)).toMatchObject({
    state: 'judging',
    change: { path: 'site/a.html' },
  })
  // The run ended with no answer (a Stop): nothing is claimed of it.
  expect(pendingWrite(asked, undefined, NONE, false)).toBeUndefined()
  const answered = (result: UIMessage['parts'][number]): UIMessage[] => [
    user('u'),
    assistant('a', [writeCall('w1', ARGS)]),
    // The server may stamp a result onto a later message than its call's.
    assistant('b', [result]),
  ]
  const applied = answered({ type: 'tool-result', toolCallId: 'w1', content: 'wrote 9 bytes', state: 'complete' })
  expect(pendingWrite(applied, undefined, NONE, true)).toBeUndefined()
  const error = {
    type: 'tool-result',
    toolCallId: 'w1',
    content: 'outside the project',
    state: 'error',
    error: 'outside the project',
  } as const
  expect(pendingWrite(answered(error), undefined, new Map([['w1', {}]]), true)).toEqual({
    state: 'refused',
    change: expect.objectContaining({ path: 'site/a.html' }),
    reason: 'outside the project',
  })
  expect(pendingWrite(answered(error), undefined, NONE, false)).toMatchObject({ state: 'failed' })
  // A new prompt starts over: an earlier prompt's write is not pending.
  expect(pendingWrite([...answered(error), user('u2')], undefined, NONE, true)).toBeUndefined()
})
