import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * A CONTRACT TEST on the runtime's loop, the shape of `cc-safety-net-contract.test.ts`: the
 * wire shape of a refused tool call is the vendor's doing — a guard's `{ block, reason }`
 * becomes an error result with the reason as its content, `isError: true` — and
 * `map-events.ts` relies on it (the `tool_execution_end` case, "isError is the only signal a
 * refused call has"). Read from the installed package, so a version bump that moves the
 * boundary goes red here rather than rendering a denial as success (#130).
 *
 * The runner's `emitToolCall` is the hook alone — its verdict returns to the loop, which
 * decides execution afterwards — which is what makes `HostedThread.probeToolCall` a probe.
 */

const require = createRequire(import.meta.url)
const agentCorePackage = require.resolve('@earendil-works/pi-agent-core/package.json')
const agentLoopSource = readFileSync(join(dirname(agentCorePackage), 'dist', 'agent-loop.js'), 'utf8')
const { version } = JSON.parse(readFileSync(agentCorePackage, 'utf8')) as { version: string }

test(`⚠ CONTRACT: pi-agent-core@${version} turns a blocking tool_call verdict into an error result carrying the reason`, () => {
  // The block branch, verbatim in shape: the verdict's reason IS the result's content.
  expect(agentLoopSource).toContain('if (beforeResult?.block) {')
  expect(agentLoopSource).toContain('createErrorToolResult(beforeResult.reason || "Tool execution was blocked")')
  // …and it is flagged as an error, which is the one signal the mapper reads: the branch's
  // own `return {…}` — from the `if` to the first `return` that follows it, through its
  // closing `};` — carries `isError: true`. Bounded by the branch's syntax, not a character count.
  const branchStart = agentLoopSource.indexOf('if (beforeResult?.block) {')
  const returnStart = agentLoopSource.indexOf('return {', branchStart)
  const returnEnd = agentLoopSource.indexOf('};', returnStart)
  expect(returnStart).toBeGreaterThan(branchStart)
  expect(returnEnd).toBeGreaterThan(returnStart)
  expect(agentLoopSource.slice(returnStart, returnEnd)).toContain('isError: true')
  // No distinct "blocked" event exists for the mapper to read instead.
  expect(agentLoopSource).not.toMatch(/type:\s*["']tool_execution_blocked["']/)
})

test(`⚠ CONTRACT: pi-agent-core@${version} asks the hook BEFORE executing — the verdict returns, the loop decides`, () => {
  const hookCall = agentLoopSource.indexOf('config.beforeToolCall(')
  const executionAfter = agentLoopSource.indexOf('kind: "prepared"', hookCall)
  expect(hookCall).toBeGreaterThan(0)
  // the "prepared" (run it) return comes after the hook's verdict is inspected
  expect(executionAfter).toBeGreaterThan(hookCall)
})
