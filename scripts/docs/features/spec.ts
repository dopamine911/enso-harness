import type { Locator, Page } from '@playwright/test'

/**
 * A Features page as data (#482): the words, next to the capture steps that prove them.
 *
 * `docs/features/<id>.md` is BUILT from a spec and the FACTS its capture wrote
 * (`docs/features/facts/<id>.json`, committed beside the screenshots, never served by the site):
 *   • **How to open it**: the navigation steps the capture actually took, recorded through
 *     `FeatureUi`, so the instructions are the clicks that reached the screenshot. `{steps}` in
 *     `opens` places the first shot's; every other shot's are said above its image.
 *   • **What it looks like**: one legend line per ring, rung on the element the capture found.
 *     A mark names its target by what a reader sees; the capture fails if the page renders no
 *     such element, so a renamed control can't outlive its page.
 *   • Any value the prose quotes (`{name}` in a string): read off the page at capture
 *     (`measure`), never typed from a past session.
 *
 * Everything else is sentences a person writes: what the feature is for, what to notice, what it
 * does not do. They sit here, beside the capture, and nowhere else. A fact the code owns (a limit,
 * a list of rules) is read from the code (`source-constants.ts`), not written again.
 */

/** The thread's views, as its tab strip names them. */
export type ThreadTab = 'Chat' | 'Context' | 'Stats' | 'Changes'

/** The UI a shot reaches its screen through. Each call but `scrollTo` records the step a reader would take. */
export interface FeatureUi {
  readonly page: Page
  /** Open the finished demo thread, the way a reader picks it in the rail. */
  readonly openThread: () => Promise<void>
  readonly tab: (name: ThreadTab) => Promise<void>
  /** Click what a reader would: the step names it by the text or name it was found by. */
  readonly click: (target: MarkTarget) => Promise<void>
  /** Bring `target` near the top of the viewport. A reader scrolls without being told, so no step. */
  readonly scrollTo: (target: MarkTarget) => Promise<void>
  /** The thread on screen with `?debug` added: the session debug drawer. */
  readonly debugDrawer: () => Promise<void>
  /** The day's log page, `/debug`. */
  readonly logPage: () => Promise<void>
  /** Fork the thread at its `promptNumber`th prompt (1-based) with the button under it. */
  readonly forkAt: (promptNumber: number) => Promise<void>
}

/** Every ARIA role Playwright finds by. */
export type Role = Parameters<Page['getByRole']>[0]

/**
 * An element by what a reader sees. `within` narrows the search to inside another target (a
 * dialog, a panel, a tool row); the first match is taken.
 */
export type MarkTarget = (
  | { readonly role: Role; readonly name: string | RegExp; readonly exact?: boolean }
  | { readonly text: string | RegExp; readonly exact?: boolean }
  | { readonly label: string }
  | { readonly placeholder: string }
  /** A tool call's row in the chat, by text of what it was given; `summary` is its one-line header. */
  | { readonly toolCall: string; readonly summary?: boolean }
) & { readonly within?: MarkTarget }

export interface Mark {
  readonly target: MarkTarget
  /**
   * The legend line. `{shown}` is the text the target rendered at capture, and any `{name}` a
   * value the shot measured.
   */
  readonly says: string
}

/** The moments the demo session stops at on its way, where a shot exists only while it waits. */
export type SessionMoment = 'start-dialog' | 'questionnaire' | 'permission-prompt'

interface ShotBase {
  /** The image's file stem under `docs/features/images/`. */
  readonly image: string
  readonly alt: string
  /** The rings, numbered in order. */
  readonly marks: readonly Mark[]
  /** Paragraphs after this shot's legend, before the next image. */
  readonly after?: readonly string[]
  /** Crop to the smallest rectangle around these (padded); the whole viewport when absent. */
  readonly region?: readonly MarkTarget[]
  /**
   * Values the page's sentences quote: name → the element whose text it is. Read AFTER the
   * screenshot, in order, so one may click to reach its element (a bar, a card) without that
   * click showing in the image.
   */
  readonly measure?: Readonly<Record<string, (page: Page) => Locator | Promise<Locator>>>
}

/** A shot of the finished thread: `go` reaches the screen, `cold` after a restart, when no session holds it. */
export interface ReachedShot extends ShotBase {
  readonly go: (ui: FeatureUi) => Promise<void>
  readonly cold?: boolean
}

/** A shot the demo session takes as it stops at `during`; its steps are the session's own. */
export interface SessionShot extends ShotBase {
  readonly during: SessionMoment
}

export type Shot = ReachedShot | SessionShot

export interface FeatureSpec {
  /** The page's file stem under `docs/features/`. */
  readonly id: string
  readonly title: string
  /** **What it shows**: paragraphs (a table or a code block is one paragraph). */
  readonly shows: readonly string[]
  /**
   * **How to open it**: one list item each; a line after the first is indented under it, so an
   * item may carry a code block. `{steps}` is the first shot's recorded steps, as a sentence.
   */
  readonly opens: readonly string[]
  /** Paragraphs at the head of **What it looks like**, before the first image. */
  readonly looksLike?: readonly string[]
  readonly shots: readonly Shot[]
  /** **What to look for**: paragraphs, which may quote measured values as `{name}`. */
  readonly lookFor: readonly string[]
  /** **What it doesn't do**: one line each. */
  readonly limits: readonly string[]
  /**
   * **Go deeper**: repository-relative page, its label, and why a reader would go there; `also`, a
   * second page the same reason covers (`[A] and [B]: why`).
   */
  readonly see: readonly GoDeeper[]
}

/** A page a feature points on to. */
export interface GoDeeper {
  readonly path: string
  readonly label: string
  readonly why?: string
  readonly also?: { readonly path: string; readonly label: string }
}

/** What a capture observed for one shot, written beside its image and read by the page build. */
export interface ShotFacts {
  readonly image: string
  /** The steps `go` took, as sentence fragments, in order. */
  readonly steps: readonly string[]
  /** Per mark, in order: the text its target rendered. */
  readonly shown: readonly string[]
  readonly measured: Readonly<Record<string, string>>
}

export interface FeatureFacts {
  readonly feature: string
  readonly shots: readonly ShotFacts[]
}

/** The facts file for a feature, repository-relative. */
export const factsPath = (id: string): string => `docs/features/facts/${id}.json`

/**
 * `captured` recorded into `facts`, in the spec's shot order: a recapture of one shot replaces its
 * entry and keeps the others, so the moments a page's shots are taken at (during the session, on
 * the finished thread, after a restart) can each be retaken alone. A shot the spec no longer has
 * is dropped.
 */
export function withShotFacts(spec: FeatureSpec, facts: FeatureFacts | undefined, captured: ShotFacts): FeatureFacts {
  const byImage = new Map((facts?.shots ?? []).map((shot) => [shot.image, shot]))
  byImage.set(captured.image, captured)
  return {
    feature: spec.id,
    shots: spec.shots.flatMap((shot) => {
      const recorded = byImage.get(shot.image)
      return recorded === undefined ? [] : [recorded]
    }),
  }
}
