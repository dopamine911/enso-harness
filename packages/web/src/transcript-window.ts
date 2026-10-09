import type { CSSProperties } from 'react'

/**
 * The windowed transcript's pixel numbers (#739), kept out of the page code. A virtualizer measures
 * and places rows in pixels: its estimate is a number and a row's place is a transform, neither of
 * which a Tailwind variable can be. So they live here, the one file of the transcript the
 * style-tokens gate lets name a pixel, as the debug lists' windowing does.
 */

/**
 * A row's height before it is measured. Rows run from a 40 px tool line to a screenful of reply;
 * this is near the real arena sessions' median, and only decides how far the scrollbar is wrong
 * before a row is drawn: each row is measured as it is.
 */
const ESTIMATED_ROW_PX = 120

/** The virtualizer's `estimateSize`: one estimate for every row. */
export function estimatedTranscriptRow(): number {
  return ESTIMATED_ROW_PX
}

/** A windowed row's box: placed `offset` pixels below the top of the list, the list's full width. */
export function windowedRowStyle(offset: number): CSSProperties {
  return { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${offset}px)` }
}
