import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ENSO_TOOL_RESULT_KEY, ENSO_WRITE_RECEIPT_KIND } from '@enso/core'
import writeReceipt from '../index.ts'

/**
 * The `write` receipt (#920) over a stand-in pi and a real folder: the file is looked for when the
 * call starts — in a parallel batch, before any call of the batch runs — and the answer rides the
 * result, never a failed write's.
 */

type Handler = (event: Record<string, unknown>, extensionContext: unknown) => unknown

function loaded(cwd: string): {
  call: (id: string, path: string) => void
  result: (id: string, isError?: boolean) => unknown
  turnEnd: () => void
} {
  const handlers = new Map<string, Handler>()
  writeReceipt({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI)
  const fire = (name: string, event: Record<string, unknown>): unknown => handlers.get(name)?.(event, { cwd })
  return {
    call: (toolCallId, path) =>
      void fire('tool_execution_start', { toolCallId, toolName: 'write', args: { path, content: 'x' } }),
    result: (toolCallId, isError = false) => fire('tool_result', { toolCallId, toolName: 'write', isError }),
    turnEnd: () => void fire('turn_end', {}),
  }
}

const receipt = (existed: boolean): unknown => ({
  details: { [ENSO_TOOL_RESULT_KEY]: { kind: ENSO_WRITE_RECEIPT_KIND, props: { existed } } },
})

test('⚠ a write says whether it made a new file or overwrote one, as the folder stood when the call started', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'enso-write-receipt-'))
  writeFileSync(join(cwd, 'old.md'), 'before')
  const pi = loaded(cwd)
  pi.call('c1', 'old.md')
  pi.call('c2', 'new.md')
  // The new file now exists — written by the tool — and is still said to be new.
  writeFileSync(join(cwd, 'new.md'), 'after')
  expect(pi.result('c1')).toEqual(receipt(true))
  expect(pi.result('c2')).toEqual(receipt(false))
})

test('⚠ a parallel batch: a second write to a new path overwrites the first; a file another tool makes is not seen', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'enso-write-receipt-'))
  const pi = loaded(cwd)
  // pi starts every call of the batch before running any: both look at a folder without x.md.
  pi.call('c1', 'x.md')
  pi.call('c2', './x.md')
  pi.call('c3', 'y.md')
  // A `bash` of the same batch makes y.md before its write runs — invisible at the start.
  writeFileSync(join(cwd, 'x.md'), 'first')
  writeFileSync(join(cwd, 'y.md'), 'from bash')
  expect(pi.result('c1')).toEqual(receipt(false))
  expect(pi.result('c2')).toEqual(receipt(true))
  expect(pi.result('c3')).toEqual(receipt(false))
})

test('a failed write gets no receipt, nor does a result whose call it never saw', () => {
  const pi = loaded(mkdtempSync(join(tmpdir(), 'enso-write-receipt-')))
  pi.call('c1', 'a.md')
  expect(pi.result('c1', true)).toBeUndefined()
  expect(pi.result('unknown')).toBeUndefined()
})

test("the turn's end drops a call a guard blocked: no receipt for it, and its path no longer counts as written", () => {
  const pi = loaded(mkdtempSync(join(tmpdir(), 'enso-write-receipt-')))
  pi.call('blocked', 'a.md')
  pi.turnEnd()
  expect(pi.result('blocked')).toBeUndefined()
  pi.call('next', 'a.md')
  expect(pi.result('next')).toEqual(receipt(false))
})
