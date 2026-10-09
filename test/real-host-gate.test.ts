import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codeOnly } from '../scripts/docs/gate-source.ts'
import { REPOSITORY_ROOT, sourceFiles } from './gate-support.ts'

/**
 * Only `agent-host.test.ts` builds real hosts (#518).
 *
 * ⚠ Why this is a gate and not a comment: `pi-multi-account` keeps the agent directory of the FIRST
 * host a test process builds. A second test file that builds real hosts under its own agent
 * directory breaks `agent-host.test.ts`'s isolation test ("multi-account resolved its config inside
 * the scratch agent dir") whenever the files run in the order that puts it first. #474 did exactly
 * that, #513's CI failure found it, and only a comment in `agent-host.test.ts` stated the rule.
 *
 * Two ways a test builds one, both refused outside that file:
 *   1. calling `createAgentHost(` itself;
 *   2. calling `startEnsoServer({ … })` without a `host:` option, since the server builds a real
 *      host when it is given none (`server/index.ts`). Every server test passes a fake
 *      (`fake-hosted-thread.ts`, `NO_HOST`), which is how it should stay.
 *
 * A source scan, so it reads code only: comments and strings are blanked first (`codeOnly`), and
 * a call's object literal is read by brace depth. A host built some other way (a helper in a third
 * module) is outside it; that helper would be its own `createAgentHost(` call and would show up
 * under rule 1 if it lived in a test file.
 */

const OWNER = 'packages/web/src/host/__tests__/agent-host.test.ts'
const TEST_ROOTS = ['packages', 'scripts', 'test'] as const

/** Test files (`__tests__/`, or `*.test.ts` / `*.test.tsx`) under the roots, repository-relative. */
function testFiles(): string[] {
  return TEST_ROOTS.flatMap((root) => sourceFiles(join(REPOSITORY_ROOT, root), true))
    .map((path) => path.slice(REPOSITORY_ROOT.length + 1))
    .filter((path) => path.includes('/__tests__/') || /\.test\.tsx?$/.test(path))
    .filter((path) => !path.includes('/dist-types/'))
}

/** The text of the object literal opened at `open`, brace-balanced; to the end when it never closes. */
function objectLiteralAt(source: string, open: number): string {
  let depth = 0
  for (let characterIndex = open; characterIndex < source.length; characterIndex += 1) {
    if (source[characterIndex] === '{') depth += 1
    else if (source[characterIndex] === '}') depth -= 1
    if (depth === 0) return source.slice(open, characterIndex + 1)
  }
  return source.slice(open)
}

/** Whether an object literal names `host` at its own top level, not inside a nested object. */
function namesHostAtTopLevel(literal: string): boolean {
  let depth = 0
  for (const match of literal.matchAll(/[{}]|\bhost\s*:/g)) {
    if (match[0] === '{') depth += 1
    else if (match[0] === '}') depth -= 1
    else if (depth === 1) return true
  }
  return false
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function realHostBuilders(path: string): string[] {
  if (path === OWNER) return []
  const source = codeOnly(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'))
  const offenders: string[] = []
  for (const call of source.matchAll(/\bcreateAgentHost\(/g)) {
    offenders.splice(offenders.length, 0, `${path}:${lineOf(source, call.index)}: createAgentHost(`)
  }
  for (const call of source.matchAll(/\bstartEnsoServer\(\s*\{/g)) {
    const open = call.index + call[0].length - 1
    if (!namesHostAtTopLevel(objectLiteralAt(source, open))) {
      offenders.splice(offenders.length, 0, `${path}:${lineOf(source, call.index)}: startEnsoServer without host`)
    }
  }
  return offenders
}

test('⚠ only agent-host.test.ts builds real hosts: no other test calls createAgentHost or starts a server without a host (#518)', () => {
  expect(
    testFiles()
      .flatMap(realHostBuilders)
      .map(
        (offender) =>
          `${offender}: build real hosts only in ${OWNER} (the multi-account extension keeps the first host's agent dir), or pass a fake host`,
      ),
  ).toEqual([])
})

test('the scan reads the call, not the text near it: a host in a nested object does not count, a top-level one does', () => {
  expect(namesHostAtTopLevel(objectLiteralAt('startEnsoServer({ host: NO_HOST, cwd })', 16))).toBe(true)
  expect(namesHostAtTopLevel(objectLiteralAt('startEnsoServer({ options: { host: 1 }, cwd })', 16))).toBe(false)
  expect(namesHostAtTopLevel(objectLiteralAt('startEnsoServer({\n  cwd,\n  host: (rule) => fake(rule),\n})', 16))).toBe(
    true,
  )
  // A comment or string mentioning the option is not the option (PR #788 review).
  const commented = codeOnly('startEnsoServer({\n  cwd,\n  // no host: needed, this test never runs a session\n})')
  expect(namesHostAtTopLevel(objectLiteralAt(commented, 16))).toBe(false)
  expect(namesHostAtTopLevel(objectLiteralAt(codeOnly("startEnsoServer({ cwd: 'host: x' })"), 16))).toBe(false)
})
