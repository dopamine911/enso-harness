import { expect, test } from 'bun:test'
import { type EnsoSystemPromptPreview, serializeLibraryPrompt, utf8Bytes } from '@enso/core'
import {
  blankDraft,
  copyDraft,
  type EditorDraft,
  fileBytes,
  isDirty,
  newState,
  openedState,
  runtimeDefaultDraft,
  saveDraft,
  saveRefusal,
  savedState,
} from '../prompt-editor-state.ts'

/**
 * #443: the prompt manager's editor as data — what is unsaved, what may be saved, what a copy of
 * pi's default holds, and a rename's order: the new file first, then the old one removed.
 */

const SAVED = {
  id: 'reviewer',
  name: 'Reviewer',
  description: '',
  category: 'system' as const,
  body: 'Say what breaks.',
}
const OPENED = openedState({ ...SAVED, bytes: 1, tokens: 1 })

test('a prompt opened from its file is clean until a field changes; a new one is unsaved from the start', () => {
  expect(isDirty(OPENED)).toBe(false)
  expect(isDirty({ ...OPENED, draft: { ...OPENED.draft, body: 'Say more.' } })).toBe(true)
  expect(isDirty({ ...OPENED, draft: { ...OPENED.draft, id: 'reviewer-2' } })).toBe(true)
  expect(isDirty(newState(blankDraft()))).toBe(true)
})

test('the file size is the file as written, frontmatter included — exact bytes', () => {
  const draft: EditorDraft = { ...SAVED, body: 'é — twice the bytes' }
  const { id: _id, ...fields } = draft
  expect(fileBytes(draft)).toBe(utf8Bytes(serializeLibraryPrompt(fields)))
})

test('a save is refused for a file name that is not one, an empty name, or a name another prompt holds', () => {
  const taken = new Set(['reviewer', 'haiku'])
  expect(saveRefusal(newState({ ...SAVED, id: 'Bad Name' }), taken)).toContain('lowercase words joined by hyphens')
  expect(saveRefusal(newState({ ...SAVED, id: 'fresh', name: '  ' }), taken)).toBe('the prompt needs a name')
  expect(saveRefusal(newState({ ...SAVED, id: 'haiku' }), taken)).toBe('a prompt is already saved as haiku.md')
  // Its own name is not taken from itself.
  expect(saveRefusal({ ...OPENED, draft: { ...OPENED.draft, body: 'x' } }, taken)).toBeUndefined()
})

test("a copy of pi's default holds exactly the sections a system prompt takes the place of", () => {
  const section = (name: string, text: string): EnsoSystemPromptPreview['sections'][number] => ({
    name,
    origin: 'pi',
    text,
    tokens: 1,
  })
  const preview: EnsoSystemPromptPreview = {
    prompt: null,
    sections: [
      section('preamble', 'You are pi.'),
      section('tools', '<tools>\n- read\n</tools>'),
      section('rules', '<rules>\n- Be concise\n</rules>'),
      section('docs', '<docs>\n…\n</docs>'),
      section('project_context', '<project_context>\nAGENTS\n</project_context>'),
      section('cwd', '<cwd>\n/r\n</cwd>'),
    ],
    tools: [],
    totalTokens: 6,
    contextWindow: null,
  }
  expect(runtimeDefaultDraft(preview)).toEqual({
    id: 'pi-default-copy',
    name: "pi's default (copy)",
    description: '',
    category: 'system',
    body: 'You are pi.\n\n<tools>\n- read\n</tools>\n\n<rules>\n- Be concise\n</rules>\n\n<docs>\n…\n</docs>',
  })
  expect(copyDraft(SAVED)).toMatchObject({ id: 'reviewer-copy', name: 'Reviewer (copy)', body: SAVED.body })
})

/** A server that answers each request from `answers` in turn, recording what was asked. */
function scripted(answers: Response[]): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    fetch: (input: string, init?: RequestInit): Promise<Response> => {
      asked.push(`${init?.method ?? 'GET'} ${input}`)
      const next = answers.shift()
      return next === undefined ? Promise.reject(new Error('unscripted request')) : Promise.resolve(next)
    },
  }
}

const readBack = (id: string): Response => Response.json({ ...SAVED, id, bytes: 1, tokens: 1 })

test('⚠ a rename writes the new file FIRST, then removes the old one; a failed write removes nothing', async () => {
  const renamed = { ...OPENED, draft: { ...OPENED.draft, id: 'reviewer-v2' } }
  const server = scripted([readBack('reviewer-v2'), new Response(null, { status: 204 })])
  expect(await saveDraft(renamed, new Set(['reviewer']), server.fetch)).toMatchObject({
    kind: 'saved',
    prompt: { id: 'reviewer-v2' },
  })
  expect(server.asked).toEqual(['PUT /api/prompts/reviewer-v2', 'DELETE /api/prompts/reviewer'])

  const failing = scripted([new Response('disk full', { status: 500 })])
  expect(await saveDraft(renamed, new Set(['reviewer']), failing.fetch)).toEqual({
    kind: 'refused',
    reason: 'disk full',
  })
  expect(failing.asked).toEqual(['PUT /api/prompts/reviewer-v2'])

  const stuck = scripted([readBack('reviewer-v2'), new Response('busy', { status: 500 })])
  expect(await saveDraft(renamed, new Set(['reviewer']), stuck.fetch)).toEqual({
    kind: 'refused',
    reason: 'saved as reviewer-v2.md, but reviewer.md was not removed: busy',
  })
})

test('a save that is refused before it is sent sends nothing', async () => {
  const server = scripted([])
  expect(await saveDraft(newState({ ...SAVED, id: 'reviewer' }), new Set(['reviewer']), server.fetch)).toEqual({
    kind: 'refused',
    reason: 'a prompt is already saved as reviewer.md',
  })
  expect(server.asked).toEqual([])
})

test('a save that answers keeps a draft typed on since it went out, unsaved; with none, the file is the editor', () => {
  const sent = { ...OPENED.draft, body: 'sent' }
  const prompt = { ...SAVED, body: 'sent', bytes: 1, tokens: 1 }
  const unchanged = savedState({ saved: OPENED.saved, draft: sent }, sent, prompt)
  expect(unchanged).toEqual(openedState(prompt))
  expect(isDirty(unchanged)).toBe(false)
  const typedOn = { ...sent, body: 'sent, and more' }
  const kept = savedState({ saved: OPENED.saved, draft: typedOn }, sent, prompt)
  expect(kept.draft).toBe(typedOn)
  expect(kept.saved).toEqual(openedState(prompt).saved)
  expect(isDirty(kept)).toBe(true)
  expect(savedState(undefined, sent, prompt)).toEqual(openedState(prompt))
})
