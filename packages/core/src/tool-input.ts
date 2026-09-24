/**
 * A tool call's one-line subject — `ls -la`, `src/x.ts`, `TODO` — shared by the transcript's step
 * row (`selected-message-part.tsx`) and the Context view's brief (`host/branch-context.ts`, #361),
 * so a call reads the same in both. Here because both the browser and the host read it, and core
 * is the one module both may import.
 */

/**
 * The argument a step row is summarised by, in precedence. Each of pi's built-ins and the
 * harness tools names its subject one of these ways: bash `command`, grep/find `pattern`,
 * read/write/edit/ls `path`, web_search `query`, web_fetch `url`. `pattern` precedes `path`
 * because grep and find carry both and the pattern is what you would ask about. A tool
 * that names its subject some other way (an MCP tool, say) falls back to its first string
 * argument — a guess, but a visible one, better than a bare name.
 */
const SUMMARY_KEYS = ['command', 'pattern', 'path', 'query', 'url'] as const
/** One line of a step row; a multi-line bash command shows its first line and an ellipsis. */
const SUMMARY_MAX_CHARS = 80

/** The head of the first line; an ellipsis whenever that is less than the whole value. */
function clipToOneLine(value: string): string {
  const head = (value.split('\n', 1)[0] ?? '').slice(0, SUMMARY_MAX_CHARS)
  return head.length < value.length ? `${head}…` : head
}

/**
 * The one-line subject of a tool call, or undefined when its input names nothing usable.
 *
 * @group Tool results
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) return clipToOneLine(candidate)
  }
  for (const candidate of Object.values(record)) {
    if (typeof candidate === 'string' && candidate.length > 0) return clipToOneLine(candidate)
  }
  return undefined
}
