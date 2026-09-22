/**
 * The path the documentation site is served under — ONE value, read by three readers (#188).
 *
 * Astro needs it as `base`, the projection needs it to rewrite a page link into a site link,
 * and the link crawl needs it to resolve one back to a file. Three literals would agree until
 * the day the site is published somewhere else, and then disagree silently: a wrong `base`
 * produces a site whose every internal link 404s, and the crawl — carrying the same wrong
 * literal — would resolve them and report green.
 *
 * ⚠ THE DEFAULT IS THE LOCAL ONE, AND PUBLISHING OVERRIDES IT. A GitHub project site is served
 * from `/<repository>`, which is not this repository's short name, so the publish workflow sets
 * `ENSO_SITE_BASE` from the repository itself rather than repeating a literal that would rot the
 * first time the repo is renamed or forked.
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
 * the owner's Pages origin.
 */
export const SITE_URL: string = process.env.ENSO_SITE_URL ?? 'https://example.invalid'
