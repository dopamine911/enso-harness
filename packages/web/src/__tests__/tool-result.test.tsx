import { expect, test } from 'bun:test'
import { ENSO_TOOL_RESULT_KEY, isEnsoToolResultDescriptor, readEnsoToolResultDescriptor } from '@enso/core'
import type { ToolResultPart } from '@tanstack/ai'
import { renderToStaticMarkup } from 'react-dom/server'
import { type EnsoRendererMap, EnsoToolResult, toolResultState } from '../EnsoToolResult.tsx'

const partWith = (overrides: Partial<ToolResultPart>): ToolResultPart => ({
  type: 'tool-result',
  toolCallId: 'call-1',
  content: 'PLAIN TEXT FORM',
  state: 'complete',
  ...overrides,
})

const renderers: EnsoRendererMap = {
  diff: (props: Record<string, unknown>) => <span data-known>{String(props.summary)}</span>,
}

const html = (result?: ToolResultPart, runOpen = true): string =>
  renderToStaticMarkup(<EnsoToolResult result={result} runOpen={runOpen} renderers={renderers} />)

// --- the descriptor reader, pure and surface-independent
test('reads a well-formed descriptor out of metadata', () => {
  const found = readEnsoToolResultDescriptor({
    [ENSO_TOOL_RESULT_KEY]: { kind: 'diff', props: { summary: '3 files' } },
  })
  expect(found?.kind).toBe('diff')
})
test('absent metadata yields no descriptor', () => expect(readEnsoToolResultDescriptor(undefined)).toBeUndefined())
test('a malformed descriptor is rejected, not coerced', () => {
  expect(isEnsoToolResultDescriptor({ kind: '', props: {} })).toBe(false)
  expect(isEnsoToolResultDescriptor({ kind: 'diff' })).toBe(false)
  expect(isEnsoToolResultDescriptor('diff')).toBe(false)
})

// --- rendering. ⚠ Every case below must produce VISIBLE output; a blank render is the
// failure mode this contract exists to prevent.
test('a known kind renders through its renderer', () => {
  const rendered = html(
    partWith({ metadata: { [ENSO_TOOL_RESULT_KEY]: { kind: 'diff', props: { summary: '3 files' } } } }),
  )
  expect(rendered).toContain('3 files')
  expect(rendered).toContain('data-enso-kind="diff"')
})

test('⚠ an UNKNOWN kind falls back to the envelope text, never to blank', () => {
  const rendered = html(partWith({ metadata: { [ENSO_TOOL_RESULT_KEY]: { kind: 'no-such-renderer', props: {} } } }))
  expect(rendered).toContain('PLAIN TEXT FORM')
  expect(rendered.length).toBeGreaterThan(0)
})

test('⚠ a renderer that declines with any empty node — null, false, true or an empty string — gets the text', () => {
  for (const declined of [null, false, true, '']) {
    const rendered = renderToStaticMarkup(
      <EnsoToolResult
        result={partWith({ metadata: { [ENSO_TOOL_RESULT_KEY]: { kind: 'declines', props: {} } } })}
        runOpen
        renderers={{ declines: () => declined }}
      />,
    )
    expect(rendered).toContain('PLAIN TEXT FORM')
  }
})

test('no descriptor at all falls back to the envelope text', () =>
  expect(html(partWith({}))).toContain('PLAIN TEXT FORM'))

test('an in-flight call says so rather than rendering nothing', () => expect(html(undefined)).toContain('running'))

// #130: pi emits no result for a call its abort interrupted, so without the run's state a
// stopped call read `running…` forever. Same absence, run over: aborted.
test('⚠ no result once the run is over is ABORTED, not running', () => {
  const rendered = html(undefined, false)
  expect(rendered).toContain('data-enso-tool-result="aborted"')
  expect(rendered).toContain('aborted — the run ended before this call returned')
  expect(rendered).not.toContain('running')
  // The definition itself, for the two readers that branch on it.
  expect(toolResultState(undefined, true)).toEqual({ status: 'pending' })
  expect(toolResultState(undefined, false)).toEqual({ status: 'aborted' })
})

test('an errored result shows the error, not the descriptor', () => {
  const rendered = html(
    partWith({
      error: 'tool exploded',
      metadata: { [ENSO_TOOL_RESULT_KEY]: { kind: 'diff', props: { summary: 'x' } } },
    }),
  )
  expect(rendered).toContain('tool exploded')
  expect(rendered).not.toContain('data-enso-kind')
})

// TanStack's `updateToolResultPart` omits an empty `error`, so `state: 'error'` can arrive with no
// `error` field (PR #996 review): it is still an error, and its content is the reason.
test('⚠ a result stated as error with no error field is an error, not done', () => {
  const part = partWith({ state: 'error', content: 'outside the project' })
  expect(toolResultState(part, true)).toEqual({ status: 'error', result: part, error: 'outside the project' })
  expect(html(part)).toContain('outside the project')
})

test('truncation is rendered from data, not from a pre-rendered string', () => {
  const rendered = html(
    partWith({
      metadata: {
        [ENSO_TOOL_RESULT_KEY]: {
          kind: 'diff',
          props: { summary: 's' },
          truncated: { shown: 500, total: 4000, unit: 'lines' },
        },
      },
    }),
  )
  expect(rendered).toContain('500')
  expect(rendered).toContain('4000')
  expect(rendered).toContain('lines')
})

// #411: no renderer is registered for pi's descriptors (`pi.tool.<name>`), so every truncated
// result a pi tool returns lands in the text fallback — and the truncation is data, not the
// renderer's: it is said there too, or a reader takes the first 500 lines for the whole file.
test('⚠ a descriptor no renderer knows still says its truncation under the text', () => {
  const rendered = html(
    partWith({
      metadata: {
        [ENSO_TOOL_RESULT_KEY]: {
          kind: 'pi.tool.read',
          props: {},
          truncated: { shown: 500, total: 4000, unit: 'lines' },
        },
      },
    }),
  )
  expect(rendered).toContain('PLAIN TEXT FORM')
  expect(rendered).toContain('data-enso-truncation')
  expect(rendered.replace(/<[^>]*>/g, '')).toContain('showing 500 of 4000 lines')
})

// `content` is `string | ContentPart[]` (#53 S3: the array branch was never rendered).
test('array content renders every part as JSON, one per line, never dropped', () => {
  const rendered = html(
    partWith({
      content: [
        { type: 'text', content: 'first' },
        { type: 'image', source: { type: 'data', value: 'aGk=', mimeType: 'image/png' } },
      ],
    }),
  )
  expect(rendered).toContain('first')
  expect(rendered).toContain('image/png')
  expect(rendered).toContain('data-enso-tool-result="text"')
})
