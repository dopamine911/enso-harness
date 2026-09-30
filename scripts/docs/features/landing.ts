import { FEATURE_SPECS } from './index.ts'
import type { FeatureSpec } from './spec.ts'

/**
 * The feature map on the site's landing page (`site/src/pages/index.astro`, #504): four groups,
 * each an editorial heading over the Features pages it links, in reading order.
 *
 * The headings are written here, by hand, because they are editorial. The FEATURES are not: each
 * link is a spec in `FEATURE_SPECS`, with the spec's own title and its required `landingTagline`.
 * The groups list feature ids, and `test/features-gate.test.ts` holds them to `FEATURE_SPECS`:
 * every feature in exactly one group, and no group naming a feature that is not a spec. So a new
 * Features page cannot ship without a place on the landing, and the landing cannot link a page
 * that is gone.
 *
 * Order within a group is its own, not `FEATURE_SPECS`': that list is ordered for the screenshot
 * capture, not for reading.
 */
export interface LandingFeatureGroup {
  readonly kicker: string
  readonly title: string
  readonly text: string
  /** Feature ids (`FeatureSpec['id']`), in the order the group shows them. */
  readonly features: readonly string[]
}

/** @group Landing page */
export const LANDING_FEATURE_GROUPS: readonly LandingFeatureGroup[] = [
  {
    kicker: 'Work',
    title: 'Run the session without losing the human.',
    text: 'Projects, threads, questions and permission choices keep the working relationship explicit.',
    features: ['chat', 'sessions-and-projects', 'questions-and-dialogs', 'permission-modes'],
  },
  {
    kicker: 'Understand',
    title: 'See what produced the result.',
    text: 'Inspect context, operational cost and recorded signals instead of reconstructing a run from its final answer.',
    features: ['context', 'context-browser', 'stats', 'session-eval'],
  },
  {
    kicker: 'Experiment',
    title: 'Change the conditions without erasing the evidence.',
    text: 'Fork a thread at a prompt, start from a prompt of your own, and retain a record of the conditions each run operated under.',
    features: ['lineage', 'prompts'],
  },
  {
    kicker: 'Verify & operate',
    title: 'Keep receipts for the parts that matter.',
    text: 'Distinguish refusals from failures, see what changed, inspect the logs, and give the agent deliberate paths to external information.',
    features: ['guards-and-receipts', 'diff', 'logs-and-debugging', 'web-access', 'terminal', 'settings'],
  },
]

/** One group with its features resolved to their specs, as the landing page renders it. */
export interface ResolvedLandingGroup extends Omit<LandingFeatureGroup, 'features'> {
  readonly features: readonly FeatureSpec[]
}

/**
 * The groups with each id resolved to its spec. An id that names no spec throws: the gate says so
 * first, and the site build refuses rather than render a link to nothing.
 */
export function landingFeatureGroups(): ResolvedLandingGroup[] {
  const byId = new Map(FEATURE_SPECS.map((spec) => [spec.id, spec]))
  return LANDING_FEATURE_GROUPS.map((group) => ({
    ...group,
    features: group.features.map((featureId) => {
      const spec = byId.get(featureId)
      if (spec === undefined) throw new Error(`landing: the feature "${featureId}" has no spec in FEATURE_SPECS`)
      return spec
    }),
  }))
}
