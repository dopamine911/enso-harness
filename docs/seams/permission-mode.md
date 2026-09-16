# Seam: the permission mode

The policy a run's tools execute under, as the server reads it and the browser shows it. Glossary
domain: **Permission** (the mode *concept*: what may run without asking) with one foot in **Thread**
(the custom entry that persists it) and one in **Observation** (the receipt that carries it). This is
the honest page: the concept is ours, the implementation today is a vendor extension read three
layers away from it — leak **L3**, which #162 workstream 4 closed in three steps. Everything the
vendor persists, registers and is *told* is below the `AgentHost` / `ThreadRuntime` seam, in
`web/src/host/permission-mode-adapter.ts` and `agent-host.ts`; the server asks the host; the host emits
the `permission-mode` observation on a change and the browser folds that alone; changing the mode is a
control route. `@zen/core` is `ZenPermissionModeState` and the route's body.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/permission-mode.md`.

## The contract

What crosses to the browser: the mode a run is in, and the modes it may switch to — at run start as
the receipt, and on every change as the observation, one shape for both.

<!-- source: packages/core/src/permission-mode.ts#ZenPermissionModeState -->
```ts
/**
 * The receipt a run starts with (#84) — and the value of the `permission-mode` CUSTOM chunk that
 * carries it to the browser, at run start and on every change. `mode` is the current mode;
 * `available` is what the mode dropdown may offer: the modes the runtime's mode extension
 * registers, intersected with the commands this session actually registers, in the
 * extension's order (the host decides).
 */
export const ZenPermissionModeState = Type.Object({
  mode: Type.String({ minLength: 1 }),
  available: Type.Array(Type.String({ minLength: 1 })),
})
```

<!-- source: packages/core/src/observation.ts#ZenPermissionMode -->
```ts
/**
 * The permission mode changed, and what a run may switch to now (#162 workstream 4, L3).
 * The HOST emits this when its mode extension persists a change — the one observation the
 * browser reads the mode from mid-run, so no surface knows which extension's entry it was
 * or what that entry looks like. The same `{ mode, available }` a run starts with
 * (`ZenPermissionModeState`): one shape for the receipt and for the change.
 */
export const ZenPermissionMode = Type.Object({
  kind: Type.Literal('permission-mode'),
  ...ZenPermissionModeState.properties,
})
```

And what crosses the other way — the one thing the browser may say about the mode:

<!-- source: packages/core/src/permission-mode.ts#ZenPermissionModeChange -->
```ts
/**
 * The body of `POST /api/threads/:threadId/mode` (L3 step C): the mode to switch to. A
 * control route, not a prompt — the server refuses a mode the thread does not offer (422)
 * and a busy thread (409); the change itself arrives on the follow as `permission-mode`,
 * never from the click.
 */
export const ZenPermissionModeChange = Type.Object({
  mode: Type.String({ minLength: 1 }),
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

<!-- source: packages/web/src/host/permission-mode-adapter.ts#readPiccPersistedMode -->
```ts
/**
 * The mode carried by ONE persisted custom entry, or undefined when the entry is not
 * picc's (`customType` differs), is malformed, or carries no mode. Reads defensively —
 * every wire crossing does — so an unrelated extension's custom entry is ignored, never a
 * throw inside a stream loop.
 */
export function readPiccPersistedMode(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  if (!('customType' in entry) || entry.customType !== PICC_MODES_CUSTOM_TYPE) return undefined
  if (!('data' in entry) || typeof entry.data !== 'object' || entry.data === null) return undefined
  if (!('mode' in entry.data)) return undefined
  const { mode } = entry.data
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
 * A STORED thread's state, from its transcript alone (#95): the walk for the mode — over
 * entries of ours, so the custom entry's `customType` and `data` are read where the
 * transcript already put them — and the full registered set for `available`; no session is
 * built to ask what it registers (#86's rule: looking must not build), so the cold answer
 * offers what picc always offers.
 */
export function storedPermissionModeState(transcript: readonly ZenTranscriptEntry[]): ZenPermissionModeState {
  for (let position = transcript.length - 1; position >= 0; position -= 1) {
    const entry = transcript[position]
    if (entry?.kind !== 'custom') continue
    const persisted = readPiccPersistedMode({ customType: entry.customType, data: entry.data })
    if (persisted !== undefined) return { mode: persisted, available: [...PICC_PERMISSION_MODES] }
  }
  return freshPermissionModeState()
}
```

The vendor's registered set, once, below the seam with the walk and the entry reader (the
`customType` it reads is a private constant of the same file):

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

**Said by the host, mid-run.** When the host's session subscription sees the vendor persist a mode, it
emits its own `permission_mode` event right after it (`host/agent-host.ts`, the session subscription;
pinned by `agent-host.test.ts` against the real extension). The mapper carries it as the
`permission-mode` observation (`host/map-events.ts#mapPermissionMode`), and `rpc/to-agui.ts` emits it as
a CUSTOM chunk named `permission-mode`, carrying the observation whole; the run-start receipt is the
snapshot's `permissionMode`, the same `ZenPermissionModeState` shape. The vendor's `custom-entry`
still crosses as itself — recorded and counted by the debug pane, rendered by nothing.

**Shown by the browser, two views, one feed.** The mode — off the snapshot
(`packages/web/src/follow-connection.ts`) and from every `permission-mode` observation — is routed to *both* views
(`custom-event-router.ts`): `permission-mode.tsx` (the composer's `<select>`, which says `unknown` until
a real value has arrived) and `mode-lines.ts` (one transcript line per distinct value, worded as state).
Neither knows what a vendor entry is. **Changing the mode is a control route** (step C):
`POST …/mode` with `ZenPermissionModeChange` (`follow-connection.ts#changeMode`, from the composer's
select in `chat-screen.tsx`) → `changeThreadMode` (`server/follow.ts`: acquires like a prompt, 409 while
busy, 422 for a mode the thread does not offer) → `ThreadRuntime.setPermissionMode` → the host runs the
vendor's per-mode command as a prompt (`permission-mode-adapter.ts#piccModeCommand`). Invariant 2: the
route tells pi; the feed carries the change as `permission-mode`. The click moves no store.

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
  none for this seam any more: the six lines L3 needed (`core/permission-mode.ts`, `core/index.ts`,
  `server/index.ts`, `server/follow.ts`, `permission-mode.tsx`, `mode-lines.ts`) left with steps A and
  B, and the gate refuses a row that matches nothing, so they cannot come back unnoticed. The one line
  left, `packages/core/src/guard.ts`, is the guards page's.
- **The tool-call participants tripwire** (`packages/harness/extensions/__tests__/tool-call-participants.test.ts`)
  names the mode extension as the second of exactly two `tool_call` handlers, so it cannot be silently
  replaced by a third — see the guards page.
- **The glossary** decides the vocabulary is ours: *permission mode*, *mode* (and nothing else —
  decision 3 gives the runtime's own interface setting no word).

## What crosses it that should not

**Nothing.** Above the host, no surface reads the vendor's persisted entry, spells its set, or names
its commands; the vendor gate's allowlist has no row for this seam. What the browser knows of the mode
is `ZenPermissionModeState` in, `ZenPermissionModeChange` out.

## Pivot cost

**Replace the mode extension** and the files that change are `permission-mode-adapter.ts` (the set,
the initial mode, the walk, the entry reader, the command a mode is set with) and `agent-host.ts` (the
command-name intersection, the `permission_mode` emission, `setPermissionMode`) under `host/`. Nothing
above them.
`ZenFollowSnapshot`, the inspection, the summary, the router, the store's fold and both server cold
paths do not change: they hold `{ mode, available }` and the fakes prove the server runs on that alone.

**Fix L3** (#162 workstream 4; goals §3.2: "the mode is `ZenPermissionMode` with picc as *an*
implementation the host adapts"), in three steps:

- **A — done.** The walk, the initial mode and the registered set went below the seam into
  `permission-mode-adapter.ts`; `AgentHost` gained `freshPermissionMode` and `storedPermissionMode`;
  the server's cold paths ask the host; the `?debug` drawer stopped re-walking the vendor's entries in
  the browser. Two allowlist lines deleted (`server/index.ts`, `server/follow.ts`).
- **B — done.** The host emits `permission_mode` when it sees the vendor's entry; the mapper carries
  it as the `permission-mode` observation; the browser's two readers fold the `permission-mode` observation and stopped knowing
  a custom entry's shape; the tooltip stopped naming the vendor. `readPiccPersistedMode` and the
  `customType` followed the rest below the seam; `@zen/core` is `ZenPermissionModeState` alone. Four
  allowlist lines deleted.
- **C — done.** `POST …/mode` → `changeThreadMode` → `ThreadRuntime.setPermissionMode`; the host
  translates to the vendor's command; the select posts a mode and sends no prompt. Pinned on the wire
  (`follow.test.ts`: 204 + the `permission-mode` observation, 422 unoffered, 409 busy, 400 malformed)
  and in the browser (`follow-connection.test.ts`).

`guard.ts`'s line stays: a path, not an import.
