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
 * `ZEN_SITE_BASE` from the repository itself rather than repeating a literal that would rot the
 * first time the repo is renamed or forked.
 */
export const SITE_BASE: string = process.env.ZEN_SITE_BASE ?? '/zen-harness'
