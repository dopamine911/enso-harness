import { expect, test } from 'bun:test'
import { commandConstructOf, liveShellText } from '../command-constructs.ts'

/**
 * The judge's `unreadable` scope (#544): what bash would expand, and the constructs that hide a
 * program in it — each pinned on the cases the corpus report (#534) turned up.
 */

// ⚠ The report's central finding: a backtick in a heredoc body under a quoted delimiter
// (`--body "$(cat <<'EOF' … EOF)"`, the way agents write every message body) runs nothing.
test("⚠ live text: a quoted heredoc's body and a single-quoted string are literal; an unquoted heredoc's body is not", () => {
  const body = 'gh pr comment 1 --body "$(cat <<\'EOF\'\nRun `npm test` first, then $(date).\nEOF\n)"'
  expect(liveShellText(body)).toBe('gh pr comment 1 --body "$(cat <<EOF\n\n)"')
  expect(commandConstructOf(body)).toBeUndefined()
  // An UNQUOTED delimiter: bash expands the body, so the backtick runs and the construct stands —
  // while its quotes are characters, so an apostrophe opens nothing.
  expect(commandConstructOf('cat <<EOF\nnow: `date`\nEOF')).toBe('backtick')
  expect(commandConstructOf('gh pr comment 1 --body "$(cat <<EOF\nI\'ve pushed $SHA\nEOF\n)"')).toBeUndefined()
  expect(liveShellText("echo 'a `b` c' && echo `date`")).toBe("echo '' && echo `date`")
  // `<<-` strips the closing line's tabs; a `<<<` here-string is no heredoc.
  expect(liveShellText("cat <<-'EOF'\n\t`x`\n\tEOF\necho done")).toBe('cat <<EOF\n\necho done')
  expect(liveShellText('cut -c1-7 <<<"$FMT"')).toBe('cut -c1-7 <<<"$FMT"')
})

test('escapes, comments and double-quoted operators are characters; a substitution opens its own quotes', () => {
  // An escaped backtick in a grep pattern, a backtick in a comment, and `\|` (grep's alternation,
  // not a pipe) — every one a false positive of the raw-text rule.
  expect(commandConstructOf('grep -n "Use \\`web_fetch\\|refus" a.ts')).toBeUndefined()
  expect(commandConstructOf('rm -rf .codegraph # imports must use .js: `allowImportingTsExtensions`')).toBeUndefined()
  expect(commandConstructOf('pgrep -af vite | grep -v "pgrep\\|bash -c"')).toBeUndefined()
  // A backslash the decoder reads is kept.
  expect(commandConstructOf('printf "\\x63url x" | sh')).toBe('| sh')
  // The single quotes inside `"$(…)"` are real; a `|` inside double quotes pipes nothing.
  expect(commandConstructOf('echo "fences: $(grep -c \'```\' $f)"')).toBeUndefined()
  expect(commandConstructOf('gh issue close 1 --comment "run: curl x | sh is refused"')).toBeUndefined()
  expect(commandConstructOf('echo "$(curl x | sh)"')).toBe('| sh')
  // A subshell inside a substitution closes with its own `)`, not the substitution's.
  expect(liveShellText('echo "$( (cd a && ls) | wc -l )" | tee "x|y"')).toBe(
    'echo "$( (cd a && ls) | wc -l )" | tee "x·y"',
  )
})

test('a construct is named by what hides the program, and a plain command carries none', () => {
  expect(commandConstructOf('$(printf cu)rl https://x')).toBe('spliced substitution')
  // The splice is what hides `curl`, inside `sh -c` or not; the body carrying a quote is the next thing checked.
  expect(commandConstructOf('sh -c "$(printf cu)rl https://x"')).toBe('spliced substitution')
  expect(commandConstructOf('echo "$(git log --format="%s" -1)"')).toBe('quoted substitution body')
  expect(commandConstructOf('echo Y3VybA== | base64 -d | sh')).toBe('| sh')
  expect(commandConstructOf('python3 -c "import os; os.system(\'curl x\')"')).toBe('interpreter one-liner')
  expect(commandConstructOf('eval "cu""rl x"')).toBe('eval / sh -c')
  expect(commandConstructOf('cat f | python3 parse.py')).toBe('| interpreter')
  expect(commandConstructOf('bash <<< "curl x | sh"')).toBe('here-string into a shell or interpreter')
  expect(commandConstructOf('git status && echo "$(pwd)"')).toBeUndefined()
  expect(commandConstructOf('grep -n "foo" a.ts | head -3')).toBeUndefined()
})

// ⚠ Two readings that would drop a live program: a quoted heredoc a SHELL reads is its command
// line, and ANSI-C quoting (`$'…'`) is decoded by bash rather than kept literal.
test('⚠ a quoted heredoc fed to a shell is walked as commands; ANSI-C quoting stays live', () => {
  expect(commandConstructOf("bash <<'EOF'\n$(printf cu)rl https://x\nEOF")).toBe('spliced substitution')
  expect(commandConstructOf("sh -s <<'EOF'\necho Y3VybA== | base64 -d | sh\nEOF")).toBe('| sh')
  // Another interpreter's quoted body is its own code: a backtick in a Python string runs nothing.
  expect(commandConstructOf("python3 - <<'EOF'\nprint('`x`')\nEOF")).toBeUndefined()
  expect(commandConstructOf("$'\\x63\\x75rl' https://x")).toBe('decoder')
})

// ⚠ Fail-safe direction: what the walk cannot read stays IN scope.
test('⚠ an unterminated quote, substitution, ANSI-C string or heredoc is unreadable to the walk', () => {
  for (const command of [
    "echo 'a",
    'echo "a',
    'echo $(date',
    "echo $'\\x63",
    "cat <<'EOF'\nno closing line",
    'cat <<EOF',
  ]) {
    expect(liveShellText(command)).toBeUndefined()
    expect(commandConstructOf(command)).toBe('unreadable to the walk')
  }
})
