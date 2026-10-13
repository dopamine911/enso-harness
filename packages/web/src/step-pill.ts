/**
 * A transcript state pill's ring and type (#417, the prototype's `.pill`): mono 11px in a rounded
 * border of the text's own colour, so the caller's role colour (`text-ok`, `text-refuse`,
 * `text-evidence`) tints the word and its ring together. A step row's state and a refusal's verdict.
 */
export const PILL =
  'inline-flex shrink-0 items-center gap-1 rounded-full border border-current px-2 py-px font-mono text-meta whitespace-nowrap'
