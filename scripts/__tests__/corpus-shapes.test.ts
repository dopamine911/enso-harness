import { expect, test } from 'bun:test'
import { ENSO_PERMISSION_DENIAL_ENTRY, transcriptOf } from '../../packages/core/src/index.ts'
import { classifyFollow, constructOf, inCurrentScope, liveText, refusalsIn } from '../corpus-shapes.ts'

/**
 * The corpus report's measurements (#534): what bash would expand, the constructs that hide a
 * program, and what followed a refusal — each pinned on the cases the corpus turned up.
 */

// ⚠ The report's central finding: the judge's current `unreadable` rule reads the RAW text, so a
// backtick in a heredoc body under a quoted delimiter (`--body "$(cat <<'EOF' … EOF)"`, the way
// agents write every message body) counts — though bash expands nothing there. Over the corpus the
// difference is 28% of all calls against 14%.
test("⚠ live text: a quoted heredoc's body and a single-quoted string are literal; an unquoted heredoc's body is not", () => {
  const body = 'gh pr comment 1 --body "$(cat <<\'EOF\'\nRun `npm test` first, then $(date).\nEOF\n)"'
  expect(liveText(body)).not.toContain('`npm test`')
  expect(constructOf(body)).toBeUndefined()
  expect(inCurrentScope(body)).toBe(true)
  // An UNQUOTED delimiter: bash expands the body, so the backtick runs and the construct stands.
  const expanding = 'cat <<EOF\nnow: `date`\nEOF'
  expect(constructOf(expanding)).toBe('backtick')
  expect(liveText("echo 'a `b` c' && echo `date`")).toBe("echo '' && echo `date`")
  // An escaped backtick in a grep pattern, a backtick in a comment, and `\|` (grep's alternation,
  // not a pipe) are characters, not operators — every one a false positive of the raw-text rule.
  expect(constructOf('grep -n "Use \\`web_fetch\\|refus" a.ts')).toBeUndefined()
  expect(constructOf('rm -rf .codegraph # imports must use .js: `allowImportingTsExtensions`')).toBeUndefined()
  expect(constructOf('pgrep -af vite | grep -v "pgrep\\|bash -c"')).toBeUndefined()
  expect(inCurrentScope('pgrep -af vite | grep -v "pgrep\\|bash -c"')).toBe(true)
  // A backslash the decoder reads is kept.
  expect(constructOf('printf "\\x63url x" | sh')).toBe('| sh')
  // A `$(…)` opens its own quoting context, so the single quotes inside `"$(…)"` are real; and a
  // `|` inside double quotes is a character — `--comment "… | sh …"` pipes nothing.
  expect(constructOf('echo "fences: $(grep -c \'```\' $f)"')).toBeUndefined()
  expect(constructOf('gh issue close 1 --comment "run: curl x | sh is refused"')).toBeUndefined()
  expect(constructOf('echo "$(curl x | sh)"')).toBe('| sh')
})

test('a construct is named by what hides the program, and a plain command carries none', () => {
  expect(constructOf('$(printf cu)rl https://x')).toBe('spliced substitution')
  // The splice is what hides `curl`, inside `sh -c` or not; the body carrying a quote is the next thing checked.
  expect(constructOf('sh -c "$(printf cu)rl https://x"')).toBe('spliced substitution')
  expect(constructOf('echo "$(git log --format="%s" -1)"')).toBe('quoted substitution body')
  expect(constructOf('echo Y3VybA== | base64 -d | sh')).toBe('| sh')
  expect(constructOf('python3 -c "import os; os.system(\'curl x\')"')).toBe('interpreter one-liner')
  expect(constructOf('eval "cu""rl x"')).toBe('eval / sh -c')
  expect(constructOf('printf "\\x63url" | sh')).toBe('| sh')
  expect(constructOf('cat f | python3 parse.py')).toBe('| interpreter')
  expect(constructOf('git status && echo "$(pwd)"')).toBeUndefined()
  expect(constructOf('grep -n "foo" a.ts | head -3')).toBeUndefined()
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
