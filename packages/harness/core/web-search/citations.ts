import { pushUniqueSource } from './sources.ts'
import type { WebSource } from './vocabulary.ts'

/**
 * Citation markers (#63): turn a provider's citation records into `[n]` markers inside
 * the answer text plus the numbered source list those markers point at. Three appliers
 * for three wire shapes:
 *
 * - {@link applyTextCitations} — Anthropic: citations carry the quoted `cited_text`, so
 *   the marker lands after the first occurrence of that quote.
 * - {@link applyIndexCitations} — OpenAI Responses: citations carry a CHARACTER
 *   `end_index` into the answer.
 * - {@link applyByteIndexCitations} — Google grounding: supports carry a BYTE `endIndex`,
 *   so insertion must happen in byte space or multi-byte answers corrupt.
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 */

export interface CitedTextCitation {
  citedText?: string | undefined
  title: string
  url: string
}

export interface IndexCitation {
  endIndex?: number | undefined
  title: string
  url: string
}

export interface CitationResult {
  text: string
  sources: WebSource[]
}

/** Anthropic-shaped: insert each `[n]` after the quoted `citedText`'s first occurrence. */
export function applyTextCitations(text: string, citations: readonly CitedTextCitation[]): CitationResult {
  const sources: WebSource[] = []
  const insertions: Array<{ index: number; marker: string }> = []
  const usedInsertionKeys = new Set<string>()

  for (const citation of citations) {
    if (citation.url.length === 0) continue
    const marker = `[${pushUniqueSource(sources, citation) + 1}]`
    const citedText = citation.citedText?.trim()
    if (citedText === undefined || citedText.length === 0) continue
    const foundAt = text.indexOf(citedText)
    if (foundAt < 0) continue
    const insertAt = foundAt + citedText.length
    const insertionKey = `${insertAt}:${marker}`
    if (usedInsertionKeys.has(insertionKey)) continue
    usedInsertionKeys.add(insertionKey)
    insertions.push({ index: insertAt, marker })
  }

  let result = text
  for (const insertion of insertions.sort((first, second) => second.index - first.index)) {
    result = result.slice(0, insertion.index) + insertion.marker + result.slice(insertion.index)
  }
  return { text: result, sources }
}

/** OpenAI-shaped: insert each `[n]` at the citation's character `endIndex`. */
export function applyIndexCitations(text: string, citations: readonly IndexCitation[]): CitationResult {
  const sources: WebSource[] = []
  const insertions = citations
    .filter((citation) => citation.url.length > 0 && citation.endIndex !== undefined)
    .map((citation) => ({
      index: Math.max(0, Math.min(citation.endIndex ?? 0, text.length)),
      marker: `[${pushUniqueSource(sources, citation) + 1}]`,
    }))
    .sort((first, second) => second.index - first.index)

  let result = text
  const usedInsertionKeys = new Set<string>()
  for (const insertion of insertions) {
    const insertionKey = `${insertion.index}:${insertion.marker}`
    if (usedInsertionKeys.has(insertionKey)) continue
    usedInsertionKeys.add(insertionKey)
    result = result.slice(0, insertion.index) + insertion.marker + result.slice(insertion.index)
  }

  // A citation with no end index still earns its place in the source list.
  for (const citation of citations) {
    if (citation.url.length > 0) pushUniqueSource(sources, citation)
  }
  return { text: result, sources }
}

export interface ByteIndexInsertion {
  /** BYTE offset into the UTF-8 encoding of the text. */
  byteIndex: number
  marker: string
}

/**
 * Google-shaped: grounding supports index by BYTE offset. Insertion happens over the
 * UTF-8 bytes so a multi-byte answer (CJK, emoji) keeps its characters intact.
 */
export function applyByteIndexCitations(text: string, insertions: readonly ByteIndexInsertion[]): string {
  if (insertions.length === 0) return text
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const textBytes = encoder.encode(text)

  const parts: Uint8Array[] = []
  let unwrittenEnd = textBytes.length
  const descending = [...insertions].sort((first, second) => second.byteIndex - first.byteIndex)
  for (const insertion of descending) {
    const position = Math.min(insertion.byteIndex, unwrittenEnd)
    if (position < unwrittenEnd) parts.unshift(textBytes.subarray(position, unwrittenEnd))
    parts.unshift(encoder.encode(insertion.marker))
    unwrittenEnd = position
  }
  if (unwrittenEnd > 0) parts.unshift(textBytes.subarray(0, unwrittenEnd))

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(totalLength)
  let writeOffset = 0
  for (const part of parts) {
    merged.set(part, writeOffset)
    writeOffset += part.length
  }
  return decoder.decode(merged)
}
