/**
 * The prototype's chrome (#417) for the controls it draws the same everywhere. A menu: a popover
 * lifted by `shadow-pop` rather than ringed, 40px rows with room around their icon, a
 * refusal-coloured destructive row — laid over shadcn's `DropdownMenu` through `className`, so the
 * vendored primitive stays as shipped. And the status strip's buttons.
 */

/** A menu's popup: `DropdownMenuContent`'s `className`. */
export const MENU_CONTENT = 'rounded-lg p-1 shadow-pop ring-0'

/** A menu's row: `DropdownMenuItem`'s (and a radio item's) `className`. */
export const MENU_ITEM =
  'min-h-10 gap-3 rounded-sm px-3 py-0 data-[variant=destructive]:text-refuse data-[variant=destructive]:*:[svg]:text-refuse'

/**
 * A control in the status strip, the prototype's `.status-button`: a word that lights a card under
 * it on hover. Its padding is its target; the strip's gap still spaces it from its neighbours.
 */
export const STATUS_BUTTON =
  '-mx-2 inline-flex min-h-7 shrink-0 items-center gap-1 rounded-xs px-2 transition-colors duration-150 hover:bg-card focus-visible:outline-2 focus-visible:outline-ring'
