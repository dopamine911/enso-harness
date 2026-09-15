# Seam: the permission mode

The policy a run's tools execute under, as the server reads it and the browser shows it. Glossary
domain: **Permission** (the mode *concept*: what may run without asking) with one foot in **Thread**
(the custom entry that persists it) and one in **Observation** (the receipt that carries it). This is
the honest page: the concept is ours, the implementation today is a vendor extension read three
layers away from it — leak **L3**, the seam #162 workstream 4 owns in three steps. Step A is done:
everything the vendor persists and registers is read *below* the `AgentHost` seam, in
`web/src/host/permission-mode-adapter.ts`, and the server asks the host. Steps B and C are named under
*Pivot cost*.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/permission-mode.md`.

## The contract

What crosses to the browser: the mode a run is in, and the modes it may switch to.

<!-- source: packages/core/src/permission-mode.ts#ZenPermissionModeState -->
```ts
/**
 * The receipt a run starts with (#84) — and the value of the `zen.mode` CUSTOM chunk that
 * carries it to the browser. `mode` is picc's current mode; `available` is what the mode
 * dropdown may offer: the modes the runtime's mode extension registers, intersected with the
 * commands this session actually registers, in the extension's order (the host decides).
 */
export const ZenPermissionModeState = Type.Object({
  mode: Type.String(),
  available: Type.Array(Type.String()),
})
```

How the mode is found, below the seam: a walk over the branch, newest entry first, to the last custom
entry of the mode extension's `customType`. The doc comment carries the two decisions that matter —
whose rule this is, and why it is never cached.

<!-- source: packages/web/src/host/permission-mode-adapter.ts#persistedPermissionMode -->
```ts
/**
 * picc's own `restoreState` rule, applied to a branch (#84): the LAST `modes` entry wins,
 * and a branch with none is the initial mode. Walked from the end so the newest entry is
 * the first hit. THE definition — a live thread's `permissionModeState` and a stored
 * thread's opening mode (#95) both read this one walk.
 *
 * ⚠ Deliberately NOT cached anywhere (PR #85 review): the branch is not append-only —
 * `/tree`, `/fork` and `/branch` move the leaf onto a path whose last `modes` entry can
 * differ, which is exactly why picc re-walks. Correctness under branch navigation is worth
 * microseconds per run.
 */
export function persistedPermissionMode(branch: readonly unknown[]): string {
  for (let position = branch.length - 1; position >= 0; position -= 1) {
    const entry = branch[position]
    if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'custom') continue
    const persisted = readPiccPersistedMode(entry)
    if (persisted !== undefined) return persisted
  }
  return PICC_DEFAULT_PERMISSION_MODE
}
```

<!-- source: packages/core/src/permission-mode.ts#readPiccPersistedMode -->
```ts
/**
 * The mode carried by ONE persisted custom entry, or undefined when the entry is not
 * picc's (`customType` differs), is malformed, or carries no mode. Reads defensively —
 * every wire crossing does — so an unrelated extension's custom entry is ignored, never a
 * throw inside a stream loop.
 */
export function readPiccPersistedMode(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const { customType, data } = entry as { customType?: unknown; data?: unknown }
  if (customType !== PICC_MODES_CUSTOM_TYPE) return undefined
  if (typeof data !== 'object' || data === null) return undefined
  const { mode } = data as { mode?: unknown }
  return typeof mode === 'string' && mode.length > 0 ? mode : undefined
}
```

What the host hands the server for a thread that is not live — a fresh one, or a stored one read from
its branch — so the server never spells the vendor's set:

<!-- source: packages/web/src/host/permission-mode-adapter.ts#freshPermissionModeState -->
```ts
/**
 * What a FRESH thread starts in (#84): picc's initial mode, and every mode picc registers
 * unconditionally. Honest by construction — a new thread is a new session file with no
 * `modes` entry — and served before any run exists, so the header reads `default` from the
 * first paint rather than `unknown`.
 */
export function freshPermissionModeState(): ZenPermissionModeState {
  return { mode: PICC_DEFAULT_PERMISSION_MODE, available: [...PICC_PERMISSION_MODES] }
}
```

<!-- source: packages/web/src/host/permission-mode-adapter.ts#storedPermissionModeState -->
```ts
/**
 * A STORED thread's state, from its branch alone (#95): the walk for the mode, and the full
 * registered set for `available` — no session is built to ask what it registers (#86's
 * rule: looking must not build), so the cold answer offers what picc always offers.
 */
export function storedPermissionModeState(branch: readonly unknown[]): ZenPermissionModeState {
  return { mode: persistedPermissionMode(branch), available: [...PICC_PERMISSION_MODES] }
}
```

The vendor's shape and vocabulary, once each. The `customType` and its reader are the one vendor fact
still in `@zen/core` (the browser's two `zen.entry` readers need them until step B); the registered set
lives with the walk, below the seam.

<!-- source: packages/core/src/permission-mode.ts#PICC_MODES_CUSTOM_TYPE -->
```ts
/** The `customType` picc persists its state under. */
export const PICC_MODES_CUSTOM_TYPE = 'modes'
```

<!-- source: packages/web/src/host/permission-mode-adapter.ts#PICC_PERMISSION_MODES -->
```ts
/** Every mode picc registers a per-mode slash command for, in picc's order. */
export const PICC_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const
```

## Who implements it, who consumes it

**Persisted by the mode extension, not by us.** The extension keeps its live mode in a closure with
no getter (`permission-mode.ts:6-9`); the one observable artifact is the custom entry it appends on
every change, `customType: "modes"`. The harness never writes one.

**Read by the host, and only there.** `packages/web/src/host/agent-host.ts` implements
`ThreadRuntime.permissionModeState` for a live thread: the walk over `sessionManager.getBranch()` for
the mode, and `PICC_PERMISSION_MODES` filtered by the commands the session's extension runner actually
registered for `available` — a name lookup, because the extension names one slash command per mode
(read off the registry directly rather than through `listCommands`, whose call count the refusal path's
tests pin). For a thread that is not live, `AgentHost.freshPermissionMode()` and
`AgentHost.storedPermissionMode(branch)` answer from the adapter. Every vendor name is in
`permission-mode-adapter.ts` and `agent-host.ts`, under `host/`, where the vendor gate allows them.

**Consumed by the server, three ways — none of them spelling the vendor.** The follow's snapshot
carries `permissionMode` (`packages/core/src/follow.ts:33`), filled from the live runtime or, for a
cold thread, from `host.storedPermissionMode(branch)` (`packages/web/src/server/follow.ts`; the history
route does the same in `server/index.ts`). The inspection and summary report the live mode. And
`GET /api/mode` answers `host.freshPermissionMode()` before any run exists. The run receipt
(`ZenPromptReceipt`, `packages/core/src/follow.ts:158-169`) does **not** carry the mode; it carries
`messageId`, `generation` and `queued` only.

**Shown by the browser, two views.** The snapshot's `permissionMode` becomes the `zen.mode` custom
event (`packages/web/src/follow-connection.ts:349`), routed to the per-thread mode store
(`custom-event-router.ts:49-51`). A mid-run change arrives as the `custom-entry` observation the mapper
emits for any custom entry (`rpc/map-events.ts:315-316`), routed as `zen.entry` to *both* views
(`custom-event-router.ts:42-47`): `permission-mode.tsx` (the composer's `<select>`, which says
`unknown` until a real value has arrived, `permission-mode.tsx:21-23,165-169`) and `mode-lines.ts`
(one transcript line per distinct value, worded as state, `mode-lines.ts:13-17,44-52`). Changing the
mode is a prompt: the select sends `/${mode}` (`chat-screen.tsx:288-292,314`), because the extension's
setter is closure-private and its commands are the only way in.

**Second implementation:** the fakes (#178). `createFakeHostedThread` answers a literal
`permissionModeState` for a live thread and `createFakeAgentHost` *declares* its fresh and stored
modes rather than computing them (`server/__tests__/fake-hosted-thread.ts`), which proves the server
runs on `{ mode, available }` alone — it never sees a vendor entry.
`packages/web/src/host/__tests__/permission-mode-adapter.test.ts` pins the walk's rule below the seam:
last entry wins, none is `default`, another extension's custom entry is not a mode.

## What fences it

- **The vendor gate** (`test/vendor-gate.test.ts`, #145): a vendor extension's name may appear in
  code only under `packages/web/src/host/` and `packages/harness/extensions/`. Every other file that
  spells it is one allowlist line, each with its reason — and every line below is this seam's:
  - `packages/core/src/permission-mode.ts` — "L3 (picc's persistence read in core): the mode's own
    vocabulary is picc's registered set and its persisted `customType: "modes"` entry. Leaves when the
    mode concept is ours."
  - `packages/core/src/index.ts` — "its re-export surface: `PICC_*` is part of `@zen/core`'s public
    names today."
  - `packages/web/src/server/index.ts`, `packages/web/src/server/follow.ts` — "The two server routes
    that answer `{ mode, available }`: the available set is picc's. Leaves with L3."
  - `packages/web/src/permission-mode.tsx` — "The dropdown reads the persisted mode through
    `readPiccPersistedMode` and says whose default a fresh thread starts in. The call leaves with L3;
    the sentence stops being true the same day."
  - `packages/web/src/mode-lines.ts` — "The status line's second reader of the same persisted entry
    … Leaves with L3."
  (`vendor-gate.test.ts:68-88`. The seventh line, `packages/core/src/guard.ts`, is the guards page's.)
- **The tool-call participants tripwire** (`packages/harness/extensions/__tests__/tool-call-participants.test.ts`)
  names the mode extension as the second of exactly two `tool_call` handlers, so it cannot be silently
  replaced by a third — see the guards page.
- **The glossary** decides the vocabulary is ours: *permission mode*, *mode* (and nothing else —
  decision 3 gives the runtime's own interface setting no word).

## What crosses it that should not

**L3, the browser's half** (`.local/refactor/goals.md` §2). After step A, what still crosses above
the host:

- `@zen/core` still knows the vendor's persisted entry — `customType: "modes"`, `data.mode` — as
  `PICC_MODES_CUSTOM_TYPE` and `readPiccPersistedMode`, because the browser reads it.
- The browser reads the persisted entry itself, in two files, and its tooltip says whose default a
  fresh thread starts in (`permission-mode.tsx`). The composer switches mode by sending the vendor's
  slash command by name as a prompt (`chat-screen.tsx`).

What no longer crosses: the registered set, the initial mode and the walk — the server asks the host.
The leak is inventory (four allowlist lines: `core/permission-mode.ts`, `core/index.ts`,
`permission-mode.tsx`, `mode-lines.ts`), not surprise.

## Pivot cost

**Replace the mode extension** and the files that change are `permission-mode-adapter.ts` (the set,
the initial mode, the walk) and `agent-host.ts` (the command-name intersection) under `host/` — plus,
until steps B and C, `permission-mode.ts` (the entry reader), `permission-mode.tsx` and `mode-lines.ts`
(the browser's two readers) and `chat-screen.tsx` (the slash command the select sends).
`ZenFollowSnapshot`, the inspection, the summary, the router, the store's fold and both server cold
paths do not change: they hold `{ mode, available }` and the fakes prove the server runs on that alone.

**Fix L3** (#162 workstream 4; goals §3.2: "the mode is `ZenPermissionMode` with picc as *an*
implementation the host adapts"), in three steps:

- **A — done.** The walk, the initial mode and the registered set went below the seam into
  `permission-mode-adapter.ts`; `AgentHost` gained `freshPermissionMode` and `storedPermissionMode`;
  the server's cold paths ask the host; the `?debug` drawer stopped re-walking the vendor's entries in
  the browser. Two allowlist lines deleted (`server/index.ts`, `server/follow.ts`).
- **B.** The host emits a mode observation when it sees the vendor's entry; the browser's two
  `zen.entry` readers fold `zen.mode` instead and stop knowing a custom entry's shape; the tooltip
  stops naming the vendor. `readPiccPersistedMode` and `PICC_MODES_CUSTOM_TYPE` follow the rest below
  the seam and `@zen/core` is `ZenPermissionModeState` alone. Four allowlist lines deleted.
- **C.** Changing the mode becomes a control route (`POST …/mode` → `ThreadRuntime`), the host
  translating to the vendor's slash command; the select stops sending a prompt.

`guard.ts`'s line stays: a path, not an import.
