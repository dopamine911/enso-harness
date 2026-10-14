#!/usr/bin/env bun

/**
 * The PR reviewer's tool grant, enforced as a Claude Code `PreToolUse` hook (#981).
 *
 * WHY A HOOK, NOT `--allowedTools`. docker-agent's `claude-code` harness launches `claude` with
 * `--dangerously-skip-permissions` and takes no tool list (measured on docker-agent v1.145.0: its
 * argv is `--print --verbose --dangerously-skip-permissions --include-partial-messages
 * --output-format stream-json --effort <e> -p <message>`, and the harness block accepts only
 * `type`, `effort` and `model`). So the grant the workflow passes as `--allowedTools` has no way in.
 * A `PreToolUse` hook still runs under `--dangerously-skip-permissions` (measured with Claude Code
 * 2.1.284: a hook that exits 2 blocked `Bash touch` and `Write` while `Read` went through), so
 * the grant is enforced here instead, from the same list (`workflow-config.ts`).
 *
 * The rule, entry by entry, as Claude Code reads `--allowedTools`:
 *   - a bare name (`Read`) allows that tool, with any input;
 *   - `Bash(<prefix>:*)` allows ONE plain shell command that starts with `<prefix>`.
 * Everything else is refused, including MCP tools, subagents and edits.
 *
 * ⚠ "ONE PLAIN COMMAND" IS STRICTER THAN A PREFIX. `gh pr view 1; rm -rf ~` starts with
 * `gh pr view`. So a command is refused if it chains, pipes, substitutes or redirects
 * (`;`, `&`, `|`, `` ` ``, `$(`, `>`, `<`, a newline). The one exception is a heredoc
 * (`<<'EOF'`), the shape the workflow's prompt posts with (`gh pr comment N --body-file -`). Its
 * BODY is the review's markdown, full of `|` table pipes, so only its FIRST line is checked, and
 * nothing may follow the closing delimiter.
 *
 *   bun scripts/review/tool-grant-hook.ts <grant.json>   (Claude Code pipes the tool call on stdin)
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep as pathSeparator } from 'node:path'

/** The grant file `review-pr.ts` writes for one run. */
export interface ToolGrant {
  /** `--allowedTools` entries, as the workflow lists them. */
  readonly allowedTools: readonly string[]
  /**
   * The directories `Read`, `Grep` and `Glob` may reach: the review worktree, and Claude Code's own
   * folder for the session's oversized tool results. Absent: no path limit.
   *
   * ⚠ ON GITHUB'S RUNNER A PATH LIMIT WAS NOT NEEDED; HERE IT IS. The runner holds nothing but the
   * checkout. This machine holds `~/.ssh`, `~/.config/gh` and every other repository, and the grant
   * also allows `gh pr comment`: a pull request's text could steer the reviewer into reading a secret
   * and posting it. Measured on #989's first run: a `Read` outside the worktree, of Claude Code's
   * persisted tool output, which is why that folder is a root too.
   */
  readonly readRoots?: readonly string[]
  /**
   * Dry run: a `gh pr comment` is not posted. Its body is written to this file, and the reviewer
   * is told the review is recorded.
   */
  readonly captureCommentTo?: string
  /** One JSON line per call is appended here — the tool, its input, the decision — so a run leaves an audit trail. */
  readonly decisionLog?: string
}

/** What Claude Code hands a `PreToolUse` hook, as much of it as this reads. */
export interface ToolCall {
  readonly tool_name: string
  /** The session's working directory, which a relative path resolves against. */
  readonly cwd?: string
  readonly tool_input?: {
    readonly command?: unknown
    /** `Read`'s file. */
    readonly file_path?: unknown
    /** `Grep`'s and `Glob`'s directory; the session's working directory when absent. */
    readonly path?: unknown
    /** `Glob`'s pattern, which may itself be an absolute path. */
    readonly pattern?: unknown
  }
}

/** The tools whose input names paths, which `readRoots` limits. */
const PATH_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])

/**
 * The paths a `Read`, `Grep` or `Glob` call reaches, resolved against the session's `cwd` (or the
 * first root), so `../../.ssh` is judged where it lands, not as written.
 */
function pathsNamedBy(call: ToolCall, roots: readonly string[]): string[] {
  const input = call.tool_input ?? {}
  const named = [input.file_path, input.path, call.tool_name === 'Glob' ? input.pattern : undefined]
  const base = call.cwd ?? roots[0] ?? '/'
  return named
    .filter((namedPath): namedPath is string => typeof namedPath === 'string')
    .map((namedPath) => resolve(base, namedPath))
}

function isUnderARoot(resolvedPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${pathSeparator}`))
}

export type ToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'block'; readonly reason: string }
  | { readonly kind: 'capture'; readonly body: string }

/** `Bash(<prefix>:*)`: the prefix captured. */
const BASH_PREFIX_ENTRY = /^Bash\((.+):\*\)$/
/** Shell syntax that makes one command more than one, or sends output somewhere: never allowed. */
const SHELL_COMPOSITION = /[;&|`<>\n]|\$\(/
/** A first line ending in a heredoc operator: `… <<'EOF'`, `<< EOF`, `<<-"END"`. Groups: the command, the delimiter. */
const HEREDOC_FIRST_LINE = /^(.*?)\s*<<-?\s*(['"]?)([A-Za-z_]\w*)\2\s*$/
/** The command the review posts with, which a dry run captures instead of running. */
const POST_COMMAND_PREFIX = 'gh pr comment'
/** What Claude Code reads as "refuse this call, and tell the model why". */
const HOOK_BLOCK_EXIT_CODE = 2

function startsWithCommand(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `)
}

/** A command split into its first line and, for a heredoc, the body between the operator and the delimiter. */
interface ShellCommandParts {
  readonly firstLine: string
  readonly heredocBody?: string
}

/**
 * The command's checkable part. A heredoc's first line loses its `<<…` operator and the body is set
 * aside; `undefined` when the text after the closing delimiter is not empty, or the delimiter
 * never comes — both are more than the one command the grant allows.
 */
function shellCommandParts(command: string): ShellCommandParts | undefined {
  const lines = command.split('\n')
  const heredoc = HEREDOC_FIRST_LINE.exec(lines[0] ?? '')
  if (heredoc === null) return { firstLine: command }
  const delimiter = heredoc[3]
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === delimiter)
  if (closing === -1) return undefined
  if (lines.slice(closing + 1).some((line) => line.trim().length > 0)) return undefined
  return { firstLine: heredoc[1] ?? '', heredocBody: lines.slice(1, closing).join('\n') }
}

function decideBash(grant: ToolGrant, command: string): ToolDecision {
  const prefixes = grant.allowedTools.flatMap((toolEntry) => {
    const prefix = BASH_PREFIX_ENTRY.exec(toolEntry)?.[1]
    return prefix === undefined ? [] : [prefix]
  })
  const parts = shellCommandParts(command.trim())
  if (parts === undefined) {
    return { kind: 'block', reason: 'a heredoc must end with its delimiter, and nothing may follow it' }
  }
  if (SHELL_COMPOSITION.test(parts.firstLine)) {
    return {
      kind: 'block',
      reason: `one plain command only: no ; & | \` $( > < or extra lines (allowed: ${prefixes.join(', ')}; post with \`${POST_COMMAND_PREFIX} <number> --body-file - <<'EOF'\` … \`EOF\`)`,
    }
  }
  const prefix = prefixes.find((candidate) => startsWithCommand(parts.firstLine, candidate))
  if (prefix === undefined)
    return { kind: 'block', reason: `not in the review's tool grant (allowed: ${prefixes.join(', ')})` }
  if (grant.captureCommentTo !== undefined && prefix === POST_COMMAND_PREFIX) {
    return { kind: 'capture', body: parts.heredocBody ?? '' }
  }
  return { kind: 'allow' }
}

/** Whether the grant allows this tool call — the hook's whole decision, pure so it can be tested. */
export function decideToolCall(grant: ToolGrant, call: ToolCall): ToolDecision {
  if (call.tool_name === 'Bash') {
    const command = call.tool_input?.command
    if (typeof command !== 'string') return { kind: 'block', reason: 'a Bash call with no command' }
    return decideBash(grant, command)
  }
  if (!grant.allowedTools.includes(call.tool_name)) {
    return {
      kind: 'block',
      reason: `\`${call.tool_name}\` is not in the review's tool grant — this reviewer is read-only by design (#981)`,
    }
  }
  const roots = grant.readRoots
  if (roots !== undefined && PATH_TOOLS.has(call.tool_name)) {
    const outside = pathsNamedBy(call, roots).find((path) => !isUnderARoot(path, roots))
    if (outside !== undefined) return { kind: 'block', reason: `${outside} is outside the pull request's worktree` }
  }
  return { kind: 'allow' }
}

/** What the hook does for one call: its exit code, what it tells the model, and the files it writes. */
export interface HookOutcome {
  /** 0 allows the call; `HOOK_BLOCK_EXIT_CODE` refuses it. */
  readonly exitCode: number
  /** Written to stderr, which Claude Code shows the model on a refusal. Empty on an allow. */
  readonly message: string
  readonly fileWrites: readonly { readonly path: string; readonly text: string; readonly append: boolean }[]
}

/** The hook's whole effect for one call, as data: `main` only performs it. */
export function hookOutcome(grant: ToolGrant, call: ToolCall): HookOutcome {
  const decision = decideToolCall(grant, call)
  const logWrites =
    grant.decisionLog === undefined
      ? []
      : [
          {
            path: grant.decisionLog,
            text: `${JSON.stringify({ tool: call.tool_name, input: call.tool_input, decision })}\n`,
            append: true,
          },
        ]
  if (decision.kind === 'allow') return { exitCode: 0, message: '', fileWrites: logWrites }
  if (decision.kind === 'block') {
    return { exitCode: HOOK_BLOCK_EXIT_CODE, message: `Blocked: ${decision.reason}\n`, fileWrites: logWrites }
  }
  return {
    exitCode: HOOK_BLOCK_EXIT_CODE,
    message: 'Dry run: the review comment was recorded, not posted. The review is complete; stop here.\n',
    fileWrites: [...logWrites, { path: grant.captureCommentTo ?? '', text: decision.body, append: false }],
  }
}

function main(): void {
  const grantPath = process.argv[2]
  if (grantPath === undefined) {
    process.stderr.write('tool-grant-hook: no grant file named\n')
    process.exit(HOOK_BLOCK_EXIT_CODE)
  }
  const grant = JSON.parse(readFileSync(grantPath, 'utf8')) as ToolGrant
  const outcome = hookOutcome(grant, JSON.parse(readFileSync(0, 'utf8')) as ToolCall)
  for (const fileWrite of outcome.fileWrites) {
    if (fileWrite.append) appendFileSync(fileWrite.path, fileWrite.text)
    else writeFileSync(fileWrite.path, fileWrite.text)
  }
  process.stderr.write(outcome.message)
  process.exit(outcome.exitCode)
}

if (import.meta.main) main()
