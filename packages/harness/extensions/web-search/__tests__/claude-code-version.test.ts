import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_CODE_DEFAULT_VERSION } from '@enso/core'
import type { FetchUrlInit } from '../../../core/index.ts'
import { runAnthropicProviderSearch, WebSearchProviderError } from '../../../core/index.ts'
import { createWebSearch, type WebSearchDependencies } from '../index.ts'

/**
 * #925: the Claude Code version a Claude login (OAuth) claims, on the web search (Enso's request)
 * and on the conversation (pi's request, through the extension's `before_provider_headers`). A
 * contract with the vendor, so it lives here, in the extension that wires search to pi:
 * `harness/core` may not name pi (#145).
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

const CLAUDE_LOGIN = 'sk-ant-oat01-fake-oauth-token'
const API_KEY = 'sk-ant-api03-fake-key'
const ANTHROPIC_MODEL = {
  id: 'claude-test',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.example',
  reasoning: false,
  maxTokens: 8192,
}

/** The user-agent a search sends; the provider's answer is beside the point, so it is a 500. */
async function searchUserAgent(apiKey: string, claudeCodeVersion: string | undefined): Promise<string | undefined> {
  let sentHeaders: Record<string, string> | undefined
  await runAnthropicProviderSearch({
    query: 'what changed',
    model: ANTHROPIC_MODEL,
    resolveAuth: async () => ({ ok: true, apiKey }),
    fetchUrl: async (_url: string, init: FetchUrlInit) => {
      sentHeaders = init.headers
      return new Response('unavailable', { status: 500 })
    },
    signal: undefined,
    claudeCodeVersion,
  }).catch(() => undefined)
  return sentHeaders?.['user-agent']
}

/**
 * The headers pi hands the extension's `before_provider_headers` for one conversation request,
 * after the extension has run on them: the extension loaded with `config` as the user's file.
 */
async function conversationHeaders(
  config: object,
  model: object,
  apiKey: string,
): Promise<Record<string, string | null>> {
  const configText = JSON.stringify(config)
  const dependencies: WebSearchDependencies = {
    locateConfigFile: () => '/home/u/.enso/config.json',
    readConfigText: () => configText,
    resolveSessionConfig: () => Promise.reject(new Error('no session starts in this test')),
    readEnvironmentVariable: () => undefined,
    runProviders: {} as WebSearchDependencies['runProviders'],
    fetchUrl: async () => {
      throw new Error('no test reaches the network')
    },
  }
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void>>()
  createWebSearch(dependencies)({
    registerTool: () => undefined,
    on: (event: string, handler: (event: unknown, context: unknown) => Promise<void>) => handlers.set(event, handler),
    events: {},
  } as never)
  const headers: Record<string, string | null> = { 'x-trace': 'kept' }
  await handlers.get('before_provider_headers')?.(
    { type: 'before_provider_headers', headers },
    { model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey }) } },
  )
  return headers
}

// ⚠ The search claimed `claude-cli/2.1.75` after pi moved to 2.1.280, and Anthropic refused the
// OAuth `web_search` tool as `claude_code_version_too_old` while conversations, which send pi's
// value, worked. Unconfigured, the search must claim exactly what pi's conversation path claims —
// so a pi upgrade that moves the version fails here, not in a person's search.
test('⚠ unconfigured, an OAuth search claims the same Claude Code version as pi’s conversation path (#925)', async () => {
  expect(CLAUDE_CODE_DEFAULT_VERSION).toBe(piClaudeCodeVersion())
  expect(await searchUserAgent(CLAUDE_LOGIN, undefined)).toBe(`claude-cli/${piClaudeCodeVersion()}`)
})

// When Anthropic raises its minimum before pi releases, `claudeCode.version` is the person's way
// out, and it must move BOTH requests: a search and the turn around it never claim two versions.
test('⚠ a configured claudeCode.version is what a Claude login claims on the search and on the conversation (#925)', async () => {
  const config = { claudeCode: { version: '2.1.999' } }
  expect(await searchUserAgent(CLAUDE_LOGIN, '2.1.999')).toBe('claude-cli/2.1.999')
  expect(await conversationHeaders(config, ANTHROPIC_MODEL, CLAUDE_LOGIN)).toEqual({
    'x-trace': 'kept',
    'user-agent': 'claude-cli/2.1.999',
  })
})

// Only a Claude login claims to be Claude Code; nothing configured leaves pi's own version.
test('the conversation’s headers stay as pi made them: no setting, an API key, or a model not on the Anthropic API (#925)', async () => {
  const untouched = { 'x-trace': 'kept' }
  const config = { claudeCode: { version: '2.1.999' } }
  expect(await conversationHeaders({}, ANTHROPIC_MODEL, CLAUDE_LOGIN)).toEqual(untouched)
  expect(await conversationHeaders(config, ANTHROPIC_MODEL, API_KEY)).toEqual(untouched)
  const openAiModel = { ...ANTHROPIC_MODEL, provider: 'openai', api: 'openai-responses' }
  expect(await conversationHeaders(config, openAiModel, CLAUDE_LOGIN)).toEqual(untouched)
  // The search, likewise: an API key's request claims no Claude Code version at all.
  expect(await searchUserAgent(API_KEY, '2.1.999')).toBeUndefined()
})

// Anthropic's own sentence says "Run 'claude update'", which changes nothing Enso sends; the
// refusal must name Enso's setting and the version Anthropic asked for. The body is the one a
// live search received on 2026-10-13 (thread 41d88127).
test('⚠ Anthropic’s version refusal names the setting and the version it requires (#925)', async () => {
  const body =
    '{"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.75 does not support this model; ' +
    "version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.\"," +
    '"details":{"error_code":"claude_code_version_too_old"}},"request_id":"req_011CfzoExo8jCBStfQr5A1J3"}'
  const refused = await runAnthropicProviderSearch({
    query: 'what changed',
    model: ANTHROPIC_MODEL,
    resolveAuth: async () => ({ ok: true, apiKey: CLAUDE_LOGIN }),
    fetchUrl: async () => new Response(body, { status: 400 }),
    signal: undefined,
  }).then(
    () => undefined,
    (error: unknown) => error,
  )
  if (!(refused instanceof WebSearchProviderError)) throw new Error(`expected a provider error, got ${String(refused)}`)
  expect(refused.message).toContain('the search API answered HTTP 400')
  expect(refused.message).toContain(`"claudeCode": { "version": "2.1.280" }`)
  expect(refused.requestDispatched).toBe(true)
})
