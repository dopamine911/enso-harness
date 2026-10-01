import { expect, test } from 'bun:test'
import { contentToText, customEntriesOf, transcriptOf } from '../runtime-entries.ts'

/**
 * The one module in `core` that names the runtime's stored entry shape (#557). What it promises
 * every fold: a transcript as long as the branch, in its order; every entry kind said as what it
 * is; nothing invented. The folds' own tests feed records; this is where the records come from.
 */

test('⚠ as long as the branch, in its order: an entry kind the decoder does not model is `other` with its type, never dropped', () => {
  const transcript = transcriptOf([
    { type: 'model_change', id: 'a', provider: 'anthropic', modelId: 'x' },
    { type: 'custom', id: 'b', customType: 'enso-run-context', data: { rulesHash: 'h' } },
    { type: 'message', id: 'c', message: { role: 'system', content: 'ignored by the walk' } },
    { type: 'message', id: 'd', message: 'not an object' },
    'not an entry at all',
    { type: 'compaction', id: 'f' },
  ])
  expect(transcript.map((entry) => entry.kind)).toEqual(['other', 'custom', 'other', 'other', 'other', 'other'])
  expect(transcript.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'entry-4', 'f'])
  // The `other` row names what it was — the drawer counts these by type.
  expect(transcript.flatMap((entry) => (entry.kind === 'other' ? [entry.type] : []))).toEqual([
    'model_change',
    'message:system',
    'message:malformed',
    'unknown',
    'compaction',
  ])
})

test('a custom entry keeps its customType, data and stamp; a message its role and parts; a result its call id, text and error flag', () => {
  const [custom, prompt, reply, result, okResult] = transcriptOf([
    {
      type: 'custom',
      id: 'c',
      timestamp: '2026-01-01T00:00:00.000Z',
      customType: 'active_agent',
      data: { name: null },
    },
    { type: 'message', id: 'u', message: { role: 'user', content: 'a bare prompt' } },
    {
      type: 'message',
      id: 'r',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'thinking', thinking: 'hm' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
          { type: 'toolCall', id: 'call-2', name: 'read' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'audio', data: '...' },
          'not a part',
        ],
      },
    },
    {
      type: 'message',
      id: 't',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        isError: true,
        content: [
          { type: 'text', text: 'out' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
        ],
      },
    },
    { type: 'message', id: 't2', message: { role: 'toolResult', toolCallId: 'call-2', content: 'plain' } },
  ])
  expect(custom).toEqual({
    kind: 'custom',
    id: 'c',
    at: '2026-01-01T00:00:00.000Z',
    customType: 'active_agent',
    data: { name: null },
  })
  expect(prompt).toEqual({ kind: 'message', id: 'u', role: 'user', parts: [{ type: 'text', text: 'a bare prompt' }] })
  expect(reply).toEqual({
    kind: 'message',
    id: 'r',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hm' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
      // A call without arguments has `{}`: the risk fold reads `args.command` off it.
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'read', args: {} },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'other', kind: 'audio' },
    ],
  })
  // A non-text part is NAMED in the text, never dropped (`transcript-reveal.ts` reads the naming).
  expect(result).toEqual({
    kind: 'tool-result',
    id: 't',
    toolCallId: 'call-1',
    toolName: 'bash',
    text: 'out[image content]',
    isError: true,
  })
  expect(okResult).toMatchObject({ kind: 'tool-result', toolName: 'unknown', text: 'plain', isError: false })
})

test('customEntriesOf keeps the custom entries only, in order; contentToText names a non-text part and reads a bare string', () => {
  const transcript = transcriptOf([
    { type: 'custom', id: '1', customType: 'a', data: 1 },
    { type: 'message', id: '2', message: { role: 'user', content: 'x' } },
    { type: 'custom', id: '3', customType: 'b', data: 2 },
  ])
  expect(customEntriesOf(transcript).map((entry) => entry.customType)).toEqual(['a', 'b'])
  expect(contentToText('bare')).toBe('bare')
  expect(contentToText([{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'b' }, {}])).toBe(
    'a[thinking content][unknown content]',
  )
  expect(contentToText(undefined)).toBe('')
})
