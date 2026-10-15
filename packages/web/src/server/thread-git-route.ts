import type {
  EnsoGitFileChange,
  EnsoGitRepository,
  EnsoGitState,
  EnsoThreadChangedFile,
  EnsoThreadChanges,
  EnsoThreadGit,
} from '@enso/core'
import { type ChangedFilePaths, type ChangedFileTexts, isPathInScope } from '@enso/core/git'
import type { AgentHost } from '../host/agent-host.ts'
import type { ThreadTreePlace } from '../host/thread-log-edits.ts'
import type { ThreadRegistry } from './thread-registry.ts'

/**
 * `GET /api/threads/:threadId/git` (#453): git's state in the thread's cwd — the repository, the
 * branch, the last-push baseline and the work not yet pushed (`@enso/core/git`). And
 * `GET /api/threads/:threadId/changes` (#452): that state, with every file that differs from the
 * baseline and its patch — what the Diff view draws. Read when asked: the working tree moves
 * under a run, so nothing is cached, and nothing is recorded.
 *
 * The cwd comes from pi's memory for a live thread and from the session file's header otherwise.
 * Looking builds nothing (#86). A stored thread whose project this server no longer serves is no
 * answer: git is never run in a directory the server does not serve.
 */

/** What finds a thread's cwd and says whether this server serves it: the git routes' and the preview's (#619). */
export interface ThreadCwdDeps {
  /** Only the peek: the route reads a live thread and never builds one (#86). */
  readonly threads: Pick<ThreadRegistry, 'peek'>
  readonly host: Pick<AgentHost, 'storedThreadDirectory'>
  /** The server's projects rule (#395): a directory the server may read or run git in. */
  readonly servesDirectory: (directory: string) => boolean
}

export interface ThreadGitRouteDeps extends ThreadCwdDeps {
  /** `readGitState` over the real git runner; a test hands in its own. */
  readonly readGit: (cwd: string) => Promise<EnsoGitState>
}

export interface ThreadChangesRouteDeps extends ThreadGitRouteDeps {
  /** `readGitChanges` over the real git runner; a test hands in its own. */
  readonly readChanges: (repository: EnsoGitRepository) => Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>
  /** The thread's tree record and its store (#650): the host's `threadTree`; a test hands in its own. */
  readonly threadTree: (threadId: string) => Promise<ThreadTreePlace | undefined>
  /** A copy's changes since its `base`, from its store: the host's `readCopyChanges`; a test hands in its own. */
  readonly readCopyChanges: (copy: ThreadTreePlace) => Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>
}

/** The thread's cwd, when it may be read: live or stored, and in a directory this server serves. */
export async function servedCwd(deps: ThreadCwdDeps, threadId: string): Promise<string | undefined> {
  const cwd = deps.threads.peek(threadId)?.hosted.inspect().cwd ?? (await deps.host.storedThreadDirectory(threadId))
  return cwd !== undefined && deps.servesDirectory(cwd) ? cwd : undefined
}

export function createThreadGitRoute(
  deps: ThreadGitRouteDeps,
): (threadId: string) => Promise<EnsoThreadGit | undefined> {
  return async (threadId: string): Promise<EnsoThreadGit | undefined> => {
    const cwd = await servedCwd(deps, threadId)
    return cwd === undefined ? undefined : { threadId, cwd, git: await deps.readGit(cwd) }
  }
}

/** A diff that could not be produced, as git unavailable with its reason. */
function unavailable(error: unknown, fallback: string): EnsoGitState {
  return { kind: 'unavailable', reason: error instanceof Error && error.message !== '' ? error.message : fallback }
}

/**
 * A diff git could not produce after naming the repository reads as git unavailable, with its
 * reason — never as a tree with nothing changed. A thread whose tree is a copy (#650) has no
 * repository in its cwd: its changes since the copy was made come from its snapshot store, with
 * `copy` naming the project and `base`, and a store that cannot be read is unavailable too.
 */
export function createThreadChangesRoute(
  deps: ThreadChangesRouteDeps,
): (threadId: string) => Promise<EnsoThreadChanges | undefined> {
  return async (threadId: string): Promise<EnsoThreadChanges | undefined> => {
    const cwd = await servedCwd(deps, threadId)
    if (cwd === undefined) return undefined
    const git = await deps.readGit(cwd)
    if (git.kind === 'not-a-repository') {
      const tree = await deps.threadTree(threadId)
      if (tree?.record.kind === 'copy') return readCopy(deps, { threadId, cwd, git }, tree)
    }
    if (git.kind !== 'repository') return { threadId, cwd, git, files: [], truncated: false, copy: null }
    try {
      return { threadId, cwd, git, ...(await deps.readChanges(git)), copy: null }
    } catch (error) {
      return {
        threadId,
        cwd,
        git: unavailable(error, 'git could not diff the tree'),
        files: [],
        truncated: false,
        copy: null,
      }
    }
  }
}

/** A copy's changes from its store, under the cwd's own `git`; a store that cannot be read, as git unavailable. */
async function readCopy(
  deps: ThreadChangesRouteDeps,
  read: Pick<EnsoThreadChanges, 'threadId' | 'cwd' | 'git'>,
  tree: ThreadTreePlace,
): Promise<EnsoThreadChanges> {
  try {
    const copy = { project: tree.record.project, base: tree.record.base }
    return { ...read, ...(await deps.readCopyChanges(tree)), copy }
  } catch (error) {
    const git = unavailable(error, "the copy's snapshot store could not be read")
    return { ...read, git, files: [], truncated: false, copy: null }
  }
}

export interface ThreadChangedFileRouteDeps extends ThreadGitRouteDeps {
  /** `readGitFileTexts` over the real git runner; a test hands in its own. */
  readonly readFileTexts: (repository: EnsoGitRepository, paths: ChangedFilePaths) => Promise<ChangedFileTexts>
  /** The thread's tree record and its store (#650): the host's `threadTree`; a test hands in its own. */
  readonly threadTree: (threadId: string) => Promise<ThreadTreePlace | undefined>
  /** One of a copy's changed files, from its store: the host's `readCopyFileTexts`; a test hands in its own. */
  readonly readCopyFileTexts: (copy: ThreadTreePlace, paths: ChangedFilePaths) => Promise<ChangedFileTexts>
}

/** What `GET …/changes/file` answers: the file, or a refusal with its status and reason. */
export type ChangedFileAnswer =
  | { readonly kind: 'file'; readonly file: EnsoThreadChangedFile }
  | { readonly kind: 'refused'; readonly status: number; readonly reason: string }

/** The changed-file read: a thread's file by its paths, answered or refused; `undefined` for a thread held nowhere. */
export type ChangedFileRoute = (threadId: string, paths: ChangedFilePaths) => Promise<ChangedFileAnswer | undefined>

/**
 * `GET /api/threads/:threadId/changes/file` (#461): one changed file whole, on both sides — what
 * the Diff view expands the unchanged lines between hunks from. Read where the changes are read: a
 * repository's from its git, a copy's from its store (#650).
 *
 * ⚠ ONLY INSIDE THE SCOPE, THE LIMIT #456 SET. Both paths must name a file under the repository's
 * `scope` (a copy's is the whole copy), or the read is refused with a 400 before anything is read:
 * a project inside a dotfiles repository at `$HOME` must not read any file under home through
 * this route. Outside a repository and a copy, or with git unable to answer, there is nothing to
 * read from: a 409. `undefined` is a thread held nowhere, or in a directory the server does not serve.
 */
export function createThreadChangedFileRoute(deps: ThreadChangedFileRouteDeps): ChangedFileRoute {
  return async (threadId, paths) => {
    const cwd = await servedCwd(deps, threadId)
    if (cwd === undefined) return undefined
    const git = await deps.readGit(cwd)
    if (git.kind === 'repository') return readInScope(threadId, git.scope, paths, () => deps.readFileTexts(git, paths))
    if (git.kind === 'unavailable')
      return { kind: 'refused', status: 409, reason: `git could not answer: ${git.reason}` }
    const tree = await deps.threadTree(threadId)
    if (tree?.record.kind === 'copy') return readInScope(threadId, '', paths, () => deps.readCopyFileTexts(tree, paths))
    return { kind: 'refused', status: 409, reason: "the thread's folder is in no repository and is no copy" }
  }
}

/** The file's two sides, when both paths are under `scope`; a 400 naming the first that is not. */
async function readInScope(
  threadId: string,
  scope: string,
  paths: ChangedFilePaths,
  read: () => Promise<ChangedFileTexts>,
): Promise<ChangedFileAnswer> {
  const outside = [paths.path, paths.oldPath].find((path) => path !== null && !isPathInScope(scope, path))
  if (outside !== undefined) {
    const where = scope === '' ? 'the tree' : scope
    return { kind: 'refused', status: 400, reason: `${JSON.stringify(outside)} is not a file under ${where}` }
  }
  return { kind: 'file', file: { threadId, path: paths.path, oldPath: paths.oldPath, ...(await read()) } }
}
