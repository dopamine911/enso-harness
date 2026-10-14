/**
 * The two URLs the site's hand-written pages link with, kept in one place so the landing, its hero
 * and the origin page cannot drift apart (#574 review).
 *
 * `SITE_PATH` is Astro's `base` (`scripts/docs/site-base.ts`) without its trailing slash, so a page
 * writes `${SITE_PATH}/features/` and gets one slash whatever the base is, including the custom
 * domain's empty one.
 */
export const SITE_PATH: string = import.meta.env.BASE_URL.replace(/\/$/, '')

export const REPOSITORY_URL = 'https://github.com/dopamine911/zen-harness-foundation'
