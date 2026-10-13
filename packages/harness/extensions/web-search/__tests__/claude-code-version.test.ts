import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FetchUrlInit } from '../../../core/index.ts'
import { runAnthropicProviderSearch } from '../../../core/index.ts'

/**
 * #925: the web search's Claude Code identity against pi's own. A contract with the vendor, so it
 * lives here, in the extension that wires search to pi: `harness/core` may not name pi (#145).
 */

/**
 * pi's Claude Code version, read from the pi-ai that pi's conversation path loads: resolved from
 * pi-coding-agent's location (as `agent-host.test.ts` does), because pi-ai is pi's dependency —
 * `harness` has it only aliased (`@earendil-works/pi-classifier`), and a fixed `node_modules` path
 * would ride on another package's hoisting (PR #926 review). pi exports no constant, so this
 * reads the file.
 */
function piClaudeCodeVersion(): string {
  const piCodingAgentDir = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))
  const piAiEntry = Bun.resolveSync('@earendil-works/pi-ai', piCodingAgentDir)
  const piAnthropic = join(dirname(piAiEntry), 'api', 'anthropic-messages.js')
  const found = /const claudeCodeVersion = "([^"]+)"/.exec(readFileSync(piAnthropic, 'utf8'))
  if (found?.[1] === undefined) throw new Error(`pi-ai no longer declares claudeCodeVersion in ${piAnthropic}`)
  return found[1]
}

// ⚠ The search claimed `claude-cli/2.1.75` after pi moved to 2.1.280, and Anthropic refused the
// OAuth `web_search` tool as `claude_code_version_too_old` while conversations, which send pi's
// value, worked. The search must claim exactly what pi's conversation path claims — so a pi
// upgrade that moves the version fails here, not in a person's search.
test('⚠ an OAuth search claims the same Claude Code version as pi’s conversation path (#925)', async () => {
  let sentHeaders: Record<string, string> | undefined
  // The headers are what is pinned; the provider's answer is beside the point, so it is a 500.
  const outcome = runAnthropicProviderSearch({
    query: 'what changed',
    model: {
      id: 'claude-test',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.example',
      maxTokens: 8192,
    } as never,
    resolveAuth: async () => ({ ok: true, apiKey: 'sk-ant-oat01-fake-oauth-token' }),
    fetchUrl: async (_url: string, init: FetchUrlInit) => {
      sentHeaders = init.headers
      return new Response('unavailable', { status: 500 })
    },
    signal: undefined,
  })
  await outcome.catch(() => undefined)
  expect(sentHeaders?.['user-agent']).toBe(`claude-cli/${piClaudeCodeVersion()}`)
})
