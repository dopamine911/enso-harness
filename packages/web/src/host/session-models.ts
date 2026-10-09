/**
 * The models a thread with no session is offered (#688): a SESSION's list, never a bare runtime's.
 * Beside it, the other readings of pi's model runtime: the catalogue's rows over the agent dir and
 * that list (`catalogueOf`, #811), the `/login` facts per provider, and the model a thread chose
 * before its first message.
 *
 * The catalogue (#484) serves the Start dialog without building the thread, and it used to read
 * pi's model runtime over the agent dir alone — "what a session builds, minus the session". It is
 * not: a session's runtime also holds what its extensions register, and they register on
 * `session_start` too. pi-multi-account replaces `openai-codex`'s list with the account's live
 * Codex catalog there (`syncCodexModelCatalog` → `registerCodexCatalog` → `pi.registerProvider`).
 * Measured in the arena (#688): the bare list offered gpt-5.5 and gpt-5.3-codex-spark, the
 * session's had neither, and `…/configure` refused the dialog's own default with a 422.
 *
 * So the list is a bound session's runtime. The latest thread bound, once there is one — its
 * extensions keep it current. Before that, a PROBE: one pi session per process, built on the
 * first read and released as soon as `session_start` has run. It is not a thread: an in-memory
 * session manager (no session file), in-memory settings (pi writes no default model), no UI.
 * Every harness extension loads, as for a thread, but its `session_start` reaches only the ones
 * that register a provider as they load (`providerExtensionsOnly`; today pi-multi-account alone)
 * — the logging, guard and permission extensions never start in it.
 * pi-multi-account's own start writes what any session's start writes (its catalog snapshot,
 * its cooldown and continuation state) and remembers no model: the session manager has a
 * branch, so the host owns the model (`rememberUserModel`). The probe only runs while no
 * session has been bound in this process, so it is that first session's start, earlier.
 *
 * Every read refreshes the runtime from the agent dir without the network — the work
 * `ModelRuntime.create` did per read before — so a login through any thread shows at once. What
 * goes wrong in the probe is said in the log, once, as it is built once: an extension that did not
 * load or threw on `session_start`, or a probe that could not be built at all — and then the
 * caller falls back to the agent dir's list: a broken probe is never an empty model picker.
 */
import { join } from 'node:path'
import { type Api, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai'
import {
  type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type InlineExtension,
  type LoadExtensionsResult,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { ensoLogger, type RuntimeCommand } from '@enso/core'
import { catalogueRows } from './host-commands.ts'
import { hostFlowRows, type LoginProviderFacts, loginOptions, logoutOptions } from './host-flows.ts'
import type { ChoiceBeforeFirstMessage } from './thread-log.ts'

const log = ensoLogger('host')

/** The models a thread with no session is offered (#688): each bound session's list, else a probe's. */
export interface SessionModels {
  /** A thread's session was bound: its runtime is the list from now on. */
  adopt(runtime: ModelRuntime): void
  /** What a session offers now — undefined only when no session could be had. */
  available(): Promise<readonly Model<Api>[] | undefined>
}

interface SessionModelsOptions {
  readonly agentDir: string
  readonly harnessPackageDir: string
  /** The host's extra extensions, as a thread loads them — a test's provider among them. */
  readonly extensionFactories: readonly InlineExtension[]
  /** The probe's session store, in memory — made by `thread-log.ts`, the storage seam (#102, #801). */
  readonly inMemorySession: () => CreateAgentSessionFromServicesOptions['sessionManager']
}

export function sessionModels(options: SessionModelsOptions): SessionModels {
  let bound: ModelRuntime | undefined
  let probe: Promise<ModelRuntime | undefined> | undefined
  return {
    adopt(runtime: ModelRuntime): void {
      bound = runtime
    },
    async available(): Promise<readonly Model<Api>[] | undefined> {
      const probed = bound === undefined ? await (probe ??= probeRuntime(options)) : undefined
      // Read `bound` again: a thread bound while the probe was starting is the newer list (PR #701 review).
      const runtime = bound ?? probed
      if (runtime === undefined) return undefined
      await runtime.refresh({ allowNetwork: false })
      return runtime.getAvailableSnapshot()
    },
  }
}

/**
 * Only the extensions that registered a provider, native provider or virtual model while loading
 * — the ones a session's model list is made of. pi records each registration with the path of
 * the extension that made it, which is the path the loaded extension carries.
 */
function providerExtensionsOnly(loaded: LoadExtensionsResult): LoadExtensionsResult {
  const { runtime } = loaded
  const registering = new Set([
    ...runtime.pendingProviderRegistrations.map((registration) => registration.extensionPath),
    ...runtime.pendingNativeProviderRegistrations.map((registration) => registration.extensionPath),
    ...runtime.pendingVirtualModelRegistrations.map((registration) => registration.extensionPath),
  ])
  return { ...loaded, extensions: loaded.extensions.filter((extension) => registering.has(extension.path)) }
}

async function probeRuntime(options: SessionModelsOptions): Promise<ModelRuntime | undefined> {
  try {
    const services = await createAgentSessionServices({
      cwd: options.agentDir,
      agentDir: options.agentDir,
      settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        // A thread's loader options (`hosted-thread.ts#buildHostedThread`), narrowed to the provider extensions.
        noExtensions: true,
        noSkills: true,
        additionalExtensionPaths: [options.harnessPackageDir],
        extensionFactories: [...options.extensionFactories],
        extensionsOverride: providerExtensionsOnly,
      },
    })
    // A probe that loads without an extension lists models without it: said, as a thread says it.
    for (const loadError of services.resourceLoader.getExtensions().errors) {
      log.warn('model probe: extension failed to load: {path}: {error}', { ...loadError })
    }
    const { session } = await createAgentSessionFromServices({ services, sessionManager: options.inMemorySession() })
    try {
      await session.bindExtensions({
        onError: (error) => log.warn('model probe: {extensionPath} failed on {event}: {error}', { ...error }),
      })
      return session.modelRuntime
    } finally {
      // As a thread's dispose does: pi's own `dispose` does not emit session_shutdown, and
      // multi-account stops its timers on it.
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }).finally(() => session.dispose())
    }
  } catch (error) {
    log.warn("model probe failed: {error}; the Start dialog lists the agent dir's models alone (#688)", { error })
    return undefined
  }
}

/**
 * The `/login` facts pi's model runtime knows about each provider — a session's, or the
 * catalogue's over the agent dir alone (#484); one reading, so the two lists cannot drift.
 */
export function loginFactsOf(modelRuntime: ModelRuntime): LoginProviderFacts[] {
  return modelRuntime.getProviders().map((provider) => {
    const status = modelRuntime.getProviderAuthStatus(provider.id)
    return {
      id: provider.id,
      name: provider.name,
      offersOAuth: provider.auth.oauth !== undefined,
      offersApiKeyLogin: provider.auth.apiKey?.login !== undefined,
      configuredVia: status.configured ? (status.label ?? status.source) : undefined,
    }
  })
}

/**
 * The catalogue's rows (#484). The logins and stored credentials are read from pi's runtime over
 * the agent dir alone (`sdk.js`: `ModelRuntime.create({ authPath, modelsPath })`); the MODELS are
 * a bound session's (#688), the agent dir's alone only when no session could be had.
 */
export async function catalogueOf(agentDir: string, models: SessionModels): Promise<RuntimeCommand[]> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  })
  const providerNameOf = (providerId: string): string => modelRuntime.getProvider(providerId)?.name ?? providerId
  const credentials = await modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) })
  const login = loginOptions(loginFactsOf(modelRuntime))
  const logout = logoutOptions(
    credentials.map((credential) => ({
      providerId: credential.providerId,
      providerName: providerNameOf(credential.providerId),
      type: credential.type,
    })),
  )
  const offered = (await models.available()) ?? modelRuntime.getAvailableSnapshot()
  return catalogueRows(
    offered,
    getSupportedThinkingLevels,
    hostFlowRows(login, logout),
    configuredDefaultModel(agentDir),
  )
}

/**
 * The model pi starts a session on when none is chosen: the agent dir's `defaultProvider` and
 * `defaultModel` (#674), as `provider/id`. Global settings only — a project's are read only once
 * it is trusted, and the catalogue serves threads of every project.
 */
function configuredDefaultModel(agentDir: string): string | undefined {
  // The cwd argument only locates PROJECT settings, which an untrusted manager never reads:
  // the agent dir stands in for it, so only the global `settings.json` is read.
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false })
  const provider = settings.getDefaultProvider()
  const model = settings.getDefaultModel()
  return provider === undefined || model === undefined ? undefined : `${provider}/${model}`
}

/**
 * The model and effort a thread chose BEFORE its first message (#616), for its next build.
 *
 * ⚠ pi restores a session's model and thinking level only when the session has messages
 * (`createAgentSession`: `hasExistingSession` is `messages.length > 0`); otherwise it takes the
 * settings' default and records it. Since #484 a thread is configured before its first prompt — the
 * Start dialog's model and effort are `model_change` and `thinking_level_change` entries on a branch
 * with no message yet — and its first run REBUILDS it on its tree (#551, `treeOnFirstRun`), which
 * would take the default over the choice. A branch with messages is pi's to restore and is left to
 * it. A recorded model that is gone or has no credentials falls back to pi's default, as pi's own
 * restore does.
 */
export function selectionBeforeFirstMessage(
  chosen: ChoiceBeforeFirstMessage | undefined,
  modelRuntime: AgentSessionServices['modelRuntime'],
): Pick<CreateAgentSessionFromServicesOptions, 'model' | 'thinkingLevel'> {
  const recorded = chosen === undefined ? undefined : modelRuntime.getModel(chosen.provider, chosen.modelId)
  const model = recorded !== undefined && modelRuntime.hasConfiguredAuth(recorded.provider) ? recorded : undefined
  if (model === undefined) return {}
  // The lookup is how the recorded string becomes pi's level without a cast, as `runHostCommand`
  // does it — and a level this model does not offer is not restored.
  const level = chosen?.thinkingLevel
  const thinkingLevel =
    level === undefined ? undefined : getSupportedThinkingLevels(model).find((offered) => offered === level)
  return { model, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) }
}
