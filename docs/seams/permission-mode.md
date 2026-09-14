# Seam: the permission mode

The policy a run's tools execute under, as the server reads it and the browser shows it. Glossary
domain: **Permission** (the mode *concept*: what may run without asking) with one foot in **Thread**
(the custom entry that persists it) and one in **Observation** (the receipt that carries it). This is
the honest page: the concept is ours, the implementation today is a vendor extension read three
layers away from it — leak **L3**, the seam #162 workstream 4 exists to own.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/permission-mode.md`.

## The contract

What crosses to the browser: the mode a run is in, and the modes it may switch to.

<!-- source: packages/core/src/permission-mode.ts#ZenPermissionModeState -->
```ts
/**
 * The receipt a run starts with (#84) — and the value of the `zen.mode` CUSTOM chunk that
 * carries it to the browser. `mode` is picc's current mode; `available` is what the mode
 * dropdown may offer: `PICC_PERMISSION_MODES` intersected with the commands this session
 * actually registers, in picc's order.
 */
export const ZenPermissionModeState = Type.Object({
  mode: Type.String(),
  available: Type.Array(Type.String()),
})
```

How the mode is found: a walk over the branch, newest entry first, to the last custom entry of the
mode extension's `customType`. The doc comment carries the two decisions that matter — whose rule
this is, and why it is never cached.

<!-- source: packages/core/src/permission-mode.ts#persistedPermissionMode -->
```ts
/**
 * picc's own `restoreState` rule, applied to a branch (#84): the LAST `modes` entry wins,
 * and a branch with none is the initial mode. Walked from the end so the newest entry is
 * the first hit. THE definition — the host's `permissionModeState`, the `?debug` drawer's
 * cross-check, and a resumed thread's opening mode (#95) all read this one walk.
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

The three constants that spell the vendor's shape and vocabulary, once. `@zen/core`'s barrel re-exports
all six names (`packages/core/src/index.ts:115-122`); there is no other top-level declaration in the
module.

<!-- source: packages/core/src/permission-mode.ts#PICC_MODES_CUSTOM_TYPE -->
```ts
/** The `customType` picc persists its state under. */
export const PICC_MODES_CUSTOM_TYPE = 'modes'
```

<!-- source: packages/core/src/permission-mode.ts#PICC_DEFAULT_PERMISSION_MODE -->
```ts
/** picc's initial mode — a fresh session with no `modes` entry is in this mode by construction. */
export const PICC_DEFAULT_PERMISSION_MODE = 'default'
```

<!-- source: packages/core/src/permission-mode.ts#PICC_PERMISSION_MODES -->
```ts
/** Every mode picc registers a per-mode slash command for, in picc's order. */
export const PICC_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const
```

## Who implements it, who consumes it

**Persisted by the mode extension, not by us.** The extension keeps its live mode in a closure with
no getter (`permission-mode.ts:6-9`); the one observable artifact is the custom entry it appends on
every change, `customType: "modes"`. The harness never writes one.

**Read by the host.** `packages/web/src/host/agent-host.ts:423-436` implements
`ThreadRuntime.permissionModeState`: `persistedPermissionMode(sessionManager.getBranch())` for the
mode, and `PICC_PERMISSION_MODES` filtered by the commands the session's extension runner actually
registered for `available` — a name lookup, because the extension names one slash command per mode.
Read off the registry directly rather than through `listCommands`, whose call count the refusal path's
tests pin (`agent-host.ts:428-431`).

**Consumed by the server, three ways.** The follow's snapshot carries `permissionMode`
(`packages/core/src/follow.ts:33`), filled from the live runtime or, for a cold thread, from the same
walk over the stored branch plus the whole registered set (`packages/web/src/server/follow.ts:134-137`;
the history route does the same at `server/index.ts:361-363`). The inspection and summary report the
live mode (`server/index.ts:286`, `server/thread-registry.ts:173`). And `GET /api/mode` answers what a
*fresh* thread starts in — `PICC_DEFAULT_PERMISSION_MODE` and the full set — before any run exists
(`server/index.ts:263-272`). The run receipt (`ZenPromptReceipt`, `packages/core/src/follow.ts:158-169`)
does **not** carry the mode; it carries `messageId`, `generation` and `queued` only.

**Shown by the browser, two views.** The snapshot's `permissionMode` becomes the `zen.mode` custom
event (`packages/web/src/follow-connection.ts:349`), routed to the per-thread mode store
(`custom-event-router.ts:49-51`). A mid-run change arrives as the `custom-entry` observation the mapper
emits for any custom entry (`rpc/map-events.ts:315-316`), routed as `zen.entry` to *both* views
(`custom-event-router.ts:42-47`): `permission-mode.tsx` (the composer's `<select>`, which says
`unknown` until a real value has arrived, `permission-mode.tsx:21-23,165-169`) and `mode-lines.ts`
(one transcript line per distinct value, worded as state, `mode-lines.ts:13-17,44-52`). Changing the
mode is a prompt: the select sends `/${mode}` (`chat-screen.tsx:288-292,314`), because the extension's
setter is closure-private and its commands are the only way in.

**Second implementation:** none of the walk. The four runtime fakes each return a literal
`permissionModeState` (`server-handler.test.ts:74`, `follow.test.ts:94`, `thread-registry.test.ts:47`,
`bundle-route.test.ts:27`), which proves the *server* needs only `{ mode, available }` — not that the
walk could be swapped. `packages/core/src/__tests__/permission-mode.test.ts` pins the walk's rule:
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

**L3, whole** (`.local/refactor/goals.md` §2): the mode concept is ours; the implementation is a
vendor extension read three layers away from it. Concretely, above the host:

- `@zen/core` knows the vendor's persisted shape — `customType: "modes"`, `data.mode` — and its
  registered set, and exports them under the vendor's name (`PICC_*`).
- The server answers `available` as that set (`server/index.ts:271`, `follow.ts:136`) rather than
  asking the runtime what modes exist.
- The browser reads the persisted entry itself, in two files, and its tooltip says whose default a
  fresh thread starts in (`permission-mode.tsx:150`). The composer switches mode by sending the
  vendor's slash command by name (`chat-screen.tsx:314`).

One definition, three readers, is the mitigation in place: the shape is spelled in
`permission-mode.ts` and nowhere else, so a vendor rename lands on every side at once or on none
(`permission-mode.ts:17`). The leak is inventory (seven allowlist lines), not surprise.

## Pivot cost

**Replace the mode extension** and the files that change are exactly the allowlist's: `permission-mode.ts`
(the shape and the set), `index.ts` (the names), `server/index.ts` and `server/follow.ts` (the cold
`available`), `permission-mode.tsx` and `mode-lines.ts` (the browser's two readers) — plus
`agent-host.ts` (the walk over the branch and the command-name intersection) and `chat-screen.tsx` (the
slash command the select sends), which the gate does not name because the host may say the vendor's
name and the screen does so only in a comment. `ZenFollowSnapshot`, the inspection, the summary, the
router and the store's fold do not change: they hold `{ mode, available }` and the four fakes prove the
server runs on that alone.

**Fix L3** (#162 workstream 4; goals §3.2: "the mode is `ZenPermissionMode` with picc as *an*
implementation the host adapts") and what moves is: the walk, the `customType`, the registered set and
the slash-command translation go *below* `ThreadRuntime.permissionModeState`, into the host, next to
`permission-dialog.ts`; `@zen/core` keeps `ZenPermissionModeState` and gains the mode's own vocabulary;
the server's cold path asks the host rather than a constant; the browser's `zen.entry` readers stop
knowing a custom entry's shape and take the mode from a mode observation; changing the mode becomes a
control route rather than a prompt. Six allowlist lines are deleted; `guard.ts`'s stays.
