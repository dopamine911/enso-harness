import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EnsoLibraryPrompt,
  type EnsoLibraryPromptListing,
  type EnsoLibraryPromptRefusal,
  type EnsoLibraryPromptSummary,
  EnsoLibraryPromptWrite,
  type EnsoProjectPromptLibrary,
  type EnsoSystemPromptChoice,
  EnsoSystemPromptDraft,
  ensoLogger,
  type EnsoLibraryPromptSource,
  isLibraryPromptId,
  libraryPromptRefOf,
  PROJECT_PROMPT_PREFIX,
  parseLibraryPrompt,
  serializeLibraryPrompt,
  summarizeLibraryPrompt,
} from '@enso/core'
import { projectPromptsDir } from '@enso/core/paths'
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
 * ⚠ EVERY WRITE SAYS WHAT IT EXPECTS ON DISK (`WriteCondition`, the routes' `If-None-Match` /
 * `If-Match`). A create never lands on a file that is there — a prompt someone else saved, or a
 * refused one nobody can read — and a replace or a delete lands only on the version its caller read
 * (its `etag`), so a file edited in another editor since is not overwritten unseen. The one exception
 * is asked for by name: `present`, "whatever is there, mine wins".
 *
 * ⚠ TWO LIBRARIES, NO PRECEDENCE (#470). The same module reads the user's library and a project's
 * own (`<project>/.enso/prompts/`, `projectPromptsDir`); they are listed apart, and a choice names
 * its library in its reference (`project:<id>`), so neither shadows the other. A project's is read
 * only when the thread trusts the project (`server/prompt-routes.ts`), and only READ: the routes that write
 * take the user's library alone, so a committed, shared file is changed in the repository.
 */

const log = ensoLogger('server', 'prompts')

const EXTENSION = '.md'

/** What every prompt route answers, and a configure naming a prompt, when the server was started without a library. */
export const NO_PROMPT_LIBRARY = 'this server has no prompt library (it was started without ENSO_HOME/prompts)'

/** The draft-preview body, checked against its closed schema. */
export function readSystemPromptDraftBody(raw: string): EnsoSystemPromptDraft {
  return readClosedBody(
    raw,
    EnsoSystemPromptDraft,
    'draft',
    'draft body takes only `mode` (system or append), a non-empty `text` and a `name` (1–120 characters)',
  )
}

/** The text's sha256, as a recorded choice carries it. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** An unsaved prompt as the choice a preview takes — named, hashed, never recorded. */
export function draftChoice(draft: EnsoSystemPromptDraft): EnsoSystemPromptChoice {
  return { id: 'draft', name: draft.name, mode: draft.mode, sha256: sha256Of(draft.text), text: draft.text }
}

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
  /** `etag`: the file's bytes, hashed — what a later replace or delete names as the version it read. */
  | { readonly kind: 'prompt'; readonly prompt: EnsoLibraryPrompt; readonly etag: string }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * What a write or a delete expects on disk: no file (`absent`, a create or a rename's new name),
 * the version it read (`matches`), or any file at all (`present`, the explicit "mine wins").
 */
export type WriteCondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'matches'; readonly etag: string }
  | { readonly kind: 'present' }

/** What the disk held instead of what the condition expected — never a write. */
export type WriteConflict = { readonly kind: 'conflict'; readonly reason: string }

export type SystemPromptPick =
  | { readonly kind: 'chosen'; readonly choice: EnsoSystemPromptChoice }
  | { readonly kind: 'refused'; readonly reason: string }

export interface PromptLibrary {
  /** Where the files are — named in a refusal, so a person can go and fix one. */
  readonly directory: string
  list(): EnsoLibraryPromptListing
  read(id: string): LibraryRead
  /** Writes the file whole when the disk holds what `condition` expects, and answers it as read back. */
  write(id: string, fields: EnsoLibraryPromptWrite, condition: WriteCondition): LibraryRead | WriteConflict
  /** Removes the file when the disk holds what `condition` expects; `missing` when there was none. */
  remove(id: string, condition: Exclude<WriteCondition, { kind: 'absent' }>): 'removed' | 'missing' | WriteConflict
  /** A `system` or `append` prompt as the choice a session records, or why it cannot be one. */
  pickSystemPrompt(id: string): SystemPromptPick
}

/**
 * The file an id names. ⚠ The one join of a caller's id with the directory, so the id is checked
 * HERE: the routes' patterns hold it for `/api/prompts/:id`, but configure's `systemPrompt` is a body
 * field, and `../x` would otherwise read — or answer whether there is — a `.md` anywhere on disk.
 */
function pathOf(directory: string, id: string): string {
  if (!isLibraryPromptId(id)) throw new Error(`${JSON.stringify(id)} is not a library prompt id`)
  return join(directory, `${id}${EXTENSION}`)
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/**
 * ⚠ STRICT, AND BOM KEPT. A lenient decode turns every byte that is not UTF-8 into U+FFFD, and the
 * file would be read — hashed, sent to the model — as something it does not say: refused instead,
 * by name. The BOM is left in the text for the parser to read past, so the text re-encodes to the
 * file's exact bytes and `bytes` stays the size on disk.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A strong entity tag for a file's bytes, quoted as HTTP writes one. */
function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`
}

/** The file's etag, or `undefined` when there is no file. */
function currentEtag(path: string): string | undefined {
  try {
    return etagOf(readFileSync(path))
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/** Why the file on disk is not what `condition` expects, or `undefined` when it is. */
function conflictOf(path: string, file: string, condition: WriteCondition): string | undefined {
  const etag = currentEtag(path)
  if (condition.kind === 'absent') return etag === undefined ? undefined : `${file} already exists`
  if (etag === undefined) return `${file} is no longer there: it was deleted since it was opened`
  if (condition.kind === 'matches' && etag !== condition.etag) return `${file} changed on disk since it was opened`
  return undefined
}

function readFile(directory: string, id: string): LibraryRead {
  const file = `${id}${EXTENSION}`
  // Refused, never missing: a listed `Notes.md` must still be named, and nothing outside is looked at.
  if (!isLibraryPromptId(id))
    return { kind: 'refused', reason: `${file}: the name is not lowercase words joined by hyphens` }
  let bytes: Uint8Array
  let text: string
  try {
    bytes = readFileSync(pathOf(directory, id))
    text = UTF8.decode(bytes)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing', reason: `no prompt ${id} in ${directory}` }
    if (error instanceof TypeError) return { kind: 'refused', reason: `${file}: is not UTF-8 text` }
    return { kind: 'refused', reason: `${file}: cannot be read (${errorCode(error) ?? String(error)})` }
  }
  const parsed = parseLibraryPrompt(id, text)
  return parsed.kind === 'prompt'
    ? { kind: 'prompt', prompt: parsed.prompt, etag: etagOf(bytes) }
    : { kind: 'refused', reason: parsed.reason }
}

/** The `.md` names in the directory; none when it does not exist yet. */
function libraryIds(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((fileName) => fileName.endsWith(EXTENSION))
      .map((fileName) => fileName.slice(0, -EXTENSION.length))
      .toSorted()
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

/**
 * The library in `directory`. `source` is which one it is: the choices it picks are named by
 * `project:<id>` for a project's, by the bare id for the user's (`libraryPromptRefOf`).
 */
export function createPromptLibrary(directory: string, source: EnsoLibraryPromptSource = 'user'): PromptLibrary {
  return {
    directory,
    list(): EnsoLibraryPromptListing {
      const prompts: EnsoLibraryPromptSummary[] = []
      const refused: EnsoLibraryPromptRefusal[] = []
      for (const promptId of libraryIds(directory)) {
        const read = readFile(directory, promptId)
        if (read.kind === 'prompt') prompts.push(summarizeLibraryPrompt(read.prompt))
        else if (read.kind === 'refused') refused.push({ file: `${promptId}${EXTENSION}`, reason: read.reason })
      }
      prompts.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      return { prompts, refused }
    },
    read: (id) => readFile(directory, id),
    write(id: string, fields: EnsoLibraryPromptWrite, condition: WriteCondition): LibraryRead | WriteConflict {
      mkdirSync(directory, { recursive: true })
      const path = pathOf(directory, id)
      const file = `${id}${EXTENSION}`
      // A create is checked by the link itself (below); a replace against what is there now. The
      // requests are synchronous, so no other write of this server lands between the two.
      const conflict = condition.kind === 'absent' ? undefined : conflictOf(path, file, condition)
      if (conflict !== undefined) return { kind: 'conflict', reason: conflict }
      const staging = `${path}.${process.pid}.tmp`
      try {
        writeFileSync(staging, serializeLibraryPrompt(fields))
        if (condition.kind !== 'absent') renameSync(staging, path)
        else {
          // ⚠ `link`, not `rename`: a link fails on a name that exists, so a create cannot land on a
          // file that appeared since anyone looked — the check and the write are one call.
          linkSync(staging, path)
          rmSync(staging)
        }
      } catch (error: unknown) {
        // A half-written stage is never the prompt: remove it, so a failed write leaves the directory as it was.
        rmSync(staging, { force: true })
        if (condition.kind === 'absent' && errorCode(error) === 'EEXIST') {
          return { kind: 'conflict', reason: `${file} already exists` }
        }
        throw error
      }
      log.info('prompt {id} written ({category}, {condition})', {
        id,
        category: fields.category,
        condition: condition.kind,
      })
      return readFile(directory, id)
    },
    remove(id, condition) {
      const path = pathOf(directory, id)
      if (currentEtag(path) === undefined) return 'missing'
      const conflict = conflictOf(path, `${id}${EXTENSION}`, condition)
      if (conflict !== undefined) return { kind: 'conflict', reason: conflict }
      try {
        rmSync(path)
      } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return 'missing'
        throw error
      }
      log.info('prompt {id} deleted', { id })
      return 'removed'
    },
    pickSystemPrompt(id: string): SystemPromptPick {
      const read = readFile(directory, id)
      if (read.kind !== 'prompt') return { kind: 'refused', reason: read.reason }
      const { name, category, body } = read.prompt
      if (category === 'session') {
        return {
          kind: 'refused',
          reason: `${name} is a session prompt: it fills the first message, not the system prompt`,
        }
      }
      // pi reads an empty custom preamble as none and builds its default: say so, never run it silently.
      if (body.trim().length === 0) return { kind: 'refused', reason: `${name} has no text to send` }
      return {
        kind: 'chosen',
        choice: { id: libraryPromptRefOf(source, id), name, mode: category, sha256: sha256Of(body), text: body },
      }
    },
  }
}

/**
 * A thread's project library (#470): read when the thread trusts its project, else not read at all
 * — only where it would be is known, so a refusal can say where to look.
 */
export type ProjectLibraryAccess =
  | { readonly kind: 'trusted'; readonly library: PromptLibrary }
  | { readonly kind: 'untrusted'; readonly directory: string }

/** The project library of `cwd`, as a thread that does (or does not) trust the project reads it. */
export function projectLibraryAccess(cwd: string, trusted: boolean): ProjectLibraryAccess {
  const directory = projectPromptsDir(cwd)
  return trusted
    ? { kind: 'trusted', library: createPromptLibrary(directory, 'project') }
    : { kind: 'untrusted', directory }
}

/** Why a project's prompt is not read: the project is not trusted — and how it becomes so. */
export function untrustedProjectReason(directory: string): string {
  return (
    `the project's prompts (${directory}) are read only once the project is trusted: ` +
    'answer "Trust project" when a run in it asks, then start a new session'
  )
}

/** `GET …/project-prompts`: the listing, or that the project is not trusted. */
export function projectPromptListing(access: ProjectLibraryAccess): EnsoProjectPromptLibrary {
  return access.kind === 'trusted'
    ? { kind: 'listed', directory: access.library.directory, listing: access.library.list() }
    : { kind: 'untrusted', directory: access.directory }
}

/**
 * A prompt reference as a session's system prompt (#443, #470): a bare id from the user's library
 * (`user`, absent when the server has none), `project:<id>` from the thread's project library
 * (`project`, asked only for a project reference) — or why it cannot be one.
 */
export function pickLibrarySystemPrompt(
  ref: string,
  user: PromptLibrary | undefined,
  project: () => ProjectLibraryAccess,
): SystemPromptPick {
  // Anything without the prefix is the user's, as before #470: an id off the grammar is refused by
  // the library, by name. A project reference's id is the project library's to refuse the same way.
  if (!ref.startsWith(PROJECT_PROMPT_PREFIX)) {
    return user === undefined ? { kind: 'refused', reason: NO_PROMPT_LIBRARY } : user.pickSystemPrompt(ref)
  }
  const access = project()
  return access.kind === 'trusted'
    ? access.library.pickSystemPrompt(ref.slice(PROJECT_PROMPT_PREFIX.length))
    : { kind: 'refused', reason: untrustedProjectReason(access.directory) }
}
