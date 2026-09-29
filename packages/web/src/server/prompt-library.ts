import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EnsoLibraryPrompt,
  type EnsoLibraryPromptListing,
  type EnsoLibraryPromptRefusal,
  type EnsoLibraryPromptSummary,
  EnsoLibraryPromptWrite,
  type EnsoSystemPromptChoice,
  ensoLogger,
  parseLibraryPrompt,
  serializeLibraryPrompt,
  summarizeLibraryPrompt,
} from '@enso/core'
import { readClosedBody } from './follow.ts'

/**
 * The prompt library on disk (#443): `ENSO_HOME/prompts/<id>.md`, read on every request — the
 * files are the record, so an edit made in another editor is what the next list shows.
 *
 * ⚠ REFUSED BY NAME, NEVER SKIPPED. A `.md` file that cannot be read, or does not parse
 * (`parseLibraryPrompt`), is listed under `refused` with its reason, and choosing it for a session
 * is a refusal that says the same — never a silent fall back to pi's default. A file that is not
 * `.md` is not a prompt and is not listed.
 *
 * The user's library only, for now: a project library (committed under `.pi/`) is a later slice,
 * and when it lands its precedence is stated here.
 */

const log = ensoLogger('server', 'prompts')

const EXTENSION = '.md'

/** What every prompt route answers, and a configure naming a prompt, when the server was started without a library. */
export const NO_PROMPT_LIBRARY = 'this server has no prompt library (it was started without ENSO_HOME/prompts)'

/** The `PUT` body, checked against its closed schema. */
export function readPromptWriteBody(raw: string): EnsoLibraryPromptWrite {
  return readClosedBody(
    raw,
    EnsoLibraryPromptWrite,
    'prompt',
    'prompt body takes only `name` (1–120 characters), `description` (at most 500), `category` (system, append or session) and `body`',
  )
}

export type LibraryRead =
  | { readonly kind: 'prompt'; readonly prompt: EnsoLibraryPrompt }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly reason: string }

export type SystemPromptPick =
  | { readonly kind: 'chosen'; readonly choice: EnsoSystemPromptChoice }
  | { readonly kind: 'refused'; readonly reason: string }

export interface PromptLibrary {
  /** Where the files are — named in a refusal, so a person can go and fix one. */
  readonly directory: string
  list(): EnsoLibraryPromptListing
  read(id: string): LibraryRead
  /** Writes the file whole (staged, then renamed over) and answers it as read back. */
  write(id: string, fields: EnsoLibraryPromptWrite): LibraryRead
  /** False when there was no such file. */
  remove(id: string): boolean
  /** A `system` or `append` prompt as the choice a session records, or why it cannot be one. */
  pickSystemPrompt(id: string): SystemPromptPick
}

function pathOf(directory: string, id: string): string {
  return join(directory, `${id}${EXTENSION}`)
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function readFile(directory: string, id: string): LibraryRead {
  let text: string
  try {
    text = readFileSync(pathOf(directory, id), 'utf8')
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', reason: `${id}${EXTENSION}: cannot be read (${errorCode(error) ?? String(error)})` }
  }
  const parsed = parseLibraryPrompt(id, text)
  return parsed.kind === 'prompt' ? parsed : { kind: 'refused', reason: parsed.reason }
}

/** The `.md` names in the directory; none when it does not exist yet. */
function libraryIds(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(EXTENSION))
      .map((name) => name.slice(0, -EXTENSION.length))
      .toSorted()
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

export function createPromptLibrary(directory: string): PromptLibrary {
  return {
    directory,
    list(): EnsoLibraryPromptListing {
      const prompts: EnsoLibraryPromptSummary[] = []
      const refused: EnsoLibraryPromptRefusal[] = []
      for (const id of libraryIds(directory)) {
        const read = readFile(directory, id)
        if (read.kind === 'prompt') prompts.push(summarizeLibraryPrompt(read.prompt))
        else if (read.kind === 'refused') refused.push({ file: `${id}${EXTENSION}`, reason: read.reason })
      }
      prompts.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      return { prompts, refused }
    },
    read: (id) => readFile(directory, id),
    write(id: string, fields: EnsoLibraryPromptWrite): LibraryRead {
      mkdirSync(directory, { recursive: true })
      const path = pathOf(directory, id)
      const staging = `${path}.${process.pid}.tmp`
      writeFileSync(staging, serializeLibraryPrompt(fields))
      renameSync(staging, path)
      log.info('prompt {id} written ({category})', { id, category: fields.category })
      return readFile(directory, id)
    },
    remove(id: string): boolean {
      try {
        rmSync(pathOf(directory, id))
      } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return false
        throw error
      }
      log.info('prompt {id} deleted', { id })
      return true
    },
    pickSystemPrompt(id: string): SystemPromptPick {
      const read = readFile(directory, id)
      if (read.kind === 'missing') return { kind: 'refused', reason: `no prompt ${id} in ${directory}` }
      if (read.kind === 'refused') return read
      const { name, category, body } = read.prompt
      if (category === 'session') {
        return {
          kind: 'refused',
          reason: `${name} is a session prompt: it fills the first message, not the system prompt`,
        }
      }
      // pi reads an empty custom preamble as none and builds its default: say so, never run it silently.
      if (body.trim().length === 0) return { kind: 'refused', reason: `${name} has no text to send` }
      const sha256 = createHash('sha256').update(body).digest('hex')
      return { kind: 'chosen', choice: { id, name, mode: category, sha256, text: body } }
    },
  }
}
