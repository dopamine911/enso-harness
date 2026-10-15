/**
 * The path the documentation site is served under — ONE value, read by three readers (#188).
 *
 * Astro needs it as `base`, the projection needs it to rewrite a page link into a site link,
 * and the link crawl needs it to resolve one back to a file. Three literals would agree until
 * the day the site is published somewhere else, and then disagree silently: a wrong `base`
 * produces a site whose every internal link 404s, and the crawl — carrying the same wrong
 * literal — would resolve them and report green.
 *
 * ⚠ THE DEFAULT IS THE LOCAL ONE, AND PUBLISHING OVERRIDES IT. Where Pages serves the site
 * decides the base — `/<repository>` for a project site, EMPTY for a custom domain
 * (`enso.engineer`, #506) — so the publish workflow reads it from the Pages configuration rather
 * than repeating a literal that would rot on a rename, a fork or a domain change.
 *
 * ⚠ `??`, not `||`: an empty `ENSO_SITE_BASE` is the custom domain's real base, not a missing one.
 */
export const SITE_BASE: string = process.env.ENSO_SITE_BASE ?? '/enso'

/**
 * The origin the site is served from, which Astro needs to emit a sitemap at all.
 *
 * ⚠ Dropping it is silent: `@astrojs/sitemap` logs "requires the `site` option. Skipping." at
 * WARN and the build succeeds without one. Measured — it went missing for exactly one commit,
 * when the hardcoded placeholder was removed along with the hardcoded base.
 *
 * The default is deliberately an unresolvable placeholder: a local build has no origin, and
 * inventing a real one would put a URL nobody serves into a sitemap. The publish workflow sets
 * the origin Pages serves from (`https://enso.engineer` since #506).
 */
export const SITE_URL: string = process.env.ENSO_SITE_URL ?? 'https://example.invalid'

/**
 * The repository the site links to: Starlight's header icon (`site/astro.config.ts`) and the
 * hand-written pages (`site/src/site-urls.ts`). Here, beside the base, because the config cannot
 * import a module that reads `import.meta.env` (#574 review).
 */
export const REPOSITORY_URL = 'https://github.com/dopamine911/zen-harness-foundation'
