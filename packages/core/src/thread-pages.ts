import { type Static, Type } from 'typebox'

/**
 * `GET /api/threads/:threadId/tree` (#619): where the thread works, and the pages a person can open
 * from there. A thread runs in a tree of its own (#551), not the checkout, so its work is not where
 * its user would look; this says where, which of its HTML files a preview can serve, and the origin
 * that serves them (#713: the thread's own, the tree at `/`).
 *
 * @group Thread tree
 */
export const EnsoThreadPages = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
    /** The directory the thread works in: its tree, or the checkout for a thread with none. */
    path: Type.String({ minLength: 1 }),
    /** The HTML files at its top two levels, `/`-separated and relative to `path`: shallowest first, then by name. */
    pages: Type.Array(Type.String({ minLength: 1 })),
    /** True when there were more pages than the listing holds. */
    truncated: Type.Boolean(),
    /**
     * The origin the thread's preview is served from, `http://127.0.0.1:<port>`, serving `path` at
     * `/` (#713); a page is `<previewOrigin>/<page>`. Absent while there is no page to preview.
     */
    previewOrigin: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
)
/** @group Thread tree */
export type EnsoThreadPages = Static<typeof EnsoThreadPages>
