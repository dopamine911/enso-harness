/**
 * The routed pages' shared pieces (#417) — Projects, a project's page, Add project, Settings — as the
 * 2026-10-12 prototype draws them: one class string per piece, so every page draws a button, a
 * field or a card the same way. Passed as `className` to the vendored `Button` and fields, whose own
 * look is the composer's and the dialogs' and stays theirs.
 */

/** A page's one column: centred, its children never wider than it (a long title truncates, not widens it). */
export const PAGE_COLUMN =
  'mx-auto grid w-full max-w-page grid-cols-1 content-start gap-6 px-4 pt-4 pb-12 md:px-6 md:pt-6 md:pb-16'

/** A page's button: 40px tall, its label semibold. */
export const PAGE_BUTTON = 'h-10 rounded-sm px-4 text-sm font-semibold'

/** The primary button: brighter on hover, the accent when it can't be pressed. */
export const PAGE_PRIMARY_BUTTON = `${PAGE_BUTTON} hover:bg-primary hover:brightness-112 disabled:bg-accent disabled:text-muted-foreground disabled:opacity-100`

/** The outline button: a strong border, the primary's on hover. `dark:` too, since the variant sets its own there. */
export const PAGE_OUTLINE_BUTTON = `${PAGE_BUTTON} border-border-strong bg-transparent hover:border-primary hover:bg-accent dark:border-border-strong dark:bg-transparent dark:hover:bg-accent`

/** A text input, a select or a text area on a page: the background, a strong border, the ring's on focus. */
export const PAGE_INPUT =
  'min-h-10 w-full rounded-sm border border-border-strong bg-background px-3 py-2 text-sm text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 aria-invalid:border-refuse dark:bg-background'

/** A card holding a form or a group. */
export const PAGE_CARD = 'grid grid-cols-1 gap-4 rounded-lg border bg-card p-4 md:p-6'

/** A banner over a page's tabs: a title with its icon, its words, its actions. */
export const PAGE_BANNER = 'grid gap-2 rounded-sm border border-border-strong bg-card p-4'

/** A section's or a group's own title. */
export const SUB_TITLE = 'font-heading text-base leading-snug font-semibold'

/** The bar that holds unsaved changes, pinned to the bottom of what scrolls. */
export const SAVE_BAR =
  'sticky bottom-0 z-5 flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-popover px-4 py-3 shadow-save-bar'
