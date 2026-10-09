import {
  type EnsoForkPoint,
  type EnsoPermissionModeState,
  type EnsoRiskThresholds,
  type EnsoTranscriptEntry,
  ensoLogger,
  type RuntimeCommand,
  type EnsoGitFileChange,
  type EnsoThreadDeletePreview,
  type EnsoTreesListing,
} from '@enso/core'
import { ensoHome, ensoSecretsPath, findRepoRoot } from '@enso/core/paths'
import { describePermissionPolicy, preparePermissionPolicy } from '@enso/core/permission-rules'
import { quarantineSecrets } from '@enso/core/secrets'
import { readCopyChanges } from '@enso/core/snapshot-store'
import type { BranchRequestDetail } from './branch-context.ts'
import type { BranchEval } from './branch-eval.ts'
import type { BranchIncidentHistory } from './branch-incident-history.ts'
import type { BranchJudgeCases } from './branch-judge-cases.ts'
import { buildHostedThread, type HostedThreadHost, prepareRuntimeTheme } from './hosted-thread.ts'
import type { HostedThread, ProjectTrustState } from './live-thread.ts'
import { seedMultiAccountConfig } from './multi-account-seed.ts'
import { freshPermissionModeState, storedPermissionModeState } from './permission-mode-adapter.ts'
import { hostedProjectTrust } from './project-trust.ts'
import { catalogueOf, sessionModels } from './session-models.ts'
import {
  createStoredThreads,
  type StoredThread,
  type StoredThreadContext,
  type StoredThreadRead,
  type StoredThreadStats,
} from './stored-threads.ts'
import { createThreadDelete, type ThreadDeleteOutcome, ThreadDeleted } from './thread-delete.ts'
import { createThreadFork, type ThreadForkOutcome } from './thread-fork.ts'
import {
  createThreadLogEdits,
  type ThreadRenameOutcome,
  type ThreadRestoreOutcome,
  type ThreadTreePlace,
} from './thread-log-edits.ts'
import { createLog, openLog, probeLog, type ThreadLog } from './thread-log.ts'
import { treeOnFirstRun } from './thread-on-tree.ts'
import { createTreeMaking } from './thread-tree-making.ts'
import { sessionDirectoryFor, treeRecordOf } from './thread-trees.ts'
import { type ProjectThreadSettingsSource } from './tree-setup.ts'

/**
 * pi, hosted IN THIS PROCESS (#69): the web server's threads, built and served by one host instead of
 * a `pi --mode rpc` per prompt. `createAgentHost` is the one entry point. It sets the process up for
 * pi before the first thread, then composes the host's flows: the stored threads, tree making, fork,
 * edits and delete over `ThreadLog` (`thread-log.ts`, the storage seam), and each live thread
 * (`hosted-thread.ts`).
 *
 * ⚠⚠ `PI_CODING_AGENT_DIR` IS SET BEFORE THE FIRST SERVICES. pi-multi-account reads it at MODULE
 * IMPORT (`index.ts:752`) and derives `auth.json`, `settings.json` and `models.json` from it; unset,
 * it reads the operator's real `~/.pi/agent`. Set on `process.env`, once, at host creation, with the
 * agent dir's multi-account config seeded (`multi-account-seed.ts`).
 *
 * ⚠⚠ THE PERMISSION ENGINE READS `ENSO_HOME/permissions.json` THROUGH A LINK (#446, #496), prepared
 * first. The engine reads its policy from `<agentDir>/extensions/pi-permission-system/config.json`
 * and takes no path from the environment, so `preparePermissionPolicy` (`@enso/core/permission-rules`)
 * links that path to the user's file, seeds the file when it holds no policy, and writes the mode
 * agents (`<agentDir>/agents/enso-mode-*.md`) the mode presets live in. It runs after
 * `PI_CODING_AGENT_DIR` names the agent dir and before the first services: the engine reads both
 * when the extension loads, per session.
 *
 * ⚠⚠ EVERY THREAD IS A MULTI-ACCOUNT ROOT: `PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS=1` (#351).
 * pi-multi-account keeps ONE root session per process for terminal pi — a lease on
 * `globalThis[Symbol.for('pi-multi-account:active-root-session')]` — and a session that starts while
 * it is held goes passive: accounts register, automatic failover is off. Here every thread is a
 * session in this one process and an idle one stays live for 30 minutes (`thread-registry.ts`), so
 * the thread in use would usually be the passive one. Since 1.23.2 the extension skips the lease for
 * a multi-session host that says so (Sarrius/pi-multi-account#73): the host sets the switch before
 * the first session, and every `session_start` becomes an independent root with its own failover.
 * Not `PI_WEB_SESSION`, pi-web's own marker. The switch is read per session, so it stays set; every
 * `bash` child inherits it, which is harmless. `__tests__/agent-host.test.ts` builds two concurrent
 * threads and goes red if either is passive.
 *
 * ⚠⚠ SECRETS ARE QUARANTINED AT HOST CREATION, before the first session (#89). pi runs in this
 * process and every `bash` child inherits this process's environment, which bun's `.env` autoload
 * fills. `quarantineSecrets` deletes every secret-shaped name and every name the secrets file
 * defines. The extensions that need a key read `.enso/secrets.env` directly (`readSecret`) — see
 * `@enso/core`'s secrets.ts for why the root `.env` is the wrong place.
 */

const log = ensoLogger('host')

export interface AgentHostOptions {
  /**
   * Which directories this host may run a session in and serve stored sessions from — the
   * server's projects (#395). REQUIRED, never defaulted: with no sandbox (#24) a session's
   * directory is its blast radius, and "every directory" must not be what forgetting it means.
   * A stored session whose own directory fails it is not listed, not read, and not resumed.
   */
  servesDirectory: (directory: string) => boolean
  /** Scratch config dir — the operator's own packages and credentials stay invisible. */
  agentDir: string
  /** The enso harness pi package directory; loaded as the ONLY extension source. */
  harnessPackageDir: string
  /**
   * The permission policy file (`ENSO_HOME/permissions.json`, #446, #496) — see the module header.
   * REQUIRED, never defaulted: forgetting it would run the engine on whatever its own config path
   * held, not the user's policy.
   */
  permissionRulesPath: string
  /**
   * The project folders (`ENSO_HOME/projects`, #552): a thread's session is filed under its
   * project's `sessions/` — `projectSessionsDir(projectsDir, projectIdOf(cwd))` — whatever cwd it
   * runs in, and every project's folder is listed beside pi's own session directories. Absent, pi
   * files sessions where it does by default (`<agentDir>/sessions/<encoded-cwd>/`): tests, and a
   * launcher that has not set a home.
   */
  projectsDir?: string
  /**
   * Each new thread's own tree (#551), per project, and how it is prepared (#754): resolved by tier
   * from these — the user's config — and the project's own files once it is trusted, fresh for each
   * new tree (`resolveProjectThreadSettings`). `'worktree'` — a worktree of the checkout under
   * `ENSO_HOME/projects/<id>/trees/`, on its own branch, at the checkout's current state — or
   * `'copy'` (also what a project that is no repository's top level gets); `'off'`, or no source at
   * all, runs threads in the checkout itself, as before #551: tests, and a launcher without a home.
   * Needs `projectsDir`. A thread already on a tree stays on it whatever this says.
   */
  threadSettings?: ProjectThreadSettingsSource
  /**
   * The environment the secrets quarantine (#89) scrubs — `process.env` in production, the
   * one pi and every `bash` child inherit. A seam so the quarantine is testable without a
   * test ever touching `process.env` (the repo's rule for tests). The agent-dir pin is not
   * on this seam: it is a process fact pi-multi-account reads at import.
   */
  environment?: Record<string, string | undefined>
  /**
   * Test seam: inline extensions loaded BESIDE the harness. A test can register a probe that
   * asks a dialog on `session_start`, or throws there, and observe what the host does — with
   * no model, no key, no network. Never set in production.
   */
  extensionFactories?: HostedThreadHost['extensionFactories']
}

/**
 * The host will not run this thread where it would have to: its stored session, or its new one,
 * is in a directory the server does not serve (#395). A refusal the server decided — never a
 * fault — so the routes answer it with its reason rather than as a failed request.
 */
export class SessionDirectoryRefused extends Error {
  override readonly name = 'SessionDirectoryRefused'
}

export interface AgentHost {
  /**
   * A session for this thread, with its own services, extensions bound, events flowing.
   *
   * ⚠ THE THREAD ID IS PI'S SESSION ID (#95). A session file already under that id is
   * OPENED, in the directory its header records — the thread idled out, or the server
   * restarted, and the user came back; otherwise a fresh session is CREATED with the id in
   * `newSessionDirectory`. So resume needs no id mapping and no index file: pi's own listing is
   * the one source, and a page-owned thread finds its own file again across a server restart.
   * Either directory must pass `servesDirectory`, or nothing is built: `SessionDirectoryRefused`.
   *
   * `newSessionDirectory` is asked only when there is no session file under the id (PR #399
   * review). A thread that has one never depends on where a NEW thread would go: a project it
   * was once named for can be removed, or its directory deleted, and it still resumes.
   */
  createSession(threadId: string, newSessionDirectory: () => string): Promise<HostedThread>
  /** pi's session files in the directories this host serves, newest first — the resumable listing. */
  listSessions(): Promise<StoredThread[]>
  /**
   * The directory of the session file under this id — WHETHER OR NOT this host serves it —
   * `undefined` when there is no file. What lets a reader tell "a thread that was never stored"
   * from "a thread whose project is gone": `readStoredThread` answers `undefined`
   * for both.
   */
  storedThreadDirectory(threadId: string): Promise<string | undefined>
  /**
   * A stored session, read-only — no pi session is built, nothing is written (#86's rule:
   * looking must not build): its branch as the transcript of ours, and pi's totals over the
   * whole file (#45). `undefined` when no file has that id.
   */
  readStoredThread(threadId: string): Promise<StoredThreadRead | undefined>
  /**
   * A stored thread analysed (#45 phase 2) — pi's totals over the whole file and the branch's
   * per-turn stats, from one open, building nothing (#86). `undefined` when no file has that id.
   */
  readStoredThreadStats(threadId: string): Promise<StoredThreadStats | undefined>
  /** A stored thread's context, request by request (#361) — one open, nothing built (#86). */
  readStoredThreadContext(threadId: string): Promise<StoredThreadContext | undefined>
  /** One request of a stored thread, element by element (#361 phase 3); undefined for no file or no such turn. */
  readStoredRequestDetail(threadId: string, request: number | 'next'): Promise<BranchRequestDetail | undefined>
  /**
   * A stored thread's fork point (#435): identity and run conditions off its branch, one open,
   * nothing built (#86); undefined for no file in a served project.
   */
  readStoredForkPoint(threadId: string): Promise<EnsoForkPoint | undefined>
  /** A stored thread as the session eval reads it (#441): one open, nothing built (#86); undefined for no file. */
  readStoredThreadEval(threadId: string): Promise<BranchEval | undefined>
  /** A stored thread's incident history (#468): one open, nothing built (#86); undefined for no file. */
  readStoredIncidentHistory(
    threadId: string,
    thresholds: EnsoRiskThresholds,
  ): Promise<BranchIncidentHistory | undefined>
  /** A stored thread's judge cases (#469): one open, nothing built (#86); undefined for no file. */
  readStoredJudgeCases(threadId: string, thresholds: EnsoRiskThresholds): Promise<BranchJudgeCases | undefined>
  /**
   * Whether the id is a deleted thread's (#571): deleted since this host started. Such an id is
   * never given to a new thread; the history route answers it 410.
   */
  threadDeleted(threadId: string): boolean
  /**
   * Fork a stored thread at one of its user messages, as pi's `/fork` does (#433; the module
   * header): a new session file naming the source as its parent, holding everything before that
   * message, and the message's text to prefill with. The source's file is not written; nothing is
   * built for either thread (#86).
   */
  forkThread(threadId: string, entryId: string): Promise<ThreadForkOutcome>
  /** Restore the thread's tree to the snapshot recorded at or before `entryId` (#551); the conversation is unchanged. */
  restoreThreadAt(threadId: string, entryId: string): Promise<ThreadRestoreOutcome>
  /** Undo the thread's last restore (#565): its tree back to that restore's safety snapshot, itself recorded as a restore. */
  undoLastRestore(threadId: string, safety: string): Promise<ThreadRestoreOutcome>
  /** Name the thread (#670) — pi's `session_info`, live or stored; the first prompt stays its title otherwise. */
  renameThread(threadId: string, name: string): Promise<ThreadRenameOutcome>
  /**
   * The thread's tree and its snapshot store (#650), live or stored — one open, nothing built
   * (#86); `undefined` for a thread in its checkout, no session in a served project, or a host
   * with no projects folder.
   */
  threadTree(threadId: string): Promise<ThreadTreePlace | undefined>
  /**
   * A copy's files changed since its `base` (#650), read from its store under the host's
   * environment and writing nothing (`readCopyChanges`); throws when the store cannot be read.
   */
  readCopyChanges(copy: ThreadTreePlace): Promise<{ files: EnsoGitFileChange[]; truncated: boolean }>
  /**
   * Delete the thread (#571): its tree through the inventory, its store — the project's object
   * store then collected, its forks' histories kept (#573) — then every session file under its id.
   * A tree holding work is deleted only `force`d AND with `confirmedWork` the sha256 (hex) of the
   * work's words as the user was shown them: work gained since is refused, named,
   * never taken unseen. `retire` disposes the live session and refuses a busy one: the registry's,
   * which the host does not hold. Hard: nothing is kept to undo it.
   */
  deleteThread(
    threadId: string,
    options: {
      readonly force: boolean
      readonly confirmedWork?: string | undefined
      readonly retire: () => boolean
    },
  ): Promise<ThreadDeleteOutcome>
  /**
   * What deleting the thread would do (#571), deleting nothing and taking no snapshot: its tree,
   * the work in it a delete is refused for, and the forks whose histories keep its snapshots up to
   * where each forked — the delete dialog's text.
   */
  previewThreadDelete(
    threadId: string,
  ): Promise<
    | { readonly kind: 'preview'; readonly preview: EnsoThreadDeletePreview }
    | { readonly kind: 'no-thread'; readonly reason: string }
  >
  /**
   * What thread trees cost on disk (#578), per project this host serves a thread of: each tree —
   * the thread whose branch records it, or none — with its size and the work it holds, and the
   * project's snapshot object store. Reads only; every size under one time cap.
   */
  listTrees(): Promise<EnsoTreesListing>
  /** Whether a NEW thread in `project` gets a tree of its own (#551): a projects folder, and trees not `off` for it. */
  mintsTreesIn(project: string): boolean
  /** What a fresh thread starts in — served before any run exists, so the header never guesses. */
  freshPermissionMode(): EnsoPermissionModeState
  /** A stored thread's state from its transcript alone: nothing is built to answer (#86, #95). */
  storedPermissionMode(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState
  /**
   * The host rows a thread with no session can be offered (#484): `/model` with every model a
   * session would offer — the latest bound session's list, else a probe session's, built once per
   * process and never a thread (#688: extensions register models on `session_start`, so the agent
   * dir's files alone list models a session refuses) — then `/login`, and `/logout` when something
   * is stored, read from pi's own auth and models files in the agent dir. NO THREAD IS BUILT (#86).
   * No `value` (a thread with no session has no current model), no `/thinking` (its levels are the
   * chosen model's, carried on each `/model` option), and none of a session's rows: `/compact`, the
   * views, pi's extension commands. Read afresh per call, so a login through one thread shows at once.
   */
  catalogue(): Promise<RuntimeCommand[]>
  /**
   * The project a session built for `branch` in `cwd` would answer to, and whether it would read
   * that project's own configuration (#470): the decision a build makes first (`hostedProjectTrust`,
   * keyed as the build keys it, #551), asked without building — so the Start dialog lists a
   * project's prompts for a thread nothing has built yet (#484's rule, #86).
   */
  projectTrust(cwd: string, branch: readonly EnsoTranscriptEntry[]): ProjectTrustState
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { agentDir, harnessPackageDir, servesDirectory, projectsDir } = options
  /** The models a thread with no session is offered (#688): a bound session's list — see the module. */
  const catalogueModels = sessionModels({
    agentDir,
    harnessPackageDir,
    extensionFactories: options.extensionFactories ?? [],
    // The probe is no thread: no session file.
    inMemorySession: () => probeLog(agentDir),
  })
  /** Where a thread in `cwd` is filed (#552): its project's `sessions/` — the checkout's or a tree's; pi's default when no projects folder is set. */
  const sessionDirFor = (cwd: string): string | undefined =>
    projectsDir === undefined ? undefined : sessionDirectoryFor(projectsDir, cwd)

  // Order matters, and it is the module header's ⚠⚠ items: env before any pi module can
  // be imported by the loader, the proxy pin and the independent-roots switch before the first
  // session_start, and the secrets out of the environment before anything can inherit it (#89).
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS = '1'
  // This host decides project trust (#502), so the harness's own `.enso/config.json` question follows
  // pi's answer instead of asking a second time (`harness/core/session-config.ts`, which reads it by
  // `@enso/core`'s `ENSO_PROJECT_TRUST_BY_HOST`). Written literally, as the environment inventory reads.
  process.env.ENSO_PROJECT_TRUST_BY_HOST = '1'
  // The projects folder this host files trees and stores under (#586): the run-context extension
  // snapshots each run into the store there, so the host is the path's one owner. Re-deriving it
  // from ENSO_HOME agreed only while every launcher passed that home's folder; apart, turn 2's
  // snapshot went to a second store and a fork at it failed. Cleared for a host with no folder,
  // so an earlier host's never stands. Written literally, as the environment inventory reads.
  if (projectsDir === undefined) delete process.env.ENSO_PROJECTS_DIR
  else process.env.ENSO_PROJECTS_DIR = projectsDir
  seedMultiAccountConfig(agentDir)
  // The policy the permission engine reads when it loads, before the first services exist (#446,
  // #496). An unreadable file refuses to start the host rather than run under a policy nobody wrote.
  const permissionPolicy = preparePermissionPolicy(options.permissionRulesPath, agentDir)
  if (permissionPolicy.kind === 'unreadable') {
    throw new Error(
      `${permissionPolicy.path} is unreadable (${permissionPolicy.reason}); fix it or remove it — a removed file is seeded with Enso's default policy (#446)`,
    )
  }
  log.info(describePermissionPolicy(permissionPolicy))
  // The secrets file is the USER's (`ENSO_HOME`, #421), and the root `.env` bun autoloads is THIS
  // checkout's — neither is about the trees pi operates in (a session may run anywhere, a tmpdir
  // in tests). Both resolve from the environment and the harness, never from a session's cwd.
  const environment = options.environment ?? process.env
  const quarantine = quarantineSecrets(environment, {
    repoRoot: findRepoRoot(import.meta.url),
    home: ensoHome(environment),
  })
  if (quarantine.removed.length > 0) {
    log.info('secrets kept out of the tool environment (#89): {removed}', { removed: quarantine.removed })
  }

  /**
   * The log of each thread built here (#551): the one writer of that thread's file (control plane,
   * invariant 4). A restore appends its record through it, never through a second log opened beside
   * it on the same file.
   */
  const liveLogs = new Map<string, ThreadLog>()

  /** Threads whose tree a restore is putting back right now: no run is admitted on one (`admitRun`). */
  const restoringTrees = new Set<string>()

  /**
   * Threads a delete holds right now (#571): no run is admitted (`admitRun`), no session is built
   * (`createSession`), no fork is taken of one; and the ids deleted since the server started, which
   * stay refused — a page still showing one would otherwise prompt a NEW thread into being under it.
   */
  const deletingThreads = new Set<string>()

  const deletedThreads = new Set<string>()

  // The host's flows over its state (#801): each reads the host through what it is handed, and nothing
  // below names the runtime's log — they read and write a thread's log through `ThreadLog`.
  const {
    listSessions,
    locate,
    storedSession,
    readStoredThread,
    readStoredThreadStats,
    readStoredThreadContext,
    readStoredRequestDetail,
    readStoredForkPoint,
    readStoredThreadEval,
    readStoredIncidentHistory,
    judgeCaseInputs,
    readStoredJudgeCases,
    sessionFilesOf,
  } = createStoredThreads({ projectsDir, servesDirectory, environment })
  const { treeKindOf, mintTree, logOnTree, recordTree, prepareTreeOnTrust, storeOf } = createTreeMaking({
    projectsDir,
    agentDir,
    environment,
    threadSettings: options.threadSettings,
  })
  const { forkThread } = createThreadFork({
    projectsDir,
    deletingThreads,
    deletedThreads,
    storedSession,
    treeKindOf,
    mintTree,
    recordTree,
    storeOf,
  })
  const { renameThread, threadTree, restoreThreadAt, undoLastRestore } = createThreadLogEdits({
    environment,
    liveLogs,
    restoringTrees,
    storedSession,
    storeOf,
  })
  const { threadDeleted, deleteThread, previewThreadDelete, listTrees } = createThreadDelete({
    projectsDir,
    environment,
    deletingThreads,
    deletedThreads,
    restoringTrees,
    storedSession,
    sessionFilesOf,
    listSessions,
    storeOf,
  })

  if (quarantine.misplaced.length > 0) {
    log.warn(
      'the root .env defines {misplaced} — bun autoloads .env into every bun child, so a tool can still read it there. Move it to {secretsFile} (#89); it is not read from .env',
      { misplaced: quarantine.misplaced, secretsFile: ensoSecretsPath(ensoHome(environment)) },
    )
  }
  prepareRuntimeTheme()

  /** A live thread built on `threadLog` (`hosted-thread.ts`), over this host's state. */
  const buildHosted = (threadId: string, threadLog: ThreadLog): Promise<HostedThread> =>
    buildHostedThread(threadId, threadLog, {
      agentDir,
      harnessPackageDir,
      extensionFactories: options.extensionFactories ?? [],
      catalogueModels,
      liveLogs,
      deletingThreads,
      deletedThreads,
      restoringTrees,
      judgeCaseInputs,
      locate,
      prepareTreeOnTrust,
    })

  async function createSession(threadId: string, newSessionDirectory: () => string): Promise<HostedThread> {
    // Resolved BEFORE the services so a bad id fails before anything is built. A file under this
    // id decides the directory — pi fixed it at creation — and one this host does not serve is a
    // refusal, never a fresh session beside it under the same id. Only a thread with no file asks
    // where a new one goes, so a stale answer to that question cannot block a resume.
    // A deleted id is never built again (#571), across a restart too: its store,
    // kept for its forks, would otherwise be adopted by the new thread and swept from under it).
    if (deletingThreads.has(threadId) || threadDeleted(threadId)) {
      throw new ThreadDeleted(`thread ${threadId} is deleted, or being deleted`)
    }
    const located = await locate(threadId)
    const directory = located?.cwd ?? newSessionDirectory()
    if (!servesDirectory(directory)) {
      throw new SessionDirectoryRefused(
        `thread ${threadId}: ${directory} is not a project this server runs sessions in`,
      )
    }
    // @invariant resume/one-id One id, end to end: a file under the thread's id is OPENED, none means one is created under it.
    // `locate` resolves the id through the same listing `readStoredThread` uses (#95), so the file this later flushes
    // is found next time, and the browser adopts under the history's `threadId` (`thread-stores.ts#adoptThread`). The
    // file sits under the agent dir pi resolves from the env the host set, where `pi --mode rpc` put it, so the mode's
    // `active_agent` entries and the transcript land where the TUI's would; `permissionModeState()` below walks them.
    if (located !== undefined) return fencedFromDelete(threadId, await buildHosted(threadId, openLog(located.path)))
    const created = createLog(threadId, directory, sessionDirFor(directory))
    const hosted = fencedFromDelete(threadId, await buildHosted(threadId, created))
    // A new thread whose project gives threads a tree (#551) is built in the checkout and gets its
    // tree at its first RUN, not here (#561): a thread only built — a preview looked at, a permission
    // checked, a model chosen — leaves no worktree, branch or file behind.
    if (treeKindOf(directory) === undefined) return hosted
    return treeOnFirstRun(hosted, {
      threadId,
      project: directory,
      checkout: created,
      liveLogs,
      environment,
      mintTree,
      logOnTree,
      storeOf,
      buildHosted,
    })
  }

  /**
   * A build that finished after its thread was deleted, or while it was: the check
   * at `createSession`'s top runs before its awaits, and the registry's `retire` cannot see a build
   * under way — so the build is disposed here, before anything can run on it or write its file again.
   */
  function fencedFromDelete(threadId: string, hosted: HostedThread): HostedThread {
    if (!deletingThreads.has(threadId) && !deletedThreads.has(threadId)) return hosted
    hosted.runtime.dispose()
    throw new ThreadDeleted(`thread ${threadId} was deleted while it was being built`)
  }

  return {
    createSession,
    listSessions,
    storedThreadDirectory: async (threadId: string) => (await locate(threadId))?.cwd,
    readStoredThread,
    readStoredThreadStats,
    readStoredThreadContext,
    readStoredThreadEval,
    readStoredIncidentHistory,
    readStoredJudgeCases,
    readStoredRequestDetail,
    readStoredForkPoint,
    forkThread,
    restoreThreadAt,
    undoLastRestore,
    renameThread,
    threadTree,
    readCopyChanges: ({ record, store }) =>
      readCopyChanges({ directory: store, tree: record.path, base: record.base, environment }),
    deleteThread,
    threadDeleted,
    previewThreadDelete,
    listTrees,
    mintsTreesIn: (project: string) => treeKindOf(project) !== undefined,
    freshPermissionMode: freshPermissionModeState,
    storedPermissionMode: storedPermissionModeState,
    catalogue: () => catalogueOf(agentDir, catalogueModels),
    projectTrust(cwd: string, branch: readonly EnsoTranscriptEntry[]): ProjectTrustState {
      // Keyed as `buildHosted` keys it: a thread on a tree (#551) answers to its checkout.
      const directory = treeRecordOf(branch)?.project ?? cwd
      return {
        directory,
        trusted: hostedProjectTrust(cwd, directory, agentDir, branch).settingsManager.isProjectTrusted(),
      }
    },
  }
}
