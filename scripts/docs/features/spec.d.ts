import type { Locator, Page } from '@playwright/test'
/**
 * A Features page as data (#482): the words, next to the capture steps that prove them.
 *
 * `docs/features/<id>.md` is BUILT from a spec and the FACTS its capture wrote
 * (`docs/features/facts/<id>.json`, committed beside the screenshots, never served by the site):
 *   • **How to open it**: the navigation steps the capture actually took, recorded through
 *     `FeatureUi`, so the instructions are the clicks that reached the screenshot.
 *   • **What it looks like**: one legend line per ring, rung on the element the capture found.
 *     A mark names its target by role and name, or by text; the capture fails if the page
 *     renders no such element, so a renamed control can't outlive its page.
 *   • Any value the prose quotes (`{name}` in a string): read off the page at capture
 *     (`measure`), never typed from a past session.
 *
 * Everything else is sentences a person writes: what the feature is for, what to notice, what it
 * does not do. They sit here, beside the capture, and nowhere else.
 */
/** The UI a shot reaches its screen through. Each call records the step a reader would take. */
export interface FeatureUi {
  readonly page: Page
  /** Open the finished demo thread, the way a reader picks it in the rail. */
  readonly openThread: () => Promise<void>
  readonly tab: (name: 'Chat' | 'Context' | 'Stats' | 'Changes') => Promise<void>
}
/** An element by what a reader sees: its role and accessible name, or text it shows. */
export type MarkTarget =
  | {
      readonly role: 'heading' | 'button' | 'tab' | 'navigation' | 'link'
      readonly name: string
    }
  | {
      readonly text: string
    }
export interface Mark {
  readonly target: MarkTarget
  /**
   * The legend line. `{shown}` is the text the target rendered at capture, and any `{name}` a
   * value the shot measured.
   */
  readonly says: string
}
export interface Shot {
  /** The image's file stem under `docs/features/images/`. */
  readonly image: string
  readonly alt: string
  /** How the capture reaches the screen: every `ui` call becomes a step of **How to open it**. */
  readonly go: (ui: FeatureUi) => Promise<void>
  /** The rings, numbered in order. */
  readonly marks: readonly Mark[]
  /** Values the page's sentences quote, read off the page at capture: name → the element whose text it is. */
  readonly measure?: Readonly<Record<string, (page: Page) => Locator>>
}
export interface FeatureSpec {
  /** The page's file stem under `docs/features/`. */
  readonly id: string
  readonly title: string
  /** **What it shows**: paragraphs. */
  readonly shows: readonly string[]
  /** More ways in, beyond the path the capture takes. */
  readonly alsoOpens?: readonly string[]
  readonly shots: readonly Shot[]
  /** A paragraph after the legends. */
  readonly afterShots?: string
  /** **What to look for**: paragraphs, which may quote measured values as `{name}`. */
  readonly lookFor: readonly string[]
  /** **What it doesn't do**: one line each. */
  readonly limits: readonly string[]
  /** **Go deeper**: repository-relative page, its label, and why a reader would go there. */
  readonly see: readonly {
    readonly path: string
    readonly label: string
    readonly why?: string
  }[]
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
export declare const factsPath: (id: string) => string
