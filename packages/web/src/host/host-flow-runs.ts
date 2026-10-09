import {
  type EnsoHostCommandRun,
  type EnsoLoginInProgress,
  ensoLogger,
  type HostCommandOption,
  type HostFlowOutcome,
  type RuntimeCommand,
} from '@enso/core'
import type { HostInputQuestion } from './extension-ui-context.ts'
import { HostCommandRefused } from './host-commands.ts'
import {
  authEventText,
  compactDoneText,
  decideHostFlow,
  FlowCancelled,
  type HostAuthEvent,
  type HostAuthType,
  type HostFlowDecision,
  hostFlowRows,
  isCompactionRefusal,
  isFlowCancelled,
  type LoginProviderFacts,
  loginCodeQuestion,
  loginDoneText,
  loginOptions,
  logoutDoneText,
  logoutOptions,
  type StoredCredentialFacts,
} from './host-flows.ts'
import type { RuntimeEvent } from './runtime-event.ts'

/**
 * A live thread's host flows run (#338 slices 3–4): `/login`, `/logout` and `/compact`, started and
 * followed on the thread's feed — `host-flows.ts` has the decisions and the words. Over two ports in
 * our words (#801): the thread's accounts with model providers, and its conversation with the person
 * on the page; the runtime behind them is `hosted-thread.ts`'s, and nothing here names it.
 *
 * ⚠ `listCommands` is synchronous and listing the stored credentials is not (the store may be a file),
 * so the stored credentials are a CACHE: read once the thread is built, re-read after every flow the
 * host itself ran. A credential saved by another process shows up at the next build, not before.
 */

const log = ensoLogger('host')

/** A question a provider's login asks (#338 slice 3): the runtime's prompt kinds, in our words. */
export type HostAuthQuestion = { readonly signal?: AbortSignal } & (
  | { readonly type: 'text'; readonly message: string; readonly placeholder?: string }
  | { readonly type: 'secret'; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: 'select'
      readonly message: string
      readonly options: readonly { readonly id: string; readonly label: string }[]
    }
  | { readonly type: 'manual_code'; readonly message: string; readonly placeholder?: string }
)

/** A thread's accounts with model providers (#801): what its flows log into and out of. */
export interface ProviderAccounts {
  /** A provider's name as a reader knows it; its id when the runtime knows no name. */
  readonly providerName: (providerId: string) => string
  /** The `/login` facts the runtime knows about each provider. */
  readonly loginFacts: () => LoginProviderFacts[]
  /** The credentials stored now, by provider and kind. */
  readonly credentials: (
    signal: AbortSignal,
  ) => Promise<readonly { readonly providerId: string; readonly type: HostAuthType }[]>
  /** Log in to a provider: the runtime asks through `ask`, reports through `notify`, and stores the credential. */
  readonly logIn: (
    providerId: string,
    authType: HostAuthType,
    interaction: {
      readonly signal: AbortSignal
      readonly ask: (question: HostAuthQuestion) => Promise<string>
      readonly notify: (event: HostAuthEvent) => void
    },
  ) => Promise<void>
  readonly logOut: (providerId: string, signal: AbortSignal) => Promise<void>
  /** When the thread runs no model: the provider's first available one, chosen and kept; its id, else none. */
  readonly chooseFirstModelIfNone: (providerId: string) => Promise<string | undefined>
  /** The provider's models refreshed; false when the refresh was cut short or failed. */
  readonly refreshModels: (providerId: string, signal: AbortSignal) => Promise<boolean>
  /** The thread's context summarised (`/compact`). */
  readonly compact: () => Promise<{ readonly tokensBefore: number; readonly estimatedTokensAfter?: number }>
}

/** How a flow speaks with the person on the page (#801): the thread's questions and notices. */
export interface FlowConversation {
  /** One of the host's own `input` questions; `undefined` when it gets no answer. */
  readonly askInput: (question: HostInputQuestion, signal: AbortSignal | undefined) => Promise<string | undefined>
  readonly select: (
    message: string,
    labels: readonly string[],
    signal: AbortSignal | undefined,
  ) => Promise<string | undefined>
  readonly input: (
    message: string,
    placeholder: string | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<string | undefined>
  /** A notice from the host itself. */
  readonly notify: (text: string, level: 'info' | 'warning' | 'error') => void
}

/** What running the flows reads from the live thread (#801). */
export interface HostFlowHost {
  readonly threadId: string
  readonly accounts: ProviderAccounts
  readonly conversation: FlowConversation
  /** The thread's fan-out: a login waiting on its provider is said on it. */
  readonly emit: (event: RuntimeEvent) => void
  /** Say the model state again — a login or logout may have changed what the thread can run. */
  readonly announceModelState: () => void
}

/** A thread's host flows: their command rows, starting one, and the login a Stop can end (#801). */
export interface HostFlowRuns {
  /** `/login` and `/logout` as the thread's command list offers them now. */
  readonly rows: () => RuntimeCommand[]
  readonly startHostFlow: (run: EnsoHostCommandRun, outcome: HostFlowOutcome) => void
  readonly loginInProgress: () => EnsoLoginInProgress | undefined
  readonly cancelLogin: () => boolean
  /** Every flow stops: a device-code poll does not outlive the thread it was logging in. */
  readonly dispose: () => void
}

/**
 * A login while it runs (#388): whose, the page its flow announced (the code prompt links to it),
 * and the end of its questions — see `runLogin`.
 */
interface LoginInProgress {
  readonly providerName: string
  authUrl: string | undefined
  readonly questions: AbortController
  /**
   * Stop, for this login only (#348): aborting it ends the provider wait (a device-code poll, a
   * browser callback). `flowsAbort` is the thread's and final; this one leaves the thread be.
   */
  readonly cancel: AbortController
}

export function createHostFlowRuns(host: HostFlowHost): HostFlowRuns {
  const { threadId, accounts, conversation, emit, announceModelState } = host

  let storedCredentials: readonly StoredCredentialFacts[] = []
  // Every flow runs under this signal; `dispose` aborts it, so a device-code poll does not
  // outlive the thread it was logging in (the lease is not held — see `startHostFlow`).
  const flowsAbort = new AbortController()
  // ONE flow at a time per thread (#346): two logins on one feed would interleave their questions
  // with nothing to tell a reader which is which. The second is refused.
  let flowInProgress: string | undefined
  // The login waiting on its provider, if one is (#348): what `loginInProgress` says and
  // `cancelLogin` ends. Set only between the flow's start and the credential being stored.
  let waitingLogin: LoginInProgress | undefined
  async function refreshStoredCredentials(): Promise<void> {
    try {
      const listed = await accounts.credentials(AbortSignal.timeout(15_000))
      storedCredentials = listed.map((credential) => ({
        providerId: credential.providerId,
        providerName: accounts.providerName(credential.providerId),
        type: credential.type,
      }))
    } catch (error) {
      log.warn('stored credentials could not be listed: {error}', { threadId, error })
    }
  }
  void refreshStoredCredentials()

  function currentLoginOptions(): HostCommandOption[] {
    return loginOptions(accounts.loginFacts())
  }

  /**
   * The runtime asks; the browser answers through the dialog seam. A `secret` is masked (the host's
   * own `askInput`); a `select` crosses as labels and comes back as the chosen option's id; a
   * `manual_code` is asked in our words, with the login page the flow announced as a link on the card
   * (#388: nothing opens a browser from here, and the runtime's own words never say the paste is the
   * fallback); `text` is a plain input. No answer — cancelled, aborted — is a cancellation, which the
   * flow reports as such, not as a failure.
   */
  async function askAuthPrompt(prompt: HostAuthQuestion, login: LoginInProgress): Promise<string> {
    // The runtime's own signal when it passed one, AND the login's: a question outlives neither (#389).
    const signal =
      prompt.signal === undefined ? login.questions.signal : AbortSignal.any([prompt.signal, login.questions.signal])
    let answer: string | undefined
    switch (prompt.type) {
      case 'secret':
        answer = await conversation.askInput(
          {
            title: prompt.message,
            secret: true,
            ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
          },
          signal,
        )
        break
      case 'manual_code':
        answer = await conversation.askInput(
          loginCodeQuestion(login.providerName, login.authUrl, prompt.placeholder),
          signal,
        )
        break
      case 'select': {
        const labels = prompt.options.map((option) => option.label)
        const chosen = await conversation.select(prompt.message, labels, signal)
        answer = prompt.options.find((option) => option.label === chosen)?.id
        break
      }
      default:
        answer = await conversation.input(prompt.message, prompt.placeholder, signal)
    }
    if (answer === undefined) throw new FlowCancelled()
    return answer
  }

  /**
   * After a login: when the thread had no model, the provider's first available one — the runtime's
   * TUI picks its own per-provider default from a table it does not export; the first is honest and
   * `/model` is one keystroke away. Then the catalog refresh the runtime's TUI also runs.
   */
  async function settleAfterLogin(providerId: string): Promise<string | undefined> {
    const selected = await accounts.chooseFirstModelIfNone(providerId)
    // Ordered on purpose: the model is chosen against the catalog the login left, before a refresh moves it.
    // react-doctor-disable-next-line server-sequential-independent-await
    const refreshed = await accounts.refreshModels(providerId, AbortSignal.timeout(15_000))
    if (!refreshed) conversation.notify('Model catalog could not be refreshed; using cached models.', 'warning')
    return selected
  }

  async function runLogin(providerId: string, authType: HostAuthType): Promise<void> {
    const providerName = accounts.providerName(providerId)
    // The page the flow announces (`auth_url`) is remembered for the code prompt that follows it.
    // ⚠ A LOGIN'S QUESTIONS END WITH IT (#389). A browser login races its local callback server
    // against the pasted code; when the callback wins, the runtime withdraws the code prompt through
    // the prompt's signal — but an extension provider's prompt carries none (pi-multi-account's
    // bridge drops it, `index.ts:263-264`; pi's composer asks with none, `provider-composer.js:173`),
    // so its card would stay open after the login finished. Every question is tied to the login too,
    // and withdrawn once it settles.
    const login: LoginInProgress = {
      providerName,
      authUrl: undefined,
      questions: new AbortController(),
      cancel: new AbortController(),
    }
    // ⚠ WAITING IS WHAT STOP CAN END (#348): from here until the credential is stored. A login holds
    // no lease, so this — the `login` event, and `loginInProgress` for a snapshot — is how a page
    // knows there is something to stop. Said once each way; the second end is a no-op.
    waitingLogin = login
    emit({ type: 'login', provider: providerName, waiting: true })
    const endWaiting = (): void => {
      if (waitingLogin !== login) return
      waitingLogin = undefined
      emit({ type: 'login', provider: providerName, waiting: false })
    }
    try {
      await accounts.logIn(providerId, authType, {
        signal: AbortSignal.any([flowsAbort.signal, login.cancel.signal]),
        ask: (prompt: HostAuthQuestion): Promise<string> => askAuthPrompt(prompt, login),
        notify: (event: HostAuthEvent): void => {
          if (event.type === 'auth_url') login.authUrl = event.url
          conversation.notify(authEventText(event, providerName), 'info')
        },
      })
      // The credential is stored: the card goes now, not after the catalog refresh below, and
      // there is nothing left for Stop to end.
      login.questions.abort()
      endWaiting()
      // The credential IS stored past this line (#346): what follows can fail — the runtime
      // refusing the model, the catalog not refreshing — and is said as a warning, never as a
      // failed login that `/logout` would then contradict by listing the credential.
      try {
        const selected = await settleAfterLogin(providerId)
        conversation.notify(loginDoneText(providerName, authType, selected), 'info')
      } catch (error) {
        // Said ONCE, and neutrally: the throw may be the catalog refresh after the model was
        // selected, so "could not select a model" would be wrong (#346).
        const reason = error instanceof Error ? error.message : String(error)
        conversation.notify(`Logged in to ${providerName}; post-login setup failed: ${reason}`, 'warning')
      }
    } catch (error) {
      // Stop's cancel is known by ITS signal, whatever sentence the provider throws for it.
      if (login.cancel.signal.aborted || isFlowCancelled(error)) {
        conversation.notify(`Login to ${providerName} cancelled.`, 'info')
      } else {
        const reason = error instanceof Error ? error.message : String(error)
        conversation.notify(`Failed to log in to ${providerName}: ${reason}`, 'error')
      }
    } finally {
      login.questions.abort()
      endWaiting()
      await refreshStoredCredentials()
      announceModelState()
    }
  }

  /**
   * `/compact` (#338 slice 4): the runtime summarises the context — a model call, seconds to a minute
   * — so it starts and is followed like a login, but the route HOLDS THE LEASE until it settles:
   * compaction rewrites the branch, the runtime refuses a prompt while it runs
   * (`agent-session.js:1227`), and `compact()` awaits `abort()` before it arms its own guard
   * (:1866–1867), so a prompt in that window would run alongside the summary — the held lease is what
   * forecloses it (#347). Stop reaches it: the runtime's `abort` cancels a compaction in flight
   * (`hosted-thread.ts`), and the runtime's own `dispose` does too (:587). The page's transcript is
   * the state layer's copy of the messages; the runtime's `compaction_end` becomes `branch-compacted`
   * (#348), and the pane re-reads the branch once the thread is idle.
   */
  async function runCompact(): Promise<void> {
    conversation.notify('Compacting the context…', 'info')
    try {
      const compacted = await accounts.compact()
      conversation.notify(compactDoneText(compacted.tokensBefore, compacted.estimatedTokensAfter), 'info')
    } catch (error) {
      // The runtime's refusals ("Nothing to compact (session too small)") are not failures: said as a
      // warning with its reason. Anything else is (#347).
      const reason = error instanceof Error ? error.message : String(error)
      if (isCompactionRefusal(error)) conversation.notify(`Compaction did not run: ${reason}`, 'warning')
      else conversation.notify(`Compaction failed: ${reason}`, 'error')
    }
  }

  function runDecidedFlow(decision: HostFlowDecision): Promise<void> {
    switch (decision.kind) {
      case 'login':
        return runLogin(decision.providerId, decision.authType)
      case 'logout':
        return runLogout(decision.providerId)
      case 'compact':
        return runCompact()
    }
  }

  async function runLogout(providerId: string): Promise<void> {
    const providerName = accounts.providerName(providerId)
    const type = storedCredentials.find((credential) => credential.providerId === providerId)?.type
    try {
      await accounts.logOut(providerId, AbortSignal.timeout(15_000))
      conversation.notify(logoutDoneText(providerName, type), 'info')
    } catch (error) {
      conversation.notify(
        `Logout from ${providerName} failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
    } finally {
      await refreshStoredCredentials()
      announceModelState()
    }
  }

  return {
    rows: () => hostFlowRows(currentLoginOptions(), logoutOptions(storedCredentials)),
    loginInProgress(): EnsoLoginInProgress | undefined {
      return waitingLogin === undefined ? undefined : { provider: waitingLogin.providerName }
    },
    cancelLogin(): boolean {
      if (waitingLogin === undefined) return false
      // The provider's wait first, then its card: the login settles as cancelled either way.
      waitingLogin.cancel.abort()
      waitingLogin.questions.abort()
      return true
    },
    startHostFlow(run: EnsoHostCommandRun, outcome: HostFlowOutcome): void {
      let decision: HostFlowDecision
      try {
        if (flowInProgress !== undefined) throw new HostCommandRefused(`/${flowInProgress} is already in progress here`)
        decision = decideHostFlow(run, currentLoginOptions(), logoutOptions(storedCredentials))
      } catch (error) {
        outcome.onRejected(error instanceof Error ? error.message : String(error))
        return
      }
      outcome.onAccepted()
      flowInProgress = run.name
      const flow = runDecidedFlow(decision)
      void flow.finally(() => {
        flowInProgress = undefined
        outcome.onSettled()
      })
    },
    dispose: () => flowsAbort.abort(),
  }
}
