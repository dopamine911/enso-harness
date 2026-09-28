import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { EnsoRecordedModel } from './thread-runtime.ts'

/**
 * The run conditions pi does not record (#435, Lineage #126 receipt steps 3 and 5), and the
 * fork point a thread's manifest assembles from them.
 *
 * ⚠ AN ENTRY IN pi's LOG, WRITTEN ONLY ON CHANGE. The harness's `run-context` extension computes
 * a record at every prompt's run start (`before_agent_start`, loaded LAST so every earlier
 * handler's change to the skills and context files is in) and appends it with `pi.appendEntry`
 * only when a field differs from the last {@link ENSO_RUN_CONTEXT_ENTRY} on the branch. A fork
 * inherits the entries on its path, so a fork's first run appends only if something changed. pi's
 * context builder skips `custom` entries: the model never sees it. A #436 Continue records none:
 * pi emits no `before_agent_start` for it, so the latest record is the cut-off run's.
 *
 * ⚠ HASHES, NEVER CONTENTS. A context file is its path and a sha256 of what the model received;
 * the config is a sha256 of the resolved `EnsoConfig` (stable key order) and the files it came
 * from; the mode is a sha256 of picc's persisted rule set. No secret and no file body is written.
 * The mode NAME stays picc's own record (`modes`), read beside this one (#126 decision 3).
 */

/**
 * The `customType` the run context is persisted under.
 *
 * @group Run context
 */
export const ENSO_RUN_CONTEXT_ENTRY = 'enso-run-context' as const

/** A lowercase hex sha256. */
const Sha256 = Type.String({ pattern: '^[0-9a-f]{64}$' })

/**
 * What one run started under. `git` is `null` when git could not name the revision — `rev-parse
 * HEAD` failed or ran past 5 s, whatever the reason: no repository, no commit yet, no git, a
 * timeout (PR #439 review). A `status` that fails keeps the revision and records `dirty: true`: it
 * cannot say the tree is clean. `mode` is `null` when the branch carries no persisted mode (no
 * permission-mode extension loaded) or one without picc's rule fields.
 *
 * @group Run context
 */
export const EnsoRunContext = Type.Object(
  {
    git: Type.Union([
      Type.Object(
        {
          /** `git rev-parse HEAD` in the session's cwd. */
          revision: Type.String({ minLength: 1 }),
          /** `git status --porcelain` printed anything. */
          dirty: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    config: Type.Object(
      {
        /** sha256 of the resolved config (or of why it could not be read), keys sorted. */
        hash: Sha256,
        /** The config files it was read from, user first; empty when none exists. */
        sources: Type.Array(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    /** The skills the prompt offers, sorted by name then path. */
    skills: Type.Array(
      Type.Object(
        { name: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
    /** The context files the model receives, in prompt order. */
    contextFiles: Type.Array(
      Type.Object({ path: Type.String({ minLength: 1 }), sha256: Sha256 }, { additionalProperties: false }),
    ),
    /**
     * sha256 of the mode's rule set, from the branch's last `modes` entry; `null` when there is none,
     * or when it carries none of the rule fields (the entry's shape moved: unknown, never a hash of nothing).
     */
    mode: Type.Union([Type.Object({ rulesHash: Sha256 }, { additionalProperties: false }), Type.Null()]),
  },
  { additionalProperties: false },
)
/** @group Run context */
export type EnsoRunContext = Static<typeof EnsoRunContext>

const runContextValidator = Compile(EnsoRunContext)

/**
 * The run context a custom entry records, or undefined when the entry is another extension's or
 * malformed — an entry is a wire crossing, and a bad one records nothing.
 *
 * @group Run context
 */
export function readEnsoRunContext(customType: string, data: unknown): EnsoRunContext | undefined {
  return customType === ENSO_RUN_CONTEXT_ENTRY && runContextValidator.Check(data) ? data : undefined
}

/**
 * A thread's fork point (#435): who it is and what it runs under, assembled from its branch —
 * what `GET /api/threads/:threadId/manifest` answers and the debug drawer lists. Two forks of one
 * thread differ outside `identity` only where their conditions do.
 *
 * @group Run context
 */
export const EnsoForkPoint = Type.Object(
  {
    identity: Type.Object(
      {
        /** The pi session id. */
        threadId: Type.String({ minLength: 1 }),
        /** The branch's last entry; `null` for an empty branch. */
        leafEntryId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        /** The thread it was forked from (#433), when its parent's file is still there. */
        parentThreadId: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    conditions: Type.Object(
      {
        /** What the branch records it last ran on (#434); `null` halves for a branch that recorded none. */
        model: EnsoRecordedModel.properties.model,
        thinkingLevel: EnsoRecordedModel.properties.thinkingLevel,
        /** The permission mode the branch's last `modes` entry names (picc's record); its initial one without. */
        mode: Type.String({ minLength: 1 }),
        cwd: Type.String({ minLength: 1 }),
        /**
         * The branch's latest run context; `null` before its first run, or when the newest record
         * does not read (another schema's): an older one is not the current conditions.
         */
        runContext: Type.Union([EnsoRunContext, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
/** @group Run context */
export type EnsoForkPoint = Static<typeof EnsoForkPoint>
