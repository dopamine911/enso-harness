# Seam: the permission mode

The policy a run's tools execute under, as the server reads it and the browser shows it. Glossary
domain: **Permission** (the mode *concept*: what may run without asking) with one foot in **Thread**
(the custom entry that records it) and one in **Observation** (the receipt that carries it).

Since #496 the engine is a vendor extension, `@gotgenes/pi-permission-system`, and the modes are
Enso's. The engine has no modes. It decides every tool call against one policy, the user's
`ENSO_HOME/permissions.json`, and it has a per-session **agent**: the last `active_agent` custom entry
in a session names it, and that agent's `permission` block is merged over the policy for that
session. So a mode is an agent preset Enso owns (`packages/core/src/permission-modes.ts`), and setting one is
appending the entry. Enso's permission-modes extension (`packages/harness/extensions/permission-modes/`)
appends it, and answers `auto`'s asks. The host reads the entry back below the `AgentHost` /
`ThreadRuntime` seam and emits the `permission-mode` observation on a change; the browser folds that
alone; changing the mode is a control route. Leak **L3**, closed by #162 workstream 4, stays closed:
nothing above the host reads the entry.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/permission-mode.md`.

## The contract

What crosses to the browser: the mode a run is in, and the modes it may switch to — at run start as
the receipt, and on every change as the observation, one shape for both.

<!-- source: packages/core/src/permission-mode.ts#EnsoPermissionModeState -->
```ts
/**
 * The receipt a run starts with (#84) — and the value of the `permission-mode` CUSTOM chunk that
 * carries it to the browser, at run start and on every change.
 *
 * `mode` is the current mode; `available` is what the mode dropdown may offer: the modes the
 * runtime's mode extension registers, intersected with the commands this session actually
 * registers, in the extension's order (the host decides).
 */
export const EnsoPermissionModeState = Type.Object({
  mode: Type.String({ minLength: 1 }),
  available: Type.Array(Type.String({ minLength: 1 })),
})
```

<!-- source: packages/core/src/observation.ts#EnsoPermissionMode -->
```ts
/**
 * The permission mode changed, and what a run may switch to now (#162 workstream 4, L3).
 *
 * The HOST emits this when its mode extension persists a change — the one observation the
 * browser reads the mode from mid-run, so no surface knows which extension's entry it was or
 * what that entry looks like. The same `{ mode, available }` a run starts with
 * (`EnsoPermissionModeState`): one shape for the receipt and for the change.
 */
export const EnsoPermissionMode = Type.Object({
  kind: Type.Literal('permission-mode'),
  ...EnsoPermissionModeState.properties,
})
```

And what crosses the other way — the one thing the browser may say about the mode:

<!-- source: packages/core/src/permission-mode.ts#EnsoPermissionModeChange -->
```ts
/**
 * The body of `POST /api/threads/:threadId/mode` (L3 step C): the mode to switch to.
 *
 * A control route, not a prompt — the server refuses a mode the thread does not offer (422) and
 * a busy thread (409); the change itself arrives on the follow as `permission-mode`, never from
 * the click.
 */
export const EnsoPermissionModeChange = Type.Object({
  mode: Type.String({ minLength: 1 }),
})
```

## The modes

Five modes, in the menu's order. Every mode is the agent `enso-mode-<mode>`, whose file
`preparePermissionPolicy` writes to `<agentDir>/agents/` at every launch
(`core/src/permission-modes.ts#modeAgentFile`). `default`'s file has no `permission` block: the
user's policy as written.

⚠ `default` is a named, empty agent, never `name: null`. The engine resolves a `null` entry by
falling back to the last agent it resolved in that session, so `null` after `/bypassPermissions`
kept bypass enforced while Enso said `default` (found in review, pinned by `agent-host.test.ts`).

| Mode | Preset over the policy | Summary (the menu's, and the Features page's) |
|---|---|---|
| `default` | none | the policy in `permissions.json`, as written |
| `acceptEdits` | `edit`, `write` and `path_write` allowed | edits and writes inside the project run without asking |
| `plan` | `edit` and `write` denied, as strings, so a user's own `edit` allow cannot reopen them | read and explore; the edit and write tools are denied |
| `bypassPermissions` | every surface allowed, `external_directory_*` included | everything runs without asking, except what your own rules deny or ask |
| `auto` | as `acceptEdits`, plus the classifier link (below) | edits run as in acceptEdits; a classifier model answers what would ask |

**A mode changes only Enso's catch-all, `**`, never a rule the user wrote (#499).** The engine
merges a preset over the user's policy key by key, and rules are last-match-wins: a preset key the
user's map already has is replaced where it stands, but a key the map lacks is appended after all
the user's rules and beats them. That is how `bypassPermissions` once allowed a command the user
had denied. So every preset map holds the one key `**`, the seed starts every map with it, and the
launch puts it first in any user map a preset touches, a string surface included
(`core/src/permission-rules.ts#withCatchAllFirst`). The value it gets is what the engine would fall
back to anyway, so the default mode decides exactly as before (probed across five user policies).
The engine matches `**` exactly as `*`, but reports it as its own pattern, which is also what lets
`auto` tell Enso's catch-all from the user's rules (#498).

The names and the intent are Claude Code's
([permission modes](https://code.claude.com/docs/en/permission-modes)): a deny or ask rule the user
wrote holds in every mode, `bypassPermissions` included, and in `auto` a classifier stands in for
the user everywhere else. oh-my-pi's approval modes put the user's rules above the mode the same
way. Where Enso differs: `acceptEdits` allows no bash commands (Claude Code's allows `mkdir`,
`touch`, `rm`, `mv`, `cp` and `sed`; allowing them here means adding patterns, the #499 bug);
`plan` has no plan-approval step and runs no classifier; `bypassPermissions` still asks in the two
cases *Known gaps* names.

<!-- source: packages/core/src/permission-modes.ts#ENSO_PERMISSION_MODES -->
```ts
/**
 * The modes, in the order the mode menu shows them.
 */
export const ENSO_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const
```

<!-- source: packages/core/src/permission-modes.ts#ENSO_MODE_PRESETS -->
```ts
/**
 * Each mode's preset.
 *
 * ⚠ `bypassPermissions` still asks in two places, because gotgenes floors them to `ask` whatever
 * the rules say: a command run through a wrapper (`bash -c`, `sudo`, `eval`) and a command its
 * parser cannot read. A deny or ask the user wrote keeps deciding in every mode.
 *
 * ⚠ `plan` denies the edit and write TOOLS. A redirect from an allowlisted bash command
 * (`cat a > b`) still writes inside the project, because the seed allows `path_write` there
 * (`permission-rules.ts#ENSO_DEFAULT_PERMISSION_POLICY` says why).
 */
export const ENSO_MODE_PRESETS: Readonly<Record<EnsoPermissionModeName, ModePreset>> = {
  default: {
    summary: 'the policy in permissions.json, as written',
    permission: {},
  },
  acceptEdits: {
    summary: 'edits and writes inside the project run without asking',
    permission: EDITS_ALLOWED,
  },
  plan: {
    summary: 'read and explore; the edit and write tools are denied',
    permission: { edit: 'deny', write: 'deny' },
  },
  bypassPermissions: {
    summary: 'everything runs without asking, except what your own rules deny or ask',
    permission: {
      '*': 'allow',
      edit: { [ENSO_CATCH_ALL]: 'allow' },
      write: { [ENSO_CATCH_ALL]: 'allow' },
      path_read: { [ENSO_CATCH_ALL]: 'allow' },
      path_write: { [ENSO_CATCH_ALL]: 'allow' },
      external_directory_read: { [ENSO_CATCH_ALL]: 'allow' },
      external_directory_write: { [ENSO_CATCH_ALL]: 'allow' },
      bash: { [ENSO_CATCH_ALL]: 'allow' },
    },
  },
  auto: {
    summary: 'edits run as in acceptEdits; a classifier model answers what would ask',
    permission: EDITS_ALLOWED,
  },
}
```

⚠ How the merge treats a preset (the module header of `core/src/permission-modes.ts`): a surface given
as a map is merged key by key, so the user's own later rules (the `.env` deny) still decide after a
preset's `"*": allow`; a surface given as a string replaces the user's whole surface.

## How a mode is set, and read

**Set:** the extension registers one command per mode, named exactly the mode (`/default`,
`/acceptEdits`, `/plan`, `/bypassPermissions`, `/auto`), and `/mode`, which takes a name or offers a
menu (`permission-modes/index.ts#createPermissionModes`). Each appends
`{ customType: 'active_agent', data: { name: modeAgentName(mode) } }`, `default` included.
The engine reads it at the next tool call. The host sets a mode by running that command as a prompt:

<!-- source: packages/web/src/host/permission-mode-adapter.ts#modeCommand -->
```ts
/**
 * How a mode is SET (L3 step C): the extension's per-mode slash command, named exactly the
 * mode, run as a prompt. The command appends the `active_agent` entry, so the mode is recorded
 * where the engine reads it.
 *
 * The host runs this for `ThreadRuntime.setPermissionMode`; nothing above the seam spells a
 * command.
 */
export function modeCommand(mode: string): string {
  return `/${mode}`
}
```

**Read:** the entries in file order, the last `active_agent` entry winning. That is the walk the
engine makes, so the mode shown is the mode enforced, even after `/tree` moves the leaf.

<!-- source: packages/core/src/permission-modes.ts#recordedPermissionMode -->
```ts
/**
 * The mode a session is in, from its entries: the LAST `active_agent` entry wins, and a session
 * with none is in `default`.
 *
 * ⚠ Walk the session's ENTRIES in file order, not its branch. That is what gotgenes walks
 * (`session/active-agent.ts#getActiveAgentName`), so the mode shown is the mode enforced, even
 * after `/tree` moves the leaf.
 *
 * ⚠ An `active_agent` entry naming someone else's agent is skipped here, but gotgenes would apply
 * that agent. Only Enso writes the entry in an Enso session; this is the reading to revisit if
 * that ever changes.
 */
export function recordedPermissionMode(entries: readonly unknown[]): EnsoPermissionModeName {
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position]
    if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'custom') continue
    const recorded = readRecordedMode(entry)
    if (recorded !== undefined) return recorded
  }
  return ENSO_DEFAULT_PERMISSION_MODE
}
```

<!-- source: packages/core/src/permission-modes.ts#readRecordedMode -->
```ts
/**
 * The mode ONE session entry records, or undefined when the entry is not an `active_agent`
 * entry, is malformed, or names an agent that is not one of Enso's modes.
 *
 * Reads defensively, as every wire crossing does: an unrelated custom entry is ignored, never a
 * throw inside a stream loop.
 */
export function readRecordedMode(entry: unknown): EnsoPermissionModeName | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  if (!('customType' in entry) || entry.customType !== ACTIVE_AGENT_CUSTOM_TYPE) return undefined
  if (!('data' in entry) || typeof entry.data !== 'object' || entry.data === null) return undefined
  if (!('name' in entry.data)) return undefined
  const { name } = entry.data
  // Not written any more (see the module's ⚠); read as `default`, which is what it asked for.
  if (name === null) return ENSO_DEFAULT_PERMISSION_MODE
  if (typeof name !== 'string' || !name.startsWith(MODE_AGENT_PREFIX)) return undefined
  const mode = name.slice(MODE_AGENT_PREFIX.length)
  return isModeName(mode) ? mode : undefined
}
```

The host's three readings, so the server never spells the set: a live session's, a fresh thread's
and a stored one's.

<!-- source: packages/web/src/host/permission-mode-adapter.ts#livePermissionModeState -->
```ts
/**
 * A LIVE session's state (#84): the mode from the session's entries, and the modes it
 * registered a command for.
 *
 * ⚠ `entries` is `sessionManager.getEntries()`, NOT `getBranch()`: the engine walks every entry
 * in file order, so after `/tree` moves the leaf the branch's last entry can name a mode the
 * engine is not enforcing (`recordedPermissionMode`'s ⚠). Re-walked on every call, never
 * cached: entries only grow, but a cache is one more thing to keep in step for microseconds.
 */
export function livePermissionModeState(
  entries: readonly unknown[],
  registeredCommands: ReadonlySet<string>,
): EnsoPermissionModeState {
  return {
    mode: recordedPermissionMode(entries),
    available: ENSO_PERMISSION_MODES.filter((mode) => registeredCommands.has(mode)),
  }
}
```

<!-- source: packages/web/src/host/permission-mode-adapter.ts#freshPermissionModeState -->
```ts
/**
 * What a FRESH thread starts in (#84): `default`, and every mode.
 *
 * Honest by construction — a new thread is a new session file with no `active_agent` entry —
 * and served before any run exists, so the header reads `default` from the first paint rather
 * than `unknown`.
 */
export function freshPermissionModeState(): EnsoPermissionModeState {
  return { mode: ENSO_DEFAULT_PERMISSION_MODE, available: [...ENSO_PERMISSION_MODES] }
}
```

<!-- source: packages/web/src/host/permission-mode-adapter.ts#storedPermissionModeState -->
```ts
/**
 * A STORED thread's state, from its transcript alone (#95): the last `active_agent` entry for
 * the mode, and every mode for `available`; no session is built to ask what it registers (#86's
 * rule: looking must not build).
 *
 * ⚠ The stored transcript is the BRANCH (`readStoredThread`), not every entry. The two agree
 * unless `/tree` moved the leaf past a mode change; the live walk is the one the engine enforces,
 * and it replaces this reading as soon as the thread runs.
 */
export function storedPermissionModeState(transcript: readonly EnsoTranscriptEntry[]): EnsoPermissionModeState {
  for (let position = transcript.length - 1; position >= 0; position -= 1) {
    const entry = transcript[position]
    if (entry?.kind !== 'custom') continue
    const recorded = readRecordedMode({ customType: entry.customType, data: entry.data })
    if (recorded !== undefined) return { mode: recorded, available: [...ENSO_PERMISSION_MODES] }
  }
  return freshPermissionModeState()
}
```

## The policy file

`ENSO_HOME/permissions.json`, in the engine's format: a `permission` block mapping a tool or surface
(`read`, `edit`, `bash`, `path_read`, `path_write`, `external_directory`, …, and `"*"` for anything
unnamed) to `allow`, `ask` or `deny`, or to a map from pattern to one of those, where the last
matching pattern wins. Beside it, `authorizerChain` names the links an ask passes through before it
reaches the user.

**The seed.** A fresh `ENSO_HOME` gets Enso's default: reads and searches run, edits and writes ask,
bash asks except a read-only allowlist, a few git escapes are denied, `.env` files are denied to
every tool, and `auto`'s link is in the chain.

<!-- source: packages/core/src/permission-rules.ts#ENSO_DEFAULT_PERMISSION_POLICY -->
```ts
/**
 * The policy a fresh `ENSO_HOME` starts with.
 *
 * - **Tools:** reads and searches run, as do Enso's `ask_user` and `web_search`; edits and writes
 *   ask; anything unnamed asks (`"*"`), `web_fetch` included.
 * - **Catch-alls:** every map starts with Enso's catch-all, `**` (`ENSO_CATCH_ALL`): the one key a
 *   mode changes, and the pattern `auto` may answer. A rule a user adds after it is theirs, and
 *   beats every mode (#498, #499).
 * - **Bash:** asks, except gotgenes' documented read-only allowlist (its "Read-Only Bash Command
 *   Allowlist" recipe, trimmed of `less`/`more`, which can escape to a shell). The allowlist is
 *   safe to seed because gotgenes resolves a chain to its most restrictive part and floors
 *   wrappers (`sh -c`, `sudo`, `xargs`) to ask.
 * - **Git:** the escapes Enso's guards do not already refuse are denied (force-push is
 *   `cc-safety-net`'s `git.push-force`).
 * - **`.env` files:** denied for every tool and every bash command, through symlinks too.
 * - **Outside the project:** asks.
 * - **`auto` mode:** `authorizerChain` names Enso's classifier link. The link defers in every
 *   other mode, and a user who removes the name gets prompts in `auto`, never fewer.
 *
 * ⚠ `path_write` is `allow` inside the project on purpose. gotgenes checks a bash path argument
 * against BOTH directions unless the command is one of its pure readers, so `ask` here made
 * `git diff src/a.ts` ask (probed). The cost: an allowlisted command's redirect (`cat a > b`)
 * writes inside the project without asking. Writes outside still ask through
 * `external_directory`.
 *
 * ⚠ `git commit * -n*` is deliberately absent: it would also deny a commit whose MESSAGE contains
 * ` -n`. `-n` right after `commit` is still denied.
 */
export const ENSO_DEFAULT_PERMISSION_POLICY = {
  authorizerChain: [ENSO_AUTO_AUTHORIZER],
  permission: {
    '*': 'ask',
    read: 'allow',
    grep: 'allow',
    find: 'allow',
    ls: 'allow',
    edit: { [ENSO_CATCH_ALL]: 'ask' },
    write: { [ENSO_CATCH_ALL]: 'ask' },
    // Enso's own tools. Asking the user is itself the check; a search sends only a query through
    // the session's own provider. `web_fetch` reaches any URL, so it stays on the `*` ask.
    ask_user: 'allow',
    web_search: 'allow',
    path_read: { [ENSO_CATCH_ALL]: 'allow', ...ENV_FILES_DENIED, '*.env.example': 'allow' },
    path_write: { [ENSO_CATCH_ALL]: 'allow', ...ENV_FILES_DENIED },
    external_directory: { [ENSO_CATCH_ALL]: 'ask' },
    bash: {
      [ENSO_CATCH_ALL]: 'ask',
      'cat *': 'allow',
      'head *': 'allow',
      'tail *': 'allow',
      ls: 'allow',
      'ls *': 'allow',
      'tree *': 'allow',
      'stat *': 'allow',
      'wc *': 'allow',
      'du *': 'allow',
      'df *': 'allow',
      'grep *': 'allow',
      'rg *': 'allow',
      'find *': 'allow',
      'fd *': 'allow',
      'diff *': 'allow',
      'cmp *': 'allow',
      'sha256sum *': 'allow',
      pwd: 'allow',
      whoami: 'allow',
      'uname *': 'allow',
      date: 'allow',
      'which *': 'allow',
      'git status': 'allow',
      'git status *': 'allow',
      'git diff': 'allow',
      'git diff *': 'allow',
      'git log': 'allow',
      'git log *': 'allow',
      'git show *': 'allow',
      'git blame *': 'allow',
      'git ls-files *': 'allow',
      'git branch': 'allow',
      'git remote -v': 'allow',
      'git commit --no-verify*': 'deny',
      'git commit * --no-verify*': 'deny',
      'git commit -n*': 'deny',
      'git push --delete *': 'deny',
      'git push * --delete *': 'deny',
    },
  },
} as const
```

**The link.** The engine reads its policy from one path only, under pi's agent dir
(`core/src/permission-rules.ts#permissionEngineConfigPath`), with no setting to point it elsewhere.
So `preparePermissionPolicy` makes that path a symlink to the user's file. The engine follows the
link and stats the target, so an edit to `permissions.json` applies to running sessions at their next
check. A regular file found at the link's place (the engine's own settings screen saves by rename) is
moved aside to the first free `.bak`, `.bak.1` … name, never over an earlier one, and the launch log
says where. Two launches racing to make the link both succeed. A `permissions.json` that is a link
to nothing refuses the launch rather than being written through.

**The old format.** A file from before #496 held its rules as `permissions` `allow` / `deny` / `ask`
lists. It is moved aside as `permissions.json.picc-backup` (never over an earlier backup:
`.picc-backup.1` …) and replaced whole by the seed; its rules are not carried over, and the launch
log names the backup (`core/src/permission-rules.ts#describePermissionPolicy`). Two launches
migrating the same file at once keep the user's rules in the first backup, and neither fails
(`core/src/permission-rules.ts#replacePiccRulesFile`, #497 review).
Claude Code's `~/.claude/settings.json` is never read.

**Unreadable refuses the launch.** A file that is not a JSON object (a comment counts: only plain
JSON is accepted) is left untouched, and both launch surfaces refuse to start, naming the file: the
host in `agent-host.ts#createAgentHost`, the terminal launcher in `scripts/enso.ts` before the spawn.

<!-- source: packages/core/src/permission-rules.ts#preparePermissionPolicy -->
```ts
/**
 * Make `policyPath` a policy gotgenes will use as it is, and put it and the mode presets where
 * gotgenes reads them:
 * - keep a file that holds a `permission` block;
 * - seed one that is absent, holds none, or is a picc rules file;
 * - refuse one that is not a JSON object, touching nothing.
 *
 * Seeding keeps every other top-level key the file had, except a picc file, which is replaced
 * whole (its copy is kept beside it; `replacePiccRulesFile` names it).
 *
 * Call it before the extension loads, on both launch surfaces.
 */
export function preparePermissionPolicy(policyPath: string, agentDir: string): PermissionPolicyPreparation {
  const read = readPolicy(policyPath)
  if (read.kind === 'unreadable') return { kind: 'unreadable', path: policyPath, reason: read.reason }
  const preparation = preparePolicyFile(policyPath, read)
  // Another launch moved a picc file away first: read what is there now.
  if (preparation === undefined) return preparePermissionPolicy(policyPath, agentDir)
  const movedAside = linkEngineConfig(agentDir, policyPath)
  writeModeAgentFiles(agentDir)
  return movedAside === undefined ? preparation : { ...preparation, movedAside }
}
```

## `auto`

`auto` is `acceptEdits`' preset plus one authorizer link, `enso-auto`. The seed's `authorizerChain`
names it; the extension registers it for its own session only
(`permission-modes/index.ts#createPermissionModes`), because the engine's service map is
process-global and Enso runs many sessions in one process. An ask then goes to the link before the
user (`permission-modes/index.ts#authorize`):

- **Outside `auto`**, the link defers at once.
- **In `auto`**, it asks the session's own model whether the action stays within what the user asked
  for, under Enso's classifier prompt (`permission-modes/index.ts#ENSO_AUTO_CLASSIFIER_PROMPT`),
  written from Claude Code's description of its auto mode. `allow` runs the action; `block` denies
  it with a reason the agent reads.
- **It defers**, so the user is asked, when the ask was forwarded, when an explicit ask rule is behind
  it (`permission-modes/index.ts#explicitAskPattern`), with no model or no credentials, past the
  10-second deadline, on a reply it cannot read, or on any throw. Each of these deferrals is written
  to the engine's review log with its cause, as is every verdict.
- **The engine caps it.** A link's `allow` on the `path` and `external_directory` families becomes a
  deferral, so those asks reach the user whatever the classifier says.
- **A rule the user wrote defers to the user**, as Claude Code documents for explicit ask rules
  (#498). That includes a surface-wide rule (`bash: 'ask'`, or a `*` key), which the engine reports
  as `*`. Only Enso's own catch-all (`**`), the engine's synthesised fallback and its floors (`<…>`)
  go to the classifier (`permission-modes/index.ts#isExplicitPattern`).

A user who removes `enso-auto` from `authorizerChain` gets prompts in `auto`, never fewer.

## Who implements it, who consumes it

**Recorded by the guards and the mode extension, enforced by the engine.** The manifest loads the
engine, then the mode extension directly after it (`packages/harness/package.json`, `pi.extensions`).
The guards extension, the first `tool_call` participant, records every refusal the engine makes of
the agent's call — a person's No, a rule's deny, an authorizer's block — as `enso-permission-denial`
with the call's id (`guards/index.ts#observeSessionRisk`, #464; before #464 the mode extension
wrote a No as `enso-operator-denial`, which session eval still reads). The mode extension drops the
engine's forced system prompt every turn (#443), because a forced prompt replaces the sectioned one
Enso's system head is built from; no enforcement is lost, since pi lists only the tools the engine
left active. The prompt itself is an ordinary `select` and `input` dialog (`dialog.md`).

**Prepared on both launch surfaces.** `preparePermissionPolicy` runs before the engine loads: in
`createAgentHost` after `PI_CODING_AGENT_DIR` names the agent dir, and in `scripts/enso.ts` before the
spawn. The rules a run ran under are hashed into its run context (`mode.rulesHash`, #435): the
policy the engine reads with the preset of the session's mode.

**Read by the host, and only there.** `agent-host.ts#currentPermissionModeState` implements
`ThreadRuntime.permissionModeState` for a live thread: the walk over `sessionManager.getEntries()`, and
`ENSO_PERMISSION_MODES` filtered by the commands the session's extension runner registered for
`available` (read off the registry directly rather than through `listCommands`, whose call count the
refusal path's tests pin). For a thread that is not live, `AgentHost.freshPermissionMode()` and
`AgentHost.storedPermissionMode(transcript)` answer from the adapter. The stored reading walks the
BRANCH, the transcript `readStoredThread` gives; it can differ from the engine's only when `/tree`
moved the leaf past a mode change, and the live walk replaces it as soon as the thread runs.

**Consumed by the server, three ways — none of them spelling the entry.** The follow's snapshot
carries `permissionMode` (`src/follow.ts#EnsoFollowSnapshot`), filled from the live runtime or, for a
cold thread, from `host.storedPermissionMode(branch)`. That choice is made once, in
`packages/web/src/server/thread-read.ts` (`readThreadMount`), and the follow and the history route
both read it from there — one reader, so the two cannot answer differently about a thread that goes
live mid-read (#214). The inspection and summary report the live mode. And `GET /api/mode` answers
`host.freshPermissionMode()` before any run exists. The run receipt (`src/follow.ts#EnsoPromptReceipt`)
does **not** carry the mode.

**Said by the host, mid-run.** When the host's session subscription sees an `active_agent` entry
appended, it emits its own `permission_mode` event right after it (`host/agent-host.ts`, the session
subscription). The mapper carries it as the `permission-mode` observation
(`host/map-events.ts#mapPiEvent`, its `permission_mode` case), and `to-agui.ts` emits it as a CUSTOM
chunk named `permission-mode`. The entry itself still crosses as a `custom-entry` — recorded and
counted by the debug pane, rendered by nothing.

**Shown by the browser, two views, one feed.** The mode — off the snapshot
(`packages/web/src/follow-connection.ts`) and from every `permission-mode` observation — is routed to
*both* views (`custom-event-router.ts`): `permission-mode.tsx` (the composer's `<select>`, which says
`unknown` until a real value has arrived) and `mode-lines.ts` (one transcript line per distinct value).
**Changing the mode is a control route**: `POST …/mode` with `EnsoPermissionModeChange`
(`follow-connection.ts#changeMode`) → `changeThreadMode` (`server/follow.ts`: 409 while busy, 422 for
a mode the thread does not offer) → `ThreadRuntime.setPermissionMode` → the host runs `/<mode>` as a
prompt. The click moves no store.

**Print runs have no modes.** `scripts/print-harness.ts#buildPrintManifest` drops the engine from the
manifest, because with no UI it denies every ask. The mode extension stays; its commands then record
a mode nothing enforces. A print run has Enso's guards only.

**Second implementation:** the fakes (#178). `createFakeHostedThread` answers a literal
`permissionModeState` and `createFakeAgentHost` *declares* its fresh and stored modes
(`server/__tests__/fake-hosted-thread.ts`), which proves the server runs on `{ mode, available }`
alone. `permission-mode-adapter.test.ts` pins the walk below the seam, and the extension's tests pin
the link against fakes of the engine's service.

**Edited by Settings (#474).** The Permissions tab reads and writes the policy file through the
server's routes (listed in `docs/reference/routes.md`), which call the host's
`packages/web/src/host/permission-policy-file.ts`. A save
names the version it read (`If-Match`, as a prompt write does), gets Enso's `**` put first where a
mode needs it (`withCatchAllFirst`, the launch's own normalisation), is checked against the engine's
own schema in the host (`host/permission-policy.ts#policyProblems`) and refused with each problem's
place if the engine would not run it, then is written to a temporary file and renamed over, with its
modification time moved past the last one, so every running session reloads it at its next call.
Reset copies the file to the first free `permissions.json.bak[.N]` first. The per-mode view is a
MODEL of the engine's merge in core (`core/src/permission-policy.ts#effectiveRows`: the shorthand expansion,
then the preset merged key by key), pinned to the engine in every mode by `agent-host.test.ts`.
**Try a command** is not modelled: it asks the thread's own engine
(`HostedThread.checkPermission` → the engine's `getPermissionsService(sessionId).checkPermission`,
with the mode's agent name).

## Known gaps

Stated plainly; none is hidden by a mode.

- **An allowlisted command's redirect writes in-project without asking.** The seed allows
  `path_write` inside the project, because the engine checks a bash path argument in both
  directions and `ask` there made `git diff src/a.ts` ask. So `cat a > b` writes `b` unasked. Writes
  outside the project still ask through `external_directory`.
- **`bypassPermissions` still asks for wrappers and unparseable commands.** The engine floors a
  command run through `bash -c`, `sudo`, `eval` or `xargs`, and one its parser cannot read, to `ask`,
  whatever the rules say.
- **A file broken by hand mid-session reads as an empty policy.** The engine reads a file it cannot
  parse as no policy at all: every call asks, and the deny rules are gone until the file is fixed.
  The launch refuses an unreadable file, and Settings refuses to save one; nothing refuses one broken
  by hand while a session runs.
- **Enso's catch-all is put first at launch and on a Settings save only.** A map added or rewritten
  by hand without `**` while a session runs is read by the engine at once, but it only gets the
  catch-all at the next launch or save. Until then a mode's preset lands after that map's rules and
  beats them (#499).
- **The settings beside the rules reload per prompt, the rules per call.** The engine re-reads
  `yoloMode`, the review log and the other knobs at session start and at each prompt, but the
  `permission` block whenever the file's modification time changes. A saved `yoloMode` is in force
  from a running thread's next prompt, and Try a command answers as the engine does until then.
- **A hand edit in the same clock tick as the engine's last read can go unseen.** The engine keys its
  reload on the modification time alone, which Linux stamps from a coarse clock. A Settings save
  moves it past the last one; an editor does not, so such an edit is picked up at the next change.
- **In the terminal, a project with only `.pi/agents/` is trusted unasked.** The engine layers a
  project's `.pi/extensions/pi-permission-system/config.json` and its `.pi/agents/*.md` over the user's
  policy only when the project is trusted. The web host decides that itself and strictly (#502): an
  undecided project is untrusted, and asked about before its first run. The terminal follows pi's own
  decision, which counts a project with none of pi's trust-gated files (`.pi/settings.json`,
  `extensions`, `skills`, …) as trusted without asking — and `.pi/agents/` is not on that list, so
  such a repository can redefine an `enso-mode-*` agent there (#510).

## What fences it

- **The vendor gate** (`test/vendor-gate.test.ts`, #145): the engine's name may appear in code only
  under `packages/web/src/host/` and `packages/harness/extensions/`; every other file that spells it
  is one allowlist line with its reason.
- **The tool-call participants tripwire**
  (`packages/harness/extensions/__tests__/tool-call-participants.test.ts`) names the engine as the
  second of exactly two `tool_call` handlers, so it cannot be silently replaced by a third — see the
  guards page. The mode extension registers none.
- **The glossary** decides the vocabulary is ours: *permission mode*, *mode*, *permission policy*.

## What crosses it that should not

**The engine's formats, in `@enso/core`.** Above the host no surface reads the entry, spells the set
or names a command; what the browser knows is `EnsoPermissionModeState` in,
`EnsoPermissionModeChange` out. But `permission-modes.ts` (on the `@enso/core` barrel) spells the engine's `active_agent`
entry and its agent-file frontmatter, and `@enso/core/permission-rules` writes its policy format and
its config path, because both launch surfaces (the host and `scripts/enso.ts`) prepare the files
before the engine loads, and core is what they share.

**The engine's merge, modelled in `@enso/core`** (#474). `permission-policy.ts` re-states how the
engine expands `path` / `external_directory` and merges a mode's preset, so Settings can show every
mode without a session in each. It is a second copy of engine behaviour, held to the first by
`agent-host.test.ts` in all five modes; a verdict for a given value is never modelled.

## Pivot cost

**Replace the engine** and the files that change are `packages/core/src/permission-modes.ts` (how a mode is
recorded and what a preset looks like), `@enso/core/permission-rules` (the policy format, the seed and
where the engine reads it), the permission-modes extension (the commands' entry and the `auto` link),
and the manifest line in `packages/harness/package.json` with `scripts/print-harness.ts`'s filter.
Settings' part is `@enso/core`'s `permission-policy.ts` (the modelled merge), and the host's schema
check and `checkPermission`.
The host's adapter and `agent-host.ts` read through core and do not change unless the new engine
records a mode some other way. Nothing above the host changes: `EnsoFollowSnapshot`, the inspection,
the summary, the router, the store's fold and both server cold paths hold `{ mode, available }`, and
the fakes prove the server runs on that alone. #496 was that pivot, and it is the measure.

**Fix L3** (#162 workstream 4) was done in three steps before it: the walk and the set went below the
seam (A), the host began emitting `permission_mode` so the browser stopped reading the entry (B), and
the mode became a control route (C).
