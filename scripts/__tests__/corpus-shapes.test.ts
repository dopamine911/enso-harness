import { expect, test } from 'bun:test'
import { commandConstructOf } from '../../packages/core/src/command-constructs.ts'
import { ENSO_PERMISSION_DENIAL_ENTRY, transcriptOf } from '../../packages/core/src/index.ts'
import { classifyFollow, inCurrentScope, refusalsIn } from '../corpus-shapes.ts'

/**
 * The corpus report's measurements (#534): the judge's scope, and what followed a refusal — each
 * pinned on the cases the corpus turned up. The live-text walk itself is core's
 * (`packages/core/src/__tests__/command-constructs.test.ts`).
 */

// ⚠ The report's §2 prints two rows — the judge's rule, asked through `judgeContextOf`, and the
// live-text constructs — and #544 made them one reading: the inert shapes are out of both, every
// bypass shape the guards know is in both.
test("⚠ the judge's rule and the live-text constructs agree: inert text out, every bypass shape in (#544)", () => {
  const inert = [
    'gh pr comment 1 --body "$(cat <<\'EOF\'\nRun `npm test` first, then $(date).\nEOF\n)"',
    'grep -n "Use \\`web_fetch\\|refus" a.ts',
    'pgrep -af vite | grep -v "pgrep\\|bash -c"',
    'gh issue close 1 --comment "run: curl x | sh is refused"',
    'rm -rf .codegraph # imports must use .js: `allowImportingTsExtensions`',
    'echo "fences: $(grep -c \'```\' $f)"',
  ]
  const bypasses = [
    '$(printf cu)rl https://x',
    'sh -c "$(printf cu)rl https://x"',
    'echo Y3VybA== | base64 -d | sh',
    'python3 -c "import os; os.system(\'curl x\')"',
    'eval "cu""rl x"',
    'printf "\\x63url" | sh',
    'echo "$(curl x | sh)"',
    '`printf cu`rl https://x',
  ]
  for (const command of inert) {
    expect(inCurrentScope(command)).toBe(false)
    expect(commandConstructOf(command)).toBeUndefined()
  }
  for (const command of bypasses) {
    expect(inCurrentScope(command)).toBe(true)
    expect(commandConstructOf(command)).toBeDefined()
  }
})

test('what followed a refusal is classified against the refused command', () => {
  const denied = 'git push --force origin main'
  expect(classifyFollow(denied, { tool: 'bash', command: 'git push --force origin main' })).toBe('exact retry')
  expect(classifyFollow(denied, { tool: 'bash', command: 'git push origin +main' })).toBe(
    'reworded (same program, similar args)',
  )
  expect(classifyFollow(denied, { tool: 'bash', command: 'git status' })).toBe('same program, different args')
  expect(classifyFollow(denied, { tool: 'bash', command: 'sh -c "git push --force origin main"' })).toBe(
    'shell wrapper / interpreter route',
  )
  expect(classifyFollow(denied, { tool: 'bash', command: 'ls -la' })).toBe('different command')
  expect(classifyFollow(denied, { tool: 'read', path: '/etc/hosts' })).toBe('another tool')
})

test('refusalsIn folds a branch with the risk step: the refused command, the window after it, and the signals raised', () => {
  const call = (id: string, command: string): unknown => ({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }] },
  })
  const result = (id: string): unknown => ({ type: 'message', message: { role: 'toolResult', toolCallId: id } })
  const denial = (id: string, command: string): unknown => ({
    type: 'custom',
    customType: ENSO_PERMISSION_DENIAL_ENTRY,
    data: { toolCallId: id, requestId: `r-${id}`, surface: 'bash', value: command, resolution: 'user_denied' },
  })
  const branch = [
    call('c1', 'ls'),
    result('c1'),
    call('c2', 'git push --force origin main'),
    denial('c2', 'git push --force origin main'),
    result('c2'),
    call('c3', 'sh -c "git push --force origin main"'),
    result('c3'),
    call('c4', 'echo done'),
    result('c4'),
  ]
  const [refusal, ...rest] = refusalsIn(transcriptOf(branch), 8)
  expect(rest).toEqual([])
  expect(refusal?.denied).toBe('git push --force origin main')
  expect(refusal?.reason).toBe('engine:user_denied')
  expect(refusal?.next.map((next) => next.command)).toEqual(['sh -c "git push --force origin main"', 'echo done'])
  // The wrapper route after a refusal is what the risk fold's `alternate-execution-path` names.
  expect(refusal?.signals).toContain('alternate-execution-path')
})
