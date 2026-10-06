import { createStore, type Store, useStore, useThreadStores } from './store.ts'

/**
 * The CURRENT permission mode, as state — and the control that changes it (#84).
 *
 * `mode-lines.ts` renders mode changes as transcript history. This is the other view: what
 * mode the thread is in NOW, kept in a per-thread store like the session stats, so a user
 * refused with `user dismissed dialog` (#73) can see they are in `default` instead of
 * reading the refusal as a bug.
 *
 * One feed, one store: `permission-mode`, carrying `{ mode, available }` — the receipt the server
 * synthesises at every run start (the mode the run begins in and the modes this session
 * registers), and the same chunk again whenever the host sees its mode extension persist a
 * change mid-run (the `permission-mode` observation, L3). This store never learns which
 * extension's entry a change was or what that entry looks like.
 *
 * ⚠ HONESTY RULE: `mode` is `undefined` — rendered as `unknown` — until a real value has
 * arrived. Never assumed. Before the first prompt no session exists yet, and the one case
 * this control exists for is precisely the one a guess would get wrong.
 *
 * ⓘ ONE STORE PER THREAD (#90 PR 3). A page holds several threads and switches between
 * them; each thread's mode is its own. The store is created by `thread-stores.ts` and
 * reaches components through `useThreadStores()`.
 */

export interface PermissionModeState {
  /** The current mode, or undefined until a receipt has arrived. */
  mode: string | undefined
  /** The modes the dropdown may offer — the host's intersection of its extension's set with what this session registers. */
  available: readonly string[]
}

const UNKNOWN: PermissionModeState = { mode: undefined, available: [] }

export interface PermissionModeStore extends Store<PermissionModeState> {
  /** Fold one `permission-mode` receipt's value in. Defensive like every wire crossing: a malformed value changes nothing. */
  readonly applyReceipt: (data: unknown) => void
  /**
   * Seed from the server's fresh-thread state (`GET /api/mode`) so the control reads
   * `default` from the first paint instead of `unknown` until the first run.
   *
   * ⚠ ONLY WHILE STILL UNKNOWN. The store outlives the component, so a remount (HMR, strict
   * mode, a re-render of the layout) would otherwise clobber a real mode the thread already
   * switched to with the fresh-thread default. Checked again AFTER the fetch resolves, not
   * just before: a run-start receipt can land in between.
   *
   * ⚠ ONE FETCH AT A TIME. `main.tsx` mounts under React StrictMode, which runs effects
   * twice in dev; both mounts pass the unknown-check before either fetch resolves, so
   * without this they would fire two identical requests (PR #85 review). Concurrent seeds
   * share the in-flight fetch; a failed one clears the slot so a later seed may retry.
   *
   * The fetcher is injected so the guard is testable without a network; a failed or
   * malformed fetch leaves the store untouched — `unknown` is the honest answer then.
   */
  readonly seed: (fetchFreshThreadState: () => Promise<unknown>) => Promise<void>
}

export function createPermissionModeStore(): PermissionModeStore {
  const store = createStore<PermissionModeState>(UNKNOWN)
  let seeding: Promise<void> | undefined

  const applyReceipt = (data: unknown): void => {
    if (typeof data !== 'object' || data === null) return
    const receipt = data as { mode?: unknown; available?: unknown }
    if (typeof receipt.mode !== 'string' || receipt.mode.length === 0) return
    const available = Array.isArray(receipt.available)
      ? receipt.available.filter((mode): mode is string => typeof mode === 'string' && mode.length > 0)
      : store.get().available
    store.set({ mode: receipt.mode, available })
  }

  const seedOnce = async (fetchFreshThreadState: () => Promise<unknown>): Promise<void> => {
    let fresh: unknown
    try {
      fresh = await fetchFreshThreadState()
    } catch {
      return
    }
    if (store.get().mode !== undefined) return
    applyReceipt(fresh)
  }

  return {
    get: store.get,
    subscribe: store.subscribe,
    applyReceipt,
    seed: (fetchFreshThreadState: () => Promise<unknown>) => {
      if (store.get().mode !== undefined) return Promise.resolve()
      seeding ??= seedOnce(fetchFreshThreadState).finally(() => {
        seeding = undefined
      })
      return seeding
    },
  }
}

/** The rendering thread's current mode. */
export function usePermissionMode(): PermissionModeState {
  return useStore(useThreadStores().permissionMode)
}

export interface PermissionModeSelectProps {
  mode: string | undefined
  available: readonly string[]
  /** Called with the chosen mode; never with the current one (selecting it is a no-op here). */
  onSelect: (mode: string) => void
}

/**
 * The composer-row control: current mode, and a native `<select>` of the modes the host offers.
 *
 * Presentational and chat-agnostic on purpose — it can be rendered statically in a test
 * with no chat context. `chat-screen.tsx` wraps it with the send + loading wiring. A native
 * `<select>` rather than a vendored component: it is keyboard- and screen-reader-complete
 * out of the box, and this repo has spent effort on what each vendored dependency costs.
 *
 * ⓘ Empty `available` (nothing received yet) disables the control rather than offering a
 * hardcoded list: the options are the mode extension's to declare, not ours to assume. A run in
 * flight does not (#618): a mode chosen then governs the run's next tool call.
 */
export function PermissionModeSelect({ mode, available, onSelect }: PermissionModeSelectProps): React.ReactNode {
  const known = mode !== undefined
  return (
    <label
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      title={
        known
          ? "pi's permission mode for this thread — change it here or with /mode"
          : 'not known until the first prompt has run — a fresh thread starts in the default mode'
      }
    >
      <span>mode</span>
      <select
        aria-label="permission mode"
        className="rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground disabled:opacity-60"
        disabled={available.length === 0}
        value={known ? mode : ''}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          const next = event.currentTarget.value
          if (next.length === 0 || next === mode) return
          onSelect(next)
        }}
      >
        {known ? null : (
          <option value="" disabled>
            unknown
          </option>
        )}
        {available.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        {/* The current mode always renders even if the receipt's list somehow omitted it —
				    the readout must never lie about what it was told. */}
        {known && !available.includes(mode) ? <option value={mode}>{mode}</option> : null}
      </select>
    </label>
  )
}
