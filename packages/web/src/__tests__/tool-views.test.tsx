import { afterAll, expect, test } from 'bun:test'
import {
  ENSO_IMAGES_KIND,
  ENSO_QUESTIONNAIRE_ANSWERS_KIND,
  ENSO_TOOL_RESULT_KEY,
  ENSO_WRITE_RECEIPT_KIND,
  type EnsoToolResultDescriptor,
} from '@enso/core'
import type { ToolResultPart } from '@tanstack/ai'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type { SelectedMessagePart as SelectedMessagePartComponent } from '../selected-message-part.tsx'
import type { OpenInDiffContext as OpenInDiffContextValue, TOOL_RESULT_RENDERERS as Renderers } from '../tool-views.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// A DOM before react-dom/client evaluates — `command-palette.test.tsx` has why the imports are dynamic.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { SelectedMessagePart }: { SelectedMessagePart: typeof SelectedMessagePartComponent } =
  await import('../selected-message-part.tsx')
const {
  OpenInDiffContext,
  TOOL_RESULT_RENDERERS,
}: { OpenInDiffContext: typeof OpenInDiffContextValue; TOOL_RESULT_RENDERERS: typeof Renderers } =
  await import('../tool-views.tsx')

afterAll(releaseDom)

/**
 * Each tool's card as a person reads it (#920), MOUNTED: the readable form by default, the model's
 * JSON only behind `raw`, and the sanitize tripwires — model-controlled in every argument and result —
 * arriving as inert text in each tool's renderer.
 */

const TRIPWIRES = [
  '<img src="x" onerror="alert(1)">',
  '<a href="javascript:alert(2)">link</a>',
  '<script>alert(3)</script>',
].join(' ')

interface Card {
  readonly element: HTMLElement
  readonly in: () => string
  readonly out: () => string
  readonly pill: () => string
  readonly raw: () => Promise<void>
}

/** One tool call's card, mounted with Enso's renderers, its result paired. */
async function mountCard(
  name: string,
  input: unknown,
  result: Partial<ToolResultPart> & { descriptor?: EnsoToolResultDescriptor },
  openInDiff?: (path: string) => void,
): Promise<Card> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const { descriptor, ...rest } = result
  const paired: ToolResultPart = {
    type: 'tool-result',
    toolCallId: `call-${name}`,
    content: '',
    state: 'complete',
    ...(descriptor === undefined ? {} : { metadata: { [ENSO_TOOL_RESULT_KEY]: descriptor } }),
    ...rest,
  }
  const card = (
    <SelectedMessagePart
      selected={{
        key: 'toolCall',
        part: { type: 'tool-call', id: `call-${name}`, name, arguments: JSON.stringify(input), state: 'complete' },
        input,
        result: paired,
      }}
      isStreaming={false}
      runOpen={false}
      renderers={TOOL_RESULT_RENDERERS}
    />
  )
  await act(async () => {
    createRoot(container).render(
      openInDiff === undefined ? (
        card
      ) : (
        <OpenInDiffContext.Provider value={openInDiff}>{card}</OpenInDiffContext.Provider>
      ),
    )
  })
  const cell = (index: number): string => container.querySelectorAll('details > dl > dd')[index]?.textContent ?? ''
  return {
    element: container,
    in: () => cell(0),
    out: () => cell(1),
    pill: () => container.querySelector('summary')?.lastElementChild?.textContent ?? '',
    raw: async () => {
      const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent === 'raw')
      if (toggle === undefined) throw new Error('no raw switch')
      await act(async () => toggle.click())
    },
  }
}

/** The tripwires reached the page as text, and built no element. */
function expectInert(card: Card): void {
  expect(card.element.textContent).toContain('<script>alert(3)</script>')
  expect(card.element.querySelector('script')).toBeNull()
  expect(card.element.querySelector('a')).toBeNull()
  expect(card.element.querySelector('img[onerror]')).toBeNull()
}

test('bash: the command as written, its labels, and the output as a terminal that exited 0; JSON only behind raw', async () => {
  const card = await mountCard(
    'bash',
    { command: `ls -la\necho ${TRIPWIRES}`, timeout: 30 },
    { content: `total 0\n${TRIPWIRES}` },
  )
  expect(card.in()).toContain('ls -la\necho')
  expect(card.in()).toContain('timeout 30s')
  expect(card.in()).not.toContain('"command"')
  expect(card.out()).toContain('total 0')
  expect(card.out()).toContain('exited 0')
  expectInert(card)
  await card.raw()
  expect(card.in()).toContain('"command": "ls -la\\necho')
  expect(card.in()).toContain('"timeout": 30')
})

test('⚠ bash: a non-zero exit says its code on the step, and the whole output is shown', async () => {
  const output = Array.from({ length: 400 }, (_, line) => `line ${line + 1}`).join('\n')
  const text = `${output}\n\nCommand exited with code 2`
  const card = await mountCard('bash', { command: 'make test' }, { content: text, state: 'error', error: text })
  expect(card.pill()).toBe('exited 2')
  expect(card.out()).toContain('line 1\n')
  expect(card.out()).toContain('line 400')
  expect(card.out()).toContain('Command exited with code 2')
})

test('read: the path and range, the text as a line count over a folded preview', async () => {
  const card = await mountCard(
    'read',
    { path: 'src/x.ts', offset: 10, limit: 3 },
    { content: `one\ntwo\n${TRIPWIRES}` },
  )
  expect(card.in()).toContain('src/x.ts')
  expect(card.in()).toContain('lines 10–12')
  expect(card.out()).toContain('3 lines')
  expect(card.element.querySelector('dd details:not([open])')).not.toBeNull()
  expectInert(card)
})

test('read: an image the tool returned shows as a thumbnail of its own bytes; a URL never does', async () => {
  const card = await mountCard(
    'read',
    { path: 's_menu.png' },
    {
      content: 'Read image file [image/png][image content]',
      descriptor: { kind: ENSO_IMAGES_KIND, props: { images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] } },
    },
  )
  expect(card.element.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  // A descriptor whose image is not an image type draws no image: the text, as for an unknown kind.
  const forged = await mountCard(
    'read',
    { path: 'x.png' },
    {
      content: 'the text form',
      descriptor: { kind: ENSO_IMAGES_KIND, props: { images: [{ mimeType: 'text/html', data: 'PHNjcmlwdD4=' }] } },
    },
  )
  expect(forged.element.querySelector('img')).toBeNull()
  expect(forged.out()).toContain('the text form')
})

test('write: the path, size and a folded preview, new or overwritten, and a way to the file in Diff', async () => {
  const opened: string[] = []
  const card = await mountCard(
    'write',
    { path: 'notes.md', content: `hello\n${TRIPWIRES}\n` },
    {
      content: 'Successfully wrote to notes.md',
      descriptor: { kind: ENSO_WRITE_RECEIPT_KIND, props: { existed: false } },
    },
    (path) => opened.push(path),
  )
  expect(card.in()).toContain('notes.md')
  expect(card.in()).toContain('2 lines')
  expect(card.in()).toMatch(/\d+ bytes/)
  expect(card.out()).toContain('created a new file')
  expectInert(card)
  const link = [...card.element.querySelectorAll('button')].find((button) => button.textContent === 'open in Diff')
  await act(async () => link?.click())
  expect(opened).toEqual(['notes.md'])
})

test('edit: the path and each change as old lines over new ones', async () => {
  const card = await mountCard(
    'edit',
    { path: 'a.ts', edits: [{ oldText: 'const a = 1', newText: `const a = 2\n// ${TRIPWIRES}` }] },
    { content: 'Successfully replaced 1 block(s) in a.ts.' },
  )
  expect(card.in()).toContain('a.ts')
  expect(card.in()).toContain('1 change')
  const removed = card.element.querySelector('.bg-refuse\\/15')?.textContent
  const added = [...card.element.querySelectorAll('.bg-ok\\/15')].map((line) => line.textContent)
  expect(removed).toContain('const a = 1')
  expect(added[0]).toContain('const a = 2')
  expect(card.in()).not.toContain('"oldText"')
  expectInert(card)
})

test('⚠ ask_user: each question with its chosen answers — multi-select and Other included — never the JSON', async () => {
  const questions = [
    {
      header: 'Cabinets',
      question: 'Which cabinets?',
      multiSelect: false,
      options: [
        { label: 'Oak', description: 'warm' },
        { label: 'Steel', description: 'cold' },
      ],
    },
    {
      header: 'Extras',
      question: 'Which extras?',
      multiSelect: true,
      options: [
        { label: 'Lights', description: '' },
        { label: 'Drawers', description: '' },
        { label: 'Hooks', description: '' },
      ],
    },
  ]
  const card = await mountCard(
    'ask_user',
    { questions },
    {
      content: 'The user answered:',
      descriptor: {
        kind: ENSO_QUESTIONNAIRE_ANSWERS_KIND,
        props: { questions, answers: [{ selected: ['Steel'] }, { selected: ['Lights', 'Hooks'], other: TRIPWIRES }] },
      },
    },
  )
  const chosen = (question: string): string[] =>
    [...card.element.querySelectorAll(`section[aria-label="${question}"] [data-chosen]`)].map(
      (row) => row.textContent ?? '',
    )
  expect(chosen('Which cabinets?')).toEqual(['Steel'])
  expect(chosen('Which extras?')).toEqual(['Lights', 'Hooks', `Other: ${TRIPWIRES}`])
  expect(card.element.textContent).not.toContain('"multiSelect"')
  expectInert(card)
  await card.raw()
  expect(card.in()).toContain('"multiSelect": true')
})

test('grep / find / ls: pattern and path, the count, the results folded', async () => {
  const grep = await mountCard(
    'grep',
    { pattern: 'TODO', path: 'src' },
    { content: `a.ts:1: TODO\nb.ts:9: ${TRIPWIRES}` },
  )
  expect(grep.in()).toContain('TODO')
  expect(grep.in()).toContain('in src')
  expect(grep.out()).toContain('2 matches')
  expectInert(grep)
  const find = await mountCard('find', { pattern: '*.ts' }, { content: 'a.ts\nb.ts\nc.ts' })
  expect(find.out()).toContain('3 files')
  const ls = await mountCard('ls', { path: 'docs' }, { content: '(empty directory)' })
  expect(ls.in()).toContain('docs')
  expect(ls.out()).toContain('(empty directory)')
})

test("a listing's count drops only pi's closing notice — a `[slug]/` entry counts — and grep's context lines are not matches", async () => {
  const ls = await mountCard(
    'ls',
    { path: 'app' },
    { content: '[slug]/\nlayout.tsx\npage.tsx\n\n[3 entries limit reached. Use limit=6 for more]' },
  )
  expect(ls.out()).toContain('3 entries')
  const grep = await mountCard(
    'grep',
    { pattern: 'TODO', context: 1 },
    {
      content: [
        'notes/2024-12-01.md-4- before',
        'notes/2024-12-01.md:5: TODO',
        'notes/2024-12-01.md-6- after: 7: x',
        '',
        '[1 matches limit reached. Use limit=2 for more, or refine pattern]',
      ].join('\n'),
    },
  )
  // The label: one match, over the folded text (which still holds pi's notice as it came).
  expect(grep.out()).toStartWith('›1 matchnotes/')
})

test('web_fetch / web_search: the URL or query, the status line over the folded result', async () => {
  const fetched = await mountCard(
    'web_fetch',
    { url: 'https://example.com/' },
    { content: `Fetched https://example.com/ — HTTP 200, text/html\n\n${TRIPWIRES}` },
  )
  expect(fetched.in()).toContain('https://example.com/')
  expect(fetched.element.querySelector('dd summary')?.textContent).toContain('HTTP 200')
  expectInert(fetched)
  const searched = await mountCard('web_search', { query: 'bun test' }, { content: 'Answer: use bun test' })
  expect(searched.in()).toContain('bun test')
})

test('⚠ an unknown tool shows its arguments as a key: value list, nested values beneath their key', async () => {
  const card = await mountCard(
    'mcp_tool_nobody_registered',
    { target: TRIPWIRES, options: { depth: 2, tags: ['a', 'b'] } },
    { content: 'done' },
  )
  const list = card.element.querySelector('[data-enso-tool-input="key-values"]')
  expect(list?.textContent).toContain('target:')
  expect(list?.textContent).toContain('depth:2')
  expect(card.in()).not.toContain('{')
  expect(card.out()).toContain('done')
  expectInert(card)
  await card.raw()
  expect(card.in()).toContain('"depth": 2')
})
