import { type Static, Type } from 'typebox'
import { EnsoThreadTreeMode } from './config.ts'

/**
 * A project's settings in tiers (#752, slice #754), as Claude Code tiers its own: the user's
 * `~/.enso/config.json` for every project, the project's shared `<project>/.enso/config.json`
 * (committed with it), and the project-local `<project>/.enso/config.local.json` (gitignored: one
 * person's overrides for one project). A key resolves local > shared > user > Enso's default, the
 * whole value from one tier: a list set in a higher tier REPLACES a lower tier's, never extends it.
 * The project tiers are read only once the project is trusted, as before.
 *
 * Slice #754 tiers the `threads` keys a new tree needs: its mode, the files copied into it and the
 * commands run in it. #753 protects the two project tiers, which the agent works beside: what applies
 * from each is the CONTENTS THE OPERATOR APPROVED on the project page, never the file as it is now
 * (`@enso/core/project-config`). A file that changed after its approval — by a tool, a shell
 * command, a commit or a pull — is shown there as a diff with **Approve**, and until then the
 * approved version applies; a file never approved applies nothing.
 */

/**
 * Where a resolved value came from: a config tier, or Enso's own default when no tier sets it.
 *
 * @group Project settings
 */
export const EnsoConfigTier = Type.Union([
  Type.Literal('default'),
  Type.Literal('user'),
  Type.Literal('shared'),
  Type.Literal('local'),
])
/** @group Project settings */
export type EnsoConfigTier = Static<typeof EnsoConfigTier>

/**
 * The tiers the project page writes: the project's own files. The user tier is edited where it
 * always was.
 *
 * @group Project settings
 */
export const EnsoProjectTier = Type.Union([Type.Literal('shared'), Type.Literal('local')])
/** @group Project settings */
export type EnsoProjectTier = Static<typeof EnsoProjectTier>

const Commands = Type.Array(Type.String({ minLength: 1 }))
const Paths = Type.Array(Type.String({ minLength: 1 }))

/**
 * A new tree's settings for one project, each with the tier it resolved from.
 *
 * @group Project settings
 */
export const EnsoProjectThreadSettings = Type.Object(
  {
    /** The tree a new thread gets: `worktree`, `copy`, or `off` (it runs in the checkout). */
    tree: Type.Object({ value: EnsoThreadTreeMode, tier: EnsoConfigTier }, { additionalProperties: false }),
    /** Commands run in a new tree, in order, with the tree as their working directory. */
    setup: Type.Object({ value: Commands, tier: EnsoConfigTier }, { additionalProperties: false }),
    /** Gitignored files and directories copied from the project into a new tree, relative to the project. */
    copy: Type.Object({ value: Paths, tier: EnsoConfigTier }, { additionalProperties: false }),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectThreadSettings = Static<typeof EnsoProjectThreadSettings>

/**
 * `GET /api/projects/<projectId>/settings`: what the project page shows.
 *
 * @group Project settings
 */
export const EnsoProjectSettings = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    /** The project's canonical path. */
    path: Type.String({ minLength: 1 }),
    /** Whether its own tiers are read. Untrusted, every value is the user tier's or the default. */
    trusted: Type.Boolean(),
    threads: EnsoProjectThreadSettings,
    /** The file behind each tier, so the page can name where a value lives. */
    files: Type.Object(
      {
        user: Type.String({ minLength: 1 }),
        shared: Type.String({ minLength: 1 }),
        local: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    /**
     * The project's own tier files that are there and could not be read (not JSON, or not a config
     * this version reads). Each is skipped: its values come from the tiers below until it is fixed.
     */
    unreadable: Type.Array(
      Type.Object(
        { tier: EnsoProjectTier, path: Type.String({ minLength: 1 }), reason: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectSettings = Static<typeof EnsoProjectSettings>

/**
 * `PUT /api/projects/<projectId>/settings`: set or clear `threads` keys in one of the project's
 * own tiers. A key absent is left as it is; `null` removes it from that tier, so the next tier's
 * value shows through. Every other key in the file is kept. Answered with the new `EnsoProjectSettings`.
 *
 * @group Project settings
 */
export const EnsoProjectSettingsUpdate = Type.Object(
  {
    tier: EnsoProjectTier,
    threads: Type.Object(
      {
        tree: Type.Optional(Type.Union([EnsoThreadTreeMode, Type.Null()])),
        setup: Type.Optional(Type.Union([Commands, Type.Null()])),
        copy: Type.Optional(Type.Union([Paths, Type.Null()])),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectSettingsUpdate = Static<typeof EnsoProjectSettingsUpdate>

/**
 * One of a project's own tier files that is there, as the trust confirmation names it (#873): the
 * setup commands it declares, as written — absent when it sets none — or why it was not read. Read
 * for DISPLAY, trusted or not: reading it applies nothing and runs nothing.
 *
 * @group Project settings
 */
export const EnsoProjectTierFile = Type.Union([
  Type.Object(
    { tier: EnsoProjectTier, path: Type.String({ minLength: 1 }), setup: Type.Optional(Commands) },
    { additionalProperties: false },
  ),
  Type.Object(
    { tier: EnsoProjectTier, path: Type.String({ minLength: 1 }), unread: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
])
/** @group Project settings */
export type EnsoProjectTierFile = Static<typeof EnsoProjectTierFile>

/**
 * `GET` and `PUT /api/projects/<projectId>/trust` (#873): whether a new thread or tree of the
 * project reads its own files, and the files trust would turn on, the local tier first.
 *
 * @group Project settings
 */
export const EnsoProjectTrust = Type.Object(
  {
    projectId: Type.String({ minLength: 1 }),
    /** The project's canonical path: the key pi's `trust.json` holds the decision under. */
    path: Type.String({ minLength: 1 }),
    trusted: Type.Boolean(),
    files: Type.Array(EnsoProjectTierFile),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectTrust = Static<typeof EnsoProjectTrust>

/**
 * `PUT /api/projects/<projectId>/trust` (#873): trust the project, or revoke it. A revoke is saved
 * as an explicit "not trusted", never a deletion: pi takes the nearest ancestor's decision when a
 * path has none, so a deletion under a trusted folder would leave the project trusted.
 *
 * @group Project settings
 */
export const EnsoProjectTrustUpdate = Type.Object({ trusted: Type.Boolean() }, { additionalProperties: false })
/** @group Project settings */
export type EnsoProjectTrustUpdate = Static<typeof EnsoProjectTrustUpdate>

/**
 * Where one of the project's own tiers stands against what the operator approved (#753):
 * - `approved` — the file is the version approved, and it applies;
 * - `changed` — it differs from the version approved, which applies until the change is approved;
 * - `removed` — it is gone, and the version approved applies until the removal is approved;
 * - `unapproved` — it was never approved: nothing in it applies.
 *
 * @group Project settings
 */
export const EnsoProjectTierApprovalState = Type.Union([
  Type.Literal('approved'),
  Type.Literal('changed'),
  Type.Literal('removed'),
  Type.Literal('unapproved'),
])
/** @group Project settings */
export type EnsoProjectTierApprovalState = Static<typeof EnsoProjectTierApprovalState>

/** A file's SHA-256, as an approval names it. */
const Sha256 = Type.String({ pattern: '^[0-9a-f]{64}$' })

/**
 * One of the project's own tiers whose file is not the version approved (#753), as a thread is told
 * it: the tier, its file, and how it differs.
 *
 * @group Project settings
 */
export const EnsoProjectTierPending = Type.Object(
  {
    tier: EnsoProjectTier,
    path: Type.String({ minLength: 1 }),
    state: Type.Union([Type.Literal('changed'), Type.Literal('removed'), Type.Literal('unapproved')]),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectTierPending = Static<typeof EnsoProjectTierPending>

/**
 * One of the project's own tiers as its page reviews it (#753): its state, the file's hash as read
 * now — what an approval names, so the operator approves what they saw — and the diff from the
 * approved version to it.
 *
 * @group Project settings
 */
export const EnsoProjectTierReview = Type.Object(
  {
    tier: EnsoProjectTier,
    path: Type.String({ minLength: 1 }),
    state: EnsoProjectTierApprovalState,
    /** The file's SHA-256 now; `null` when there is no file. */
    current: Type.Union([Sha256, Type.Null()]),
    /** A unified diff (git's hunk format) from the approved version — none is empty — to the file now; `''` when they agree. */
    patch: Type.String(),
    /** Why the file cannot be approved as it is (too large, unreadable, not a config Enso reads): fix it first. */
    problem: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectTierReview = Static<typeof EnsoProjectTierReview>

/**
 * `GET /api/projects/<projectId>/config-approval` (#753): each of the project's own tiers that has a
 * file or an approval, the local tier first.
 *
 * @group Project settings
 */
export const EnsoProjectConfigReview = Type.Object(
  { projectId: Type.String({ minLength: 1 }), tiers: Type.Array(EnsoProjectTierReview) },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectConfigReview = Static<typeof EnsoProjectConfigReview>

/**
 * `PUT /api/projects/<projectId>/config-approval` (#753): approve one tier's file as the page showed
 * it, by its hash — `null` approves its removal. A file that changed since is refused (409), so
 * nothing is approved unseen. Answered with the new `EnsoProjectConfigReview`.
 *
 * @group Project settings
 */
export const EnsoProjectConfigApproval = Type.Object(
  { tier: EnsoProjectTier, sha256: Type.Union([Sha256, Type.Null()]) },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoProjectConfigApproval = Static<typeof EnsoProjectConfigApproval>

/**
 * One setup command as it ran in a new tree.
 *
 * @group Project settings
 */
export const EnsoTreeSetupStep = Type.Object(
  {
    command: Type.String({ minLength: 1 }),
    /** Its exit code; `null` when it was killed (its time ran out) or could not start. */
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    durationMs: Type.Integer({ minimum: 0 }),
    /** stdout and stderr interleaved, redacted, its tail kept when longer than the bound. */
    output: Type.String(),
    /** True when `output` is only the tail. */
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoTreeSetupStep = Static<typeof EnsoTreeSetupStep>

/**
 * What preparing a new tree did (#754), recorded on the thread (`ENSO_TREE_SETUP_ENTRY`) and served
 * with its tree (`EnsoThreadPages.setup`). `ok` is false when a file to copy is missing or a command
 * failed; the commands stop at the first failure, and the thread still opens.
 *
 * @group Project settings
 */
export const EnsoTreeSetupOutcome = Type.Object(
  {
    ok: Type.Boolean(),
    /** Paths copied into the tree, as configured. */
    copied: Type.Array(Type.String()),
    /** Paths configured to copy that the project does not have. */
    missing: Type.Array(Type.String()),
    steps: Type.Array(EnsoTreeSetupStep),
    /** The tier each list came from, so a failure says which file to fix. */
    tiers: Type.Object({ setup: EnsoConfigTier, copy: EnsoConfigTier }, { additionalProperties: false }),
    /**
     * The project's own tiers whose file was not the version approved when the tree was made (#753):
     * the tree was made from the approved version, or without the file. Absent when there were none.
     */
    pending: Type.Optional(Type.Array(EnsoProjectTierPending)),
  },
  { additionalProperties: false },
)
/** @group Project settings */
export type EnsoTreeSetupOutcome = Static<typeof EnsoTreeSetupOutcome>

/**
 * The custom session entry that records a new tree's setup, appended after its tree record.
 *
 * @group Project settings
 */
export const ENSO_TREE_SETUP_ENTRY = 'enso-tree-setup'
