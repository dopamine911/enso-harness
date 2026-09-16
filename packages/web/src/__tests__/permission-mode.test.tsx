import { beforeEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createPermissionModeStore, PermissionModeSelect, type PermissionModeStore } from '../permission-mode.tsx'

/**
 * #84's browser half: the CURRENT permission mode as state, and the control that changes
 * it. One store per thread (#90 PR 3), so each case builds a fresh one. The dropdown is
 * rendered statically; its send wiring lives in chat-screen.tsx and is covered by the live
 * receipt (renderToStaticMarkup runs no handlers).
 */

let store: PermissionModeStore
beforeEach(() => {
  store = createPermissionModeStore()
})

const receipt = (
  mode: string,
  available: string[] = ['default', 'acceptEdits', 'plan'],
): { mode: string; available: string[] } => ({ mode, available })

// ── the store ────────────────────────────────────────────────────────────────

// ⚠ THE HONESTY RULE. Before anything arrives the mode is unknown — not `default`. The
// one case this store exists for (#73: refused in default mode, no change yet) is exactly
// the one an assumed default would misreport if the receipt ever failed to arrive.
test('⚠ the mode is UNKNOWN until a receipt arrives — never an assumed default', () => {
  expect(store.get()).toEqual({ mode: undefined, available: [] })
})

test('a run-start receipt sets both the mode and the modes on offer', () => {
  store.applyReceipt(receipt('default'))
  expect(store.get()).toEqual({ mode: 'default', available: ['default', 'acceptEdits', 'plan'] })
})

// ⚠ ONE FEED (L3). A change mid-run arrives as the same `zen.mode` receipt the run started
// with — the host says the mode AND the list, so nothing here knows what a vendor entry is.
test('a mid-run receipt moves the mode and the option list together', () => {
  store.applyReceipt(receipt('default'))
  store.applyReceipt(receipt('acceptEdits', ['default', 'acceptEdits']))
  expect(store.get()).toEqual({ mode: 'acceptEdits', available: ['default', 'acceptEdits'] })
})

test('malformed values never throw and never move the store', () => {
  store.applyReceipt(receipt('plan'))
  for (const bad of [null, undefined, 42, 'acceptEdits', {}, { mode: '' }, { mode: 7 }, { customType: 'modes' }]) {
    store.applyReceipt(bad)
  }
  expect(store.get().mode).toBe('plan')
})

test('a receipt with a malformed option list keeps the previous list rather than emptying it', () => {
  store.applyReceipt(receipt('default'))
  store.applyReceipt({ mode: 'plan', available: 'not-a-list' })
  expect(store.get()).toEqual({ mode: 'plan', available: ['default', 'acceptEdits', 'plan'] })
})

test('subscribers are told on every change, and unsubscribing stops it', () => {
  let notified = 0
  const stop = store.subscribe(() => {
    notified += 1
  })
  store.applyReceipt(receipt('default'))
  store.applyReceipt(receipt('plan'))
  stop()
  store.applyReceipt(receipt('auto'))
  expect(notified).toBe(2)
})

// ── the mount-time seed ──────────────────────────────────────────────────────

test("the seed fills an unknown store from the server's fresh-thread state", async () => {
  await store.seed(() => Promise.resolve(receipt('default', ['default', 'plan'])))
  expect(store.get()).toEqual({ mode: 'default', available: ['default', 'plan'] })
})

// ⚠ THE REMOUNT HAZARD. The store outlives the component; a remount re-runs the seed. If
// the thread already switched modes, the fresh-thread default must NOT overwrite it.
test('⚠ the seed never clobbers a mode the store already holds', async () => {
  store.applyReceipt(receipt('acceptEdits'))
  await store.seed(() => Promise.resolve(receipt('default')))
  expect(store.get().mode).toBe('acceptEdits')
})

// A receipt that lands WHILE the fetch is in flight must also win: the seed re-checks
// after resolving, not only before starting.
test('a receipt arriving during the fetch beats the seed', async () => {
  const { promise, resolve } = Promise.withResolvers<unknown>()
  const seeding = store.seed(() => promise)
  store.applyReceipt(receipt('plan'))
  resolve(receipt('default'))
  await seeding
  expect(store.get().mode).toBe('plan')
})

test('a failed or malformed fetch leaves the store honestly unknown', async () => {
  await store.seed(() => Promise.reject(new Error('no server')))
  await store.seed(() => Promise.resolve({ nope: true }))
  expect(store.get().mode).toBeUndefined()
})

// ⚠ STRICT MODE. main.tsx mounts under React StrictMode, which runs the mount effect twice
// in dev; both pass the unknown-check before either fetch resolves. They must share ONE
// request, and a failed one must not poison the slot for a later retry.
test('concurrent seeds share one fetch; a failed seed lets a later one retry', async () => {
  let fetches = 0
  const { promise, resolve } = Promise.withResolvers<unknown>()
  const fetcher = (): Promise<unknown> => {
    fetches += 1
    return promise
  }
  const first = store.seed(fetcher)
  const second = store.seed(fetcher)
  resolve(receipt('default'))
  await Promise.all([first, second])
  expect(fetches).toBe(1)
  expect(store.get().mode).toBe('default')

  store = createPermissionModeStore()
  await store.seed(() => Promise.reject(new Error('first try failed')))
  await store.seed(() => Promise.resolve(receipt('plan')))
  expect(store.get().mode).toBe('plan')
})

// ── the control ──────────────────────────────────────────────────────────────

const noop = (): void => {
  // Static markup runs no handlers; the callback exists only to satisfy the prop.
}

test("⚠ an unknown mode renders as `unknown` and offers nothing — the options are picc's to declare", () => {
  const rendered = renderToStaticMarkup(
    <PermissionModeSelect mode={undefined} available={[]} disabled={false} onSelect={noop} />,
  )
  expect(rendered).toContain('unknown')
  expect(rendered).toContain('disabled')
  expect(rendered).not.toContain('value="default"')
})

test('a known mode is the selected option, and every available mode is offered', () => {
  const rendered = renderToStaticMarkup(
    <PermissionModeSelect
      mode="acceptEdits"
      available={['default', 'acceptEdits', 'plan']}
      disabled={false}
      onSelect={noop}
    />,
  )
  expect(rendered).toContain('<option value="default">default</option>')
  expect(rendered).toContain('<option value="acceptEdits" selected="">acceptEdits</option>')
  expect(rendered).toContain('<option value="plan">plan</option>')
  expect(rendered).not.toContain('unknown')
})

test('the control is disabled while a run is in flight', () => {
  const rendered = renderToStaticMarkup(
    <PermissionModeSelect mode="default" available={['default', 'plan']} disabled={true} onSelect={noop} />,
  )
  expect(rendered).toContain('disabled')
})

// The readout must never lie about what it was told: a mode the receipt's list somehow
// omitted still renders as the current selection rather than snapping to something else.
test('a current mode missing from the option list is still shown as selected', () => {
  const rendered = renderToStaticMarkup(
    <PermissionModeSelect mode="bypassPermissions" available={['default', 'plan']} disabled={false} onSelect={noop} />,
  )
  expect(rendered).toContain('<option value="bypassPermissions" selected="">bypassPermissions</option>')
})
