import { expect, test } from 'bun:test'
import {
  ENSO_SYSTEM_PROMPT_ENTRY,
  estimateTextTokens,
  isLibraryPromptId,
  parseLibraryPrompt,
  readEnsoSystemPromptChoice,
  serializeLibraryPrompt,
  summarizeLibraryPrompt,
  utf8Bytes,
} from '../index.ts'

/**
 * #443: a library prompt is a markdown file with a closed frontmatter block. A file that does not
 * read as one is refused by name — never skipped, never read as something else.
 */

const FILE = [
  '---',
  'name: Reviewer',
  'description: "Reads diffs: carefully"',
  'category: system',
  '---',
  '# Role',
  'Review.',
].join('\n')

test('a library file reads as its fields, its body after the fence, and its sizes', () => {
  const parsed = parseLibraryPrompt('reviewer', FILE)
  expect(parsed).toEqual({
    kind: 'prompt',
    prompt: {
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Reads diffs: carefully',
      category: 'system',
      body: '# Role\nReview.',
      bytes: utf8Bytes(FILE),
      tokens: estimateTextTokens('# Role\nReview.'),
    },
  })
})

test('what the library writes reads back equal, whatever the text holds', () => {
  const written = {
    name: 'Quote " and: colon',
    description: '',
    category: 'append' as const,
    body: '---\nnot a fence\n',
  }
  const parsed = parseLibraryPrompt('quoted', serializeLibraryPrompt(written))
  expect(parsed.kind).toBe('prompt')
  if (parsed.kind !== 'prompt') return
  expect({
    name: parsed.prompt.name,
    description: parsed.prompt.description,
    category: parsed.prompt.category,
  }).toEqual({
    name: written.name,
    description: '',
    category: 'append',
  })
  expect(parsed.prompt.body).toBe(written.body)
  expect(summarizeLibraryPrompt(parsed.prompt)).not.toHaveProperty('body')
})

test('a CRLF body is written LF, so the file is the text every read, hash and size is over; a byte-order mark is read past', () => {
  const serialized = serializeLibraryPrompt({ name: 'Crlf', description: '', category: 'system', body: 'x\r\ny' })
  expect(serialized).not.toContain('\r')
  const parsed = parseLibraryPrompt('crlf', serialized)
  expect(parsed).toMatchObject({ kind: 'prompt', prompt: { body: 'x\ny', bytes: utf8Bytes(serialized) } })
  expect(parseLibraryPrompt('marked', `\uFEFF${FILE}`)).toMatchObject({ kind: 'prompt', prompt: { name: 'Reviewer' } })
})

test.each([
  ['Bad_Name', FILE, 'the name is not lowercase words'],
  ['plain', '# no frontmatter', 'does not open with a --- frontmatter block'],
  ['open', '---\nname: x\ncategory: system', 'never closed'],
  [
    'extra',
    '---\nname: x\ncategory: system\nmodel: opus\n---\n',
    '"model: opus" is not one of name, description, category',
  ],
  ['twice', '---\nname: x\nname: y\ncategory: system\n---\n', 'names name twice'],
  ['nameless', '---\ncategory: system\n---\n', 'has no name'],
  ['kind', '---\nname: x\ncategory: user\n---\n', 'category must be system, append or session'],
  ['quoted', '---\nname: "x\ncategory: system\n---\n', 'name is not a readable string'],
  ['long', `---\nname: ${'n'.repeat(121)}\ncategory: system\n---\n`, 'its name or description is too long'],
])('%s.md is refused by name: %s', (id, text, reason) => {
  const parsed = parseLibraryPrompt(id, text)
  expect(parsed).toEqual({ kind: 'refused', reason: expect.stringContaining(reason) })
  expect(parsed.kind === 'refused' && parsed.reason.startsWith(`${id}.md: `)).toBe(true)
})

test('an id is a file name that cannot leave its directory', () => {
  expect(isLibraryPromptId('code-review-2')).toBe(true)
  for (const bad of ['', '../x', 'a/b', 'a.md', '-lead', 'Upper', 'a'.repeat(65)])
    expect(isLibraryPromptId(bad)).toBe(false)
})

test('sizes: bytes are UTF-8 and exact, tokens are characters over four rounded up', () => {
  expect(utf8Bytes('é')).toBe(2)
  expect(estimateTextTokens('')).toBe(0)
  expect(estimateTextTokens('abcde')).toBe(2)
})

test('a recorded choice reads only in its declared shape', () => {
  const choice = { id: 'reviewer', name: 'Reviewer', mode: 'append' as const, sha256: 'a'.repeat(64), text: 'x' }
  expect(ENSO_SYSTEM_PROMPT_ENTRY).toBe('enso-system-prompt')
  expect(readEnsoSystemPromptChoice(choice)).toEqual(choice)
  expect(readEnsoSystemPromptChoice({ ...choice, mode: 'session' })).toBeUndefined()
  expect(readEnsoSystemPromptChoice({ ...choice, sha256: 'nope' })).toBeUndefined()
  expect(readEnsoSystemPromptChoice({ ...choice, extra: 1 })).toBeUndefined()
})
