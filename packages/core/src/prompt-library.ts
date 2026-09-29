import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'

/**
 * The prompt library (#443): markdown files a person writes once and starts sessions with.
 *
 * ⚠ A PROMPT IS A FILE, NOT A ROW. `ENSO_HOME/prompts/<id>.md` (`@enso/core/paths` →
 * `ensoPromptsDir`), under *state is files* (`docs/architecture.md` → *Runtime shape*). The id is
 * the file name, so a library prompt can be read, diffed and copied without the server.
 *
 * ⚠ THREE CATEGORIES, ONE FILE SHAPE. The frontmatter's `category` says where the body goes:
 *
 *  - `system` — REPLACES pi's preamble. pi then writes none of its own `tools`, `rules` or `docs`
 *    sections (`buildSystemPromptSections`: a custom prompt is the preamble and those three are
 *    skipped); the addendum, project context, skills and `cwd` stay pi's, and the tool schemas
 *    are sent either way.
 *  - `append` — ADDED to pi's prompt: pi's own sections all stay, and the body is appended after
 *    any `APPEND_SYSTEM.md` pi found (`<addendum>`).
 *  - `session` — a user prompt: it fills the first message, and changes nothing in the system head.
 *
 * `system` and `append` are the **system-prompt modes**; a session takes at most one, at its start,
 * for its whole life — never per turn, because a system head rewritten per turn throws the prompt
 * cache away on every request (`docs/concepts/prompt-cache-architecture.md`, finding 1).
 *
 * ⚠ FRONTMATTER IS A CLOSED, FLAT SET. `name`, `description`, `category` and nothing else, one
 * `key: value` per line; a value may be a JSON string (`"…"`) when it needs quoting. Anything else —
 * an unknown key, a nested value, a missing `category` — refuses the file BY NAME, the way the
 * config refuses a typo (`config.ts`): a prompt that silently read as something else is the failure
 * this exists to prevent. This is no YAML parser, and says so rather than half-being one.
 */

/**
 * Where a library prompt goes: `system` replaces pi's preamble, `append` adds to pi's prompt,
 * `session` fills the first message.
 *
 * @group Prompt library
 */
export const EnsoLibraryPromptCategory = Type.Union([
  Type.Literal('system'),
  Type.Literal('append'),
  Type.Literal('session'),
])
/** @group Prompt library */
export type EnsoLibraryPromptCategory = Static<typeof EnsoLibraryPromptCategory>

/**
 * The categories a session's system prompt may be chosen from — the system-prompt modes.
 *
 * @group Prompt library
 */
export const EnsoSystemPromptMode = Type.Union([Type.Literal('system'), Type.Literal('append')])
/** @group Prompt library */
export type EnsoSystemPromptMode = Static<typeof EnsoSystemPromptMode>

const CATEGORIES: ReadonlySet<string> = new Set(['system', 'append', 'session'])

/** A library prompt's id: its file name without `.md` — lowercase words joined by hyphens. */
const LIBRARY_PROMPT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * True for a string that can name a library prompt, and therefore a file: no separator, no dot,
 * nothing a path could climb out with.
 *
 * @group Prompt library
 */
export function isLibraryPromptId(value: unknown): value is string {
  return typeof value === 'string' && LIBRARY_PROMPT_ID_PATTERN.test(value)
}

/**
 * The estimate every token count of a prompt's TEXT is: characters over four, rounded up — how pi
 * prices a system-prompt section (`context-elements.ts` prices every section and tool definition
 * with this), so the editor's number and the Context tab's for the same text cannot disagree.
 *
 * @group Prompt library
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const encoder = new TextEncoder()

/**
 * The size of `text` on disk: its UTF-8 bytes, exact.
 *
 * @group Prompt library
 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length
}

/** What a library prompt says about itself, and its body — the editable part of a file. */
const libraryPromptFields = {
  /** What lists show. */
  name: Type.String({ minLength: 1, maxLength: 120 }),
  /** One line, optional in the file; empty when absent. */
  description: Type.String({ maxLength: 500 }),
  category: EnsoLibraryPromptCategory,
  /** The markdown after the frontmatter. */
  body: Type.String(),
}

/**
 * `PUT /api/prompts/:id`: a prompt's fields; the server writes the file.
 *
 * @group Prompt library
 */
export const EnsoLibraryPromptWrite = Type.Object(libraryPromptFields, { additionalProperties: false })
/** @group Prompt library */
export type EnsoLibraryPromptWrite = Static<typeof EnsoLibraryPromptWrite>

/** The sizes every read carries: the file's bytes, and the body's estimated tokens. */
const librarySizes = {
  /** The file's size on disk, exact. */
  bytes: Type.Integer({ minimum: 0 }),
  /** The BODY's estimated tokens ({@link estimateTextTokens}) — what reaches the model. */
  tokens: Type.Integer({ minimum: 0 }),
}

/**
 * One library prompt, read: `GET /api/prompts/:id`.
 *
 * @group Prompt library
 */
export const EnsoLibraryPrompt = Type.Object(
  { id: Type.String(), ...libraryPromptFields, ...librarySizes },
  { additionalProperties: false },
)
/** @group Prompt library */
export type EnsoLibraryPrompt = Static<typeof EnsoLibraryPrompt>

/**
 * One library prompt as a list shows it — everything but the body.
 *
 * @group Prompt library
 */
export const EnsoLibraryPromptSummary = Type.Object(
  {
    id: Type.String(),
    name: libraryPromptFields.name,
    description: libraryPromptFields.description,
    category: EnsoLibraryPromptCategory,
    ...librarySizes,
  },
  { additionalProperties: false },
)
/** @group Prompt library */
export type EnsoLibraryPromptSummary = Static<typeof EnsoLibraryPromptSummary>

/**
 * A file in the library that is not a prompt it can use, and why — listed, never skipped.
 *
 * @group Prompt library
 */
export const EnsoLibraryPromptRefusal = Type.Object(
  { file: Type.String(), reason: Type.String() },
  { additionalProperties: false },
)
/** @group Prompt library */
export type EnsoLibraryPromptRefusal = Static<typeof EnsoLibraryPromptRefusal>

/**
 * `GET /api/prompts`: the library's prompts by name, and every file it refused.
 *
 * @group Prompt library
 */
export const EnsoLibraryPromptListing = Type.Object(
  {
    prompts: Type.Array(EnsoLibraryPromptSummary),
    refused: Type.Array(EnsoLibraryPromptRefusal),
  },
  { additionalProperties: false },
)
/** @group Prompt library */
export type EnsoLibraryPromptListing = Static<typeof EnsoLibraryPromptListing>

/** @group Prompt library */
export type LibraryPromptParse =
  | { readonly kind: 'prompt'; readonly prompt: EnsoLibraryPrompt }
  | { readonly kind: 'refused'; readonly reason: string }

const FRONTMATTER_FENCE = '---'
const FRONTMATTER_KEYS: ReadonlySet<string> = new Set(['name', 'description', 'category'])

/** One `key: value` line's value: a JSON string when it starts with a quote, else the text as written. */
function frontmatterValue(raw: string): string | undefined {
  if (!raw.startsWith('"')) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The frontmatter's lines as fields, or why they are not. */
function readFrontmatter(lines: readonly string[]): Record<string, string> | string {
  const fields: Record<string, string> = {}
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const colon = line.indexOf(':')
    const key = colon === -1 ? line.trim() : line.slice(0, colon).trim()
    if (colon === -1 || !FRONTMATTER_KEYS.has(key)) {
      return `frontmatter line "${line.trim()}" is not one of name, description, category`
    }
    if (key in fields) return `frontmatter names ${key} twice`
    const value = frontmatterValue(line.slice(colon + 1).trim())
    if (value === undefined) return `frontmatter ${key} is not a readable string`
    fields[key] = value
  }
  return fields
}

/**
 * A library file's text as a prompt, or why it is not one. `id` is the file's name without `.md`.
 *
 * @group Prompt library
 */
export function parseLibraryPrompt(id: string, text: string): LibraryPromptParse {
  if (!LIBRARY_PROMPT_ID_PATTERN.test(id)) {
    return { kind: 'refused', reason: `${id}.md: the name is not lowercase words joined by hyphens` }
  }
  const lines = text.split(/\r?\n/)
  if (lines[0] !== FRONTMATTER_FENCE) {
    return { kind: 'refused', reason: `${id}.md: it does not open with a --- frontmatter block` }
  }
  const close = lines.indexOf(FRONTMATTER_FENCE, 1)
  if (close === -1) return { kind: 'refused', reason: `${id}.md: its frontmatter block is never closed with ---` }
  const fields = readFrontmatter(lines.slice(1, close))
  if (typeof fields === 'string') return { kind: 'refused', reason: `${id}.md: ${fields}` }
  const { name, description = '', category } = fields
  if (name === undefined || name.length === 0) return { kind: 'refused', reason: `${id}.md: frontmatter has no name` }
  if (category === undefined || !CATEGORIES.has(category)) {
    return { kind: 'refused', reason: `${id}.md: frontmatter category must be system, append or session` }
  }
  const body = lines.slice(close + 1).join('\n')
  const candidate = {
    id,
    name,
    description,
    category,
    body,
    bytes: utf8Bytes(text),
    tokens: estimateTextTokens(body),
  }
  if (!libraryPromptValidator.Check(candidate)) {
    return { kind: 'refused', reason: `${id}.md: its name or description is too long` }
  }
  return { kind: 'prompt', prompt: candidate }
}

/**
 * A prompt's fields as the file the library keeps: the frontmatter (every value a JSON string, so
 * any text reads back as written), then the body. {@link parseLibraryPrompt} reads it back equal.
 *
 * @group Prompt library
 */
export function serializeLibraryPrompt(prompt: EnsoLibraryPromptWrite): string {
  return [
    FRONTMATTER_FENCE,
    `name: ${JSON.stringify(prompt.name)}`,
    `description: ${JSON.stringify(prompt.description)}`,
    `category: ${prompt.category}`,
    FRONTMATTER_FENCE,
    prompt.body,
  ].join('\n')
}

/**
 * A library prompt without its body, for a list.
 *
 * @group Prompt library
 */
export function summarizeLibraryPrompt(prompt: EnsoLibraryPrompt): EnsoLibraryPromptSummary {
  const { body: _body, ...summary } = prompt
  return summary
}

/**
 * The `customType` a session's system-prompt choice is recorded under in pi's log.
 *
 * @group Prompt library
 */
export const ENSO_SYSTEM_PROMPT_ENTRY = 'enso-system-prompt' as const

/**
 * The system prompt a thread STARTED with (#443), recorded once in pi's log at session start and
 * read back to resume it. A thread with no such entry runs pi's default.
 *
 * ⚠ THE TEXT IS KEPT, not only its hash. The thread must resume with the prompt it started with,
 * and the library file may have been edited or deleted since; the hash is what a later reader
 * compares against the library to say "this prompt has changed since". It adds nothing the log
 * does not already hold — pi writes the same text into its own system message on the first request.
 *
 * @group Prompt library
 */
export const EnsoSystemPromptChoice = Type.Object(
  {
    /** The library prompt's id at session start. */
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    mode: EnsoSystemPromptMode,
    /** sha256 of `text`, lowercase hex. */
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    text: Type.String(),
  },
  { additionalProperties: false },
)
/** @group Prompt library */
export type EnsoSystemPromptChoice = Static<typeof EnsoSystemPromptChoice>

const libraryPromptValidator = Compile(EnsoLibraryPrompt)
const systemPromptChoiceValidator = Compile(EnsoSystemPromptChoice)

/**
 * A recorded entry's data as a choice, or `undefined` when it does not read as one.
 *
 * @group Prompt library
 */
export function readEnsoSystemPromptChoice(data: unknown): EnsoSystemPromptChoice | undefined {
  return systemPromptChoiceValidator.Check(data) ? data : undefined
}
