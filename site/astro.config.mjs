// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import mermaid from 'astro-mermaid'

/**
 * The documentation site (#188): a PRESENTATION layer over `docs/`, never a second source.
 *
 * Content is projected in from the repository's `docs/` by `scripts/docs/site-content.ts` —
 * Starlight's `docsLoader()` can only read `src/content/docs/`, so the projection is what keeps
 * the pages beside the code they describe. The projected tree is gitignored and rebuilt on
 * every build, so the only editable copy is the one in `docs/`.
 *
 * The API reference is TypeDoc's HTML, copied to `public/api/` by the same script and linked
 * from the sidebar rather than re-rendered: TypeDoc owns that surface (`typedoc.json`, the
 * `api-docs` gate), and rebuilding it here would be a second renderer of one contract.
 *
 * `srcDir`/`outDir` stay inside `site/`; nothing this build writes leaves it.
 */
export default defineConfig({
  site: 'https://example.invalid/zen-harness',
  base: '/zen-harness',
  outDir: './dist',
  // ⚠ `mermaid()` must precede `starlight()`: it rewrites the ```mermaid fences before
  // Starlight's markdown pipeline turns them into highlighted code blocks.
  integrations: [
    mermaid({ theme: 'neutral', autoTheme: true }),
    starlight({
      title: 'zen-harness',
      description: 'The harness architecture, its seams, and the reference material generated from its source.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/dopamine911/zen-harness-foundation' }],
      // Four sections, in the order a reader needs them: what it is, how it behaves, what it
      // declares, how to change it.
      //
      // ⚠ The page lists are `autogenerate`, never enumerated. A hand-written list of seam or
      // flow pages would be a maintained copy of a fact the directory already states, and the
      // first page added would silently not appear in it. The nesting is `items: [{ autogenerate }]`
      // rather than a group carrying `autogenerate` itself: Starlight removed the latter in
      // v0.39.0, and the build error — not the editor types — is what says so.
      sidebar: [
        {
          label: 'Architecture',
          items: [
            { slug: 'architecture' },
            { slug: 'glossary' },
            { label: 'Seams', items: [{ autogenerate: { directory: 'seams' } }] },
            { label: 'Flows', items: [{ autogenerate: { directory: 'flows' } }] },
          ],
        },
        {
          label: 'Generated reference',
          items: [
            { slug: 'reference/flows' },
            { slug: 'reference/routes' },
            { slug: 'reference/observations' },
            { slug: 'reference/core-exports' },
            { slug: 'reference/env-and-config' },
            { slug: 'reference/decisions' },
            { slug: 'reference/verification-inventory' },
          ],
        },
        // Built by TypeDoc into `public/api/`, not by Astro: a link, never a page.
        { label: 'API reference', link: '/api/' },
        {
          label: 'Development',
          items: [
            { slug: 'verification' },
            { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
          ],
        },
      ],
    }),
  ],
})
