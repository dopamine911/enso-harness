import {
  type ExtensionAPI,
  type ExtensionContext,
  ProjectTrustStore,
  SettingsManager,
  type ToolCallEventResult,
  type ToolResultEvent,
  type TruncationResult,
  VERSION,
} from '@earendil-works/pi-coding-agent'
import {
  type CommandJudge,
  ENSO_JUDGE_KEY_NAME,
  type EnsoIncidentPolicy,
  ensoLogger,
  piVersionSupported,
  transcriptOf,
  unsupportedPiVersionReason,
} from '@enso/core'
import { checkoutOrInstalledRoot, ensoHome, ensoLogsDir, ensoProjectsDir, HARNESS_PACKAGE_NAME } from '@enso/core/paths'
import { knownSecretValuesTracking, readSecret } from '@enso/core/secrets'
import { PERMISSIONS_DECISION_CHANNEL } from '@gotgenes/pi-permission-system'
import { type CheckCommandResult, checkCommand } from 'cc-safety-net/api'
import {
  createGuardSession,
  decidedProjectTrust,
  type GuardProject,
  type GuardSession,
  inputRecordOf,
  type ShellAnalyzerDenial,
  sessionConfigEnvironment,
  sessionIncidentPolicy,
  userJudgeConfig,
} from '../../core/index.ts'
import { createJevJudge, createLocalJudge } from './judge-backends.ts'

/**
 * Tier 0 guards — see `docs/concepts/pi-immediate-needs.md`. The policy, its decision and the
 * session's security are runtime free (#861: `core/guard-session.ts`, whose header states what the
 * guard covers); this file is pi's glue over them: pi's events in, pi's verdict shape out.
 *
 * WHY A `tool_call` HANDLER RATHER THAN A TOOL OVERRIDE
 * pi resolves tools first-wins (`registerTool` -> `getAllRegisteredTools`), so a guard
 * implemented as an override of `write` is only safe while this package loads first.
 * Handlers are additive instead — `on()` pushes onto a list, every extension's handlers
 * run, and `emitToolCall` returns immediately on the first `block`. So a block here is
 * final and cannot be un-blocked by a later extension, whatever the load order.
 */

const log = ensoLogger('extension', 'guards')

/**
 * Whether a successful `read` returned the WHOLE file (#57 S2) — the knowledge a whole-file
 * `write` needs. pi's `read` returns part of a file three ways: its own line/byte cut
 * (`details.truncation`, pi's `TruncationResult`, whose `truncated` is set whenever it cut —
 * including a first line over the byte limit, of which it returns nothing), an `offset` past the
 * first line, and a `limit` — which pi reports only in the text, so ANY limit counts as partial.
 * That errs toward "read it again without a limit", never toward a write over lines the session
 * did not see.
 *
 * `truncation` is read as pi's own type, not a shape written here: a rename in
 * pi fails the typecheck. `Partial`, because `details` arrives untyped.
 */
function returnedWholeFile(event: ToolResultEvent): boolean {
  const input = inputRecordOf(event.input)
  if (typeof input.offset === 'number' && input.offset > 1) return false
  if (input.limit !== undefined) return false
  const details: unknown = event.details
  if (typeof details !== 'object' || details === null || !('truncation' in details)) return true
  const truncation = details.truncation as Partial<TruncationResult> | undefined
  return truncation?.truncated !== true
}

/**
 * The guard's seams: the bash analyzer (#9), the harness root (#160 §4), the incident policy
 * and log directory (#466), the projects directory thread trees are minted in (#615), the
 * command judge with the secret values its state is redacted of (#469), and the version of the
 * pi it runs in (#953).
 *
 * Production wires cc-safety-net's `checkCommand`, this checkout's root, an incident policy from the
 * user's `config.json`, pi's trust store and the project's approved `.enso/config.json`
 * (`sessionIncidentPolicy`), `ENSO_HOME`'s log and projects directories and secrets, and pi's own
 * `VERSION`; tests inject known verdicts, a root they built, a policy, directories, a fake judge and a
 * version — a guard test must never reach the network.
 * `checkCommand` reads LOCAL policy per call, so a guard test that touched the real
 * library would vary with the machine's cc-safety-net config (the contract test alone exercises
 * the real one, and pins defaults explicitly) — and the same holds for the machine's config files.
 */
export interface GuardDependencies {
  analyzeBashCommand: (input: { command: string; cwd: string }) => CheckCommandResult
  /**
   * The harness's own root — one of the places a search over a directory above it is refused for
   * when it holds a credential location (#160 §4, `CredentialPlaces`). Since #421 its `.enso/` is
   * migrated into `ENSO_HOME` (in home, so always a place); what the migration leaves behind — a
   * login `ENSO_HOME` already had — is still here, and still refused. Installed rather than checked
   * out (#950), it is the harness package's own directory: there is no checkout, and so no `.enso/`.
   */
  harnessRoot: string
  /**
   * Whether an incident halts, and the risk thresholds, for the session's project — read at every
   * `session_start` (#466): the user's, tightened by the project's approved tier once trusted (#753).
   */
  incidentPolicy: (project: GuardProject | undefined) => EnsoIncidentPolicy
  /** The log directory `protected-records` refuses a shell command naming (#466). */
  logsDirectory: string
  /**
   * Where thread trees are minted, `ENSO_HOME/projects` (#551): a session whose cwd is a tree there
   * has its own files judged relative to the tree, not as the harness's own directory (#615).
   */
  projectsDirectory: string
  /**
   * The command judge, or undefined when `security.judge.backend` is `off` (the default) — read at
   * every `session_start`, as the incident policy is (#469).
   */
  commandJudge: () => CommandJudge | undefined
  /** The known secret values a judge state is redacted of before it leaves (#469), read per judged call. */
  judgeSecretValues: () => readonly string[]
  /**
   * The version of the pi this extension is running in (#953): pi's own `VERSION`, which pi's
   * extension loader hands the host's copy of (it maps `@earendil-works/pi-coding-agent` to the
   * running pi's `index.js`, in every resolution mode). Outside `SUPPORTED_PI_VERSIONS`, the floor
   * refuses every tool call.
   */
  runningPiVersion: string
}

/** Which pi the guard's refusal is about: the one it runs in, as opposed to the launcher's "the `pi` on PATH". */
const RUNNING_PI_SUBJECT = 'the running pi'

/**
 * Why the running pi is refused, or undefined when it is one the guard was pinned against (#953).
 *
 * ⚠ The launcher is not the only way in. `scripts/enso.ts` refuses an unsupported pi before it
 * spawns one, but `pi install npm:<package>` loads the harness into whatever pi the user has and
 * never runs the launcher — so the harness checks the pi it is actually in, against the same range,
 * in the same words. A pi too old to export `VERSION` hands over `undefined`, which reads as no
 * version and is refused: the safe direction.
 */
function runningPiRefusal(runningPiVersion: string): string | undefined {
  return piVersionSupported(runningPiVersion)
    ? undefined
    : unsupportedPiVersionReason(RUNNING_PI_SUBJECT, runningPiVersion)
}

/**
 * Says the version refusal where a person will see it, at session start (#953): every tool call is
 * refused with the reason anyway, but a session that has not called a tool yet would otherwise look
 * armed. Logged always; shown in pi's UI when there is one (a print run has none, and its refusals
 * carry the reason).
 */
function announceVersionRefusal(refusal: string, extensionContext: ExtensionContext): void {
  log.error('every tool call is refused: {refusal}', { refusal })
  if (extensionContext.hasUI) extensionContext.ui.notify(`Enso: every tool call is refused — ${refusal}`, 'error')
}

/**
 * The analyzer's verdict on a bash command, in the guard's words (`ShellAnalyzerDenial`), under
 * cc-safety-net's own contract: "If this function throws, the caller must not execute the
 * command" — so a throw IS a deny. Here because the library may be named only in the glue.
 */
function safetyNetDenial(
  analyzeBashCommand: GuardDependencies['analyzeBashCommand'],
  input: { command: string; cwd: string },
): ShellAnalyzerDenial | undefined {
  let verdict: CheckCommandResult
  try {
    verdict = analyzeBashCommand(input)
  } catch (error) {
    log.error('cc-safety-net checkCommand threw — denying per its contract: {error}', { error })
    verdict = {
      kind: 'deny',
      reason: `the safety analyzer failed (${String(error)}), and its contract is that an unanalyzed command must not run`,
    }
  }
  if (verdict.kind !== 'deny') return undefined
  const ruleId = 'ruleId' in verdict && verdict.ruleId !== undefined ? ` (${verdict.ruleId})` : ''
  return { rule: 'cc-safety-net', reason: `Bash command blocked by cc-safety-net${ruleId}: ${verdict.reason}` }
}

/** The guard session over pi's extension API: the port filled from `appendEntry`, `events` and `getAllTools`. */
function guardSessionOver(pi: ExtensionAPI, dependencies: GuardDependencies): GuardSession {
  const { analyzeBashCommand, runningPiVersion, ...seams } = dependencies
  return createGuardSession(
    {
      name: 'pi',
      append: (customType, data) => pi.appendEntry(customType, data),
      emit: (channel, data) => pi.events.emit(channel, data),
      on: (channel, handler) => {
        pi.events.on(channel, handler)
      },
      toolNames: () => pi.getAllTools().map((tool) => tool.name),
      versionRefusal: () => runningPiRefusal(runningPiVersion),
    },
    { ...seams, analyzeShell: (input) => safetyNetDenial(analyzeBashCommand, input) },
  )
}

/**
 * The guards extension, over its seams. The bash analyzer is a dependency of this one
 * handler, never an extension of its own.
 *
 * @invariant guarded-tool-call/two-participants Two tool_call participants, structurally.
 * The manifest loads guards before the mode extension (`packages/harness/package.json`,
 * `pi.extensions`), and cc-safety-net is a library under this handler, not a participant, so the
 * count stays at two (#4, #9). The tripwire scans every declared extension tree for a `tool_call`
 * registration and asserts set equality with those two. A third is #4's arbiter trigger, and the
 * test says not to add yourself to the list.
 */
export function createGuards(dependencies: GuardDependencies): (pi: ExtensionAPI) => void {
  return function guards(pi: ExtensionAPI): void {
    const session = guardSessionOver(pi, dependencies)
    // The permission engine announces its decisions on pi's bus under its own channel name.
    pi.events.on(PERMISSIONS_DECISION_CHANNEL, (raw: unknown) => session.permissionDecision(raw))

    pi.on('session_start', (_event, extensionContext): void => {
      const refusal = runningPiRefusal(dependencies.runningPiVersion)
      if (refusal !== undefined) announceVersionRefusal(refusal, extensionContext)
      session.start({
        recordDirectory: () => extensionContext.sessionManager.getSessionDir(),
        transcript: () => transcriptOf(extensionContext.sessionManager.getBranch()),
        project: () => ({
          cwd: extensionContext.cwd,
          // pi's own trust store and settings (#509): `harness/core` may not import them.
          trusted:
            decidedProjectTrust({
              ...sessionConfigEnvironment(process.env, { ProjectTrustStore, SettingsManager }),
              cwd: extensionContext.cwd,
              isProjectTrusted: () => extensionContext.isProjectTrusted(),
            }) === true,
        }),
      })
    })

    pi.on('tool_result', (event, extensionContext): void => {
      session.toolResult({
        toolName: event.toolName,
        input: event.input,
        isError: event.isError,
        wholeFile: returnedWholeFile(event),
        cwd: extensionContext.cwd,
      })
    })

    pi.on('tool_call', (event, extensionContext): ToolCallEventResult | undefined => {
      const outcome = session.toolCall({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        cwd: extensionContext.cwd,
        signal: extensionContext.signal,
        model: extensionContext.model?.id,
      })
      if (outcome.kind === 'allowed') {
        // pi runs the call with the input this hook leaves on the event: the patch is written into it.
        if (outcome.patch !== undefined) Object.assign(inputRecordOf(event.input), outcome.patch)
        return undefined
      }
      return outcome.terminate === true
        ? { block: outcome.block, reason: outcome.reason, terminate: true }
        : { block: outcome.block, reason: outcome.reason }
    })
  }
}

/** The session's incident policy; an unreadable config fails closed and says so (#466, #753). */
function productionIncidentPolicy(project: GuardProject | undefined): EnsoIncidentPolicy {
  const { policy, problem } = sessionIncidentPolicy(ensoHome(process.env), project)
  if (problem !== undefined) {
    log.error('a config is unreadable, so incidents halt: {problem}', { problem })
  }
  return policy
}

/**
 * Per attempt, and the live path makes one: a judgement nobody waits for still holds a socket and
 * a session reference until it settles (#469).
 */
const JUDGE_TIMEOUT_MS = 5000

/**
 * Per request for `local` (#532): a llama.cpp model reads the whole state on its first question —
 * measured 23–42 s on this 12-CPU, GPU-less machine with a 0.5B model over 7–11k-token prompts,
 * then ~1 s per question from the prompt cache. Jev's 5 s would leave every local call unjudged.
 * Nobody waits on it (the judge is fire-and-forget), but it still holds a socket until it settles.
 */
const LOCAL_JUDGE_TIMEOUT_MS = 90_000

/**
 * The user's command judge (#469): off unless `security.judge.backend` names one. ⚠ An unreadable
 * `config.json` fails closed, which for the judge is OFF — nothing is sent — and says so.
 */
function productionCommandJudge(): CommandJudge | undefined {
  const home = ensoHome(process.env)
  const config = userJudgeConfig(home)
  if ('problem' in config && config.problem !== undefined) {
    log.error('the command judge is off: {problem}', { problem: config.problem })
  }
  if (config.backend === 'off') return undefined
  if (config.backend === 'local') return createLocalJudge({ ...config.local, timeoutMs: LOCAL_JUDGE_TIMEOUT_MS })
  return createJevJudge({ apiKey: () => readSecret(home, ENSO_JUDGE_KEY_NAME), timeoutMs: JUDGE_TIMEOUT_MS })
}

/** The pi entry point — the real analyzer, this checkout's root (or the installed package's), the user's config and the running pi's version, wired at the composition root. */
export default createGuards({
  analyzeBashCommand: checkCommand,
  // Not the workspace-root walk (#950): an installed harness has no workspace root above it, so
  // that walk throws at load, and the whole guard suite goes with it.
  harnessRoot: checkoutOrInstalledRoot(import.meta.url, HARNESS_PACKAGE_NAME),
  incidentPolicy: productionIncidentPolicy,
  logsDirectory: ensoLogsDir(ensoHome(process.env)),
  projectsDirectory: ensoProjectsDir(ensoHome(process.env)),
  commandJudge: productionCommandJudge,
  // The tracking thunk: one `stat` per judged call, re-read only when secrets.env changes (#207).
  judgeSecretValues: knownSecretValuesTracking(ensoHome(process.env)),
  runningPiVersion: VERSION,
})
