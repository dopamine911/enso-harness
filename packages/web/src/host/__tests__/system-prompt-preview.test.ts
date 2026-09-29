import { expect, test } from 'bun:test'
import { splitRenderedPrompt } from '../system-prompt-preview.ts'

/**
 * #443: the preview splits pi's rendering — the preamble, then each section inside its tags, joined
 * by blank lines — and refuses a rendering that does not split back into exactly itself.
 */

const PI_PREAMBLE = 'You are an expert coding assistant operating inside pi.'
const join = (...parts: string[]): string => parts.join('\n\n')

test("pi's rendering splits into its preamble and each tagged section, and re-joins byte for byte", () => {
  const rendered = join(
    PI_PREAMBLE,
    '<tools>\n- read\n- bash\n</tools>',
    '<rules>\n- Be concise\n</rules>',
    '<cwd>\n/repo\n</cwd>',
  )
  expect(splitRenderedPrompt(rendered, undefined)).toEqual([
    { name: 'preamble', text: PI_PREAMBLE },
    { name: 'tools', text: '<tools>\n- read\n- bash\n</tools>' },
    { name: 'rules', text: '<rules>\n- Be concise\n</rules>' },
    { name: 'cwd', text: '<cwd>\n/repo\n</cwd>' },
  ])
})

test('a known preamble that itself holds a tag and a blank line is taken whole, not split at its first section-like line', () => {
  const custom = '# Reviewer\n\n<tools>\nnot a section\n</tools>\n\nSay what breaks.'
  const rendered = join(custom, '<cwd>\n/repo\n</cwd>')
  expect(splitRenderedPrompt(rendered, custom)).toEqual([
    { name: 'preamble', text: custom },
    { name: 'cwd', text: '<cwd>\n/repo\n</cwd>' },
  ])
})

test('a section whose body holds its own closing tag mid-text ends at the close that ends a section', () => {
  const body = '<project_context>\nsee </project_context> in AGENTS.md\n</project_context>'
  expect(
    splitRenderedPrompt(join(PI_PREAMBLE, body, '<cwd>\n/r\n</cwd>'), undefined)?.map((section) => section.text),
  ).toEqual([PI_PREAMBLE, body, '<cwd>\n/r\n</cwd>'])
})

test('a rendering that does not split back is refused: a stray tail, a section never closed, a preamble that is not there', () => {
  expect(splitRenderedPrompt(join(PI_PREAMBLE, '<cwd>\n/r\n</cwd>', 'plain text'), undefined)).toBeUndefined()
  expect(splitRenderedPrompt(join(PI_PREAMBLE, '<cwd>\n/repo'), undefined)).toBeUndefined()
  expect(splitRenderedPrompt(join('other', '<cwd>\n/r\n</cwd>'), 'mine')).toBeUndefined()
  expect(splitRenderedPrompt('', undefined)).toBeUndefined()
})
