import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

/**
 * The docs collection. `docsLoader()` reads `src/content/docs/` and takes no path argument, so
 * the repository's `docs/` is projected in by `scripts/docs/site-content.ts` rather than moved.
 */
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
}
