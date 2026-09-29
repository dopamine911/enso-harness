import { expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ENSO_SYSTEM_PROMPT_ENTRY, type EnsoSystemPromptChoice } from '@enso/core'
import systemPrompt, { applySystemPrompt, UNREADABLE_SYSTEM_PROMPT_NOTICE } from '../index.ts'

/**
 * #443's extension over pi's surface reduced to what it touches — the `on` it registers with, the
 * branch it reads, the notice it may give. The real path (a web-started thread resumed by pi alone)
 * is `agent-host.test.ts`'s.
 */

const choice = (mode: EnsoSystemPromptChoice['mode'], text: string): EnsoSystemPromptChoice => ({
  id: 'p',
  name: 'P',
  mode,
  sha256: 'a'.repeat(64),
  text,
})

test("a system prompt is the run's custom preamble; an append prompt follows what pi appends", () => {
  const options: { customPrompt?: string; appendSystemPrompt: string } = { appendSystemPrompt: '' }
  applySystemPrompt(options, choice('system', 'Mine.'))
  expect(options.customPrompt).toBe('Mine.')
  applySystemPrompt(options, choice('append', 'Haiku.'))
  expect(options.appendSystemPrompt).toBe('Haiku.')
  const withFile = { appendSystemPrompt: 'From APPEND_SYSTEM.md' }
  applySystemPrompt(withFile, choice('append', 'Haiku.'))
  expect(withFile.appendSystemPrompt).toBe('From APPEND_SYSTEM.md\n\nHaiku.')
})

test("⚠ applied again — the web host's loader already put it there — it changes nothing", () => {
  const web = { appendSystemPrompt: 'From APPEND_SYSTEM.md\n\nHaiku.' }
  applySystemPrompt(web, choice('append', 'Haiku.'))
  expect(web.appendSystemPrompt).toBe('From APPEND_SYSTEM.md\n\nHaiku.')
  const alone = { appendSystemPrompt: 'Haiku.' }
  applySystemPrompt(alone, choice('append', 'Haiku.'))
  expect(alone.appendSystemPrompt).toBe('Haiku.')
})

type Handler = (event: unknown, context: unknown) => unknown

/**
 * One run start under the extension, over `branch`; what it did to the options and what it said.
 * The options are pi's normalized ones — `appendSystemPrompt` always a string — and each notice is
 * `level:message`, since the level is what makes the unreadable-record notice red in the terminal.
 */
function runStart(branch: unknown[]): {
  options: { cwd: string; customPrompt?: string; appendSystemPrompt: string }
  notices: string[]
} {
  let handler: Handler | undefined
  systemPrompt({
    on: (event: string, registered: Handler): void => {
      if (event === 'before_agent_start') handler = registered
    },
  } as unknown as ExtensionAPI)
  const options: { cwd: string; customPrompt?: string; appendSystemPrompt: string } = {
    cwd: '/r',
    appendSystemPrompt: '',
  }
  const notices: string[] = []
  handler?.(
    { systemPromptOptions: options },
    {
      sessionManager: { getBranch: () => branch },
      ui: { notify: (message: string, level: string) => notices.push(`${level}:${message}`) },
    },
  )
  return { options, notices }
}

test("the branch's LAST record is applied; none, or pi's default recorded over a choice, leaves pi's default; one that does not read is said, never swallowed", () => {
  const entry = (data: unknown): unknown => ({ type: 'custom', customType: ENSO_SYSTEM_PROMPT_ENTRY, data })
  expect(runStart([entry(choice('system', 'First.')), entry(choice('system', 'Last.'))]).options.customPrompt).toBe(
    'Last.',
  )
  expect(runStart([]).options.customPrompt).toBeUndefined()
  const reset = runStart([entry(choice('system', 'Taken back.')), entry(null)])
  expect(reset.options.customPrompt).toBeUndefined()
  expect(reset.notices).toEqual([])
  const unreadable = runStart([entry({ id: 'p', mode: 'session' })])
  expect(unreadable.options.customPrompt).toBeUndefined()
  expect(unreadable.notices).toEqual([`error:${UNREADABLE_SYSTEM_PROMPT_NOTICE}`])
})
