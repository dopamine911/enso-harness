/**
 * The models a thread with no session is offered (#688): a SESSION's list, never a bare runtime's.
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
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  type CreateAgentSessionFromServicesOptions,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type InlineExtension,
  type LoadExtensionsResult,
  type ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { ensoLogger } from '@enso/core'

const log = ensoLogger('host')

interface SessionModels {
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
  /** The probe's session store, in memory — made by `agent-host.ts`, the storage seam (#102). */
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
      const runtime = bound ?? (await (probe ??= probeRuntime(options)))
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
        // A thread's loader options (`buildHosted`), narrowed to the provider extensions.
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
