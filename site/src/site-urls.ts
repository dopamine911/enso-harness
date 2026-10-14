/**
 * The two URLs the site's hand-written pages link with, kept in one place so the landing, its hero
 * and the origin page cannot drift apart (#574 review).
 *
 * `SITE_PATH` is Astro's `base` (`scripts/docs/site-base.ts`) without its trailing slash, so a page
 * writes `${SITE_PATH}/features/` and gets one slash whatever the base is, including the custom
 * domain's empty one. `REPOSITORY_URL` is decided beside the base, where Starlight's header link in
 * `astro.config.ts` reads it too.
 */
export const SITE_PATH: string = import.meta.env.BASE_URL.replace(/\/$/, '')

export { REPOSITORY_URL } from '../../scripts/docs/site-base.ts'
