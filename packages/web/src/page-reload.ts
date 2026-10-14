import { useEffect, useRef, useState } from 'react'
import type { PromptAttachment } from './components/ai-elements/prompt-input.tsx'

/**
 * Reload, keeping what is being written (#919). The banner's Reload is the way back from a page
 * that fell behind, and a reload must not cost the person the prompt they were writing: every
 * composer on the page offers its draft — the text and the attached images — and Reload writes
 * them to the tab's `sessionStorage` before it reloads. A composer that mounts for one of those
 * threads opens holding it (`useComposerOpening`: its text, and its form's `initialFiles`), and the kept
 * copy is forgotten.
 *
 * ⚠ The images go as `data:` URLs, which can be large: if the tab's storage will not take them, the
 * text is kept alone rather than nothing. ⚠ Only Reload keeps a draft — the page never reloads by
 * itself, and a draft is not written on every keystroke.
 */

const KEPT_DRAFTS_KEY = 'enso.reload-drafts'

/** A composer's draft: its text and its attachments — kept across a reload as `data:` URLs. */
interface KeptDraft {
  readonly text: string
  readonly files: readonly PromptAttachment[]
}

/** The composers on the page, by thread: each reads its draft as it stands. */
const offered = new Map<string, () => KeptDraft>()

function tabStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

function readKept(storage: Storage | undefined): Record<string, KeptDraft> {
  try {
    const raw = storage?.getItem(KEPT_DRAFTS_KEY)
    return raw == null ? {} : (JSON.parse(raw) as Record<string, KeptDraft>)
  } catch {
    return {}
  }
}

/** A blob URL's bytes as a `data:` URL; undefined when the blob is gone. */
async function dataUrlOf(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    const blob = await response.blob()
    const { promise, resolve } = Promise.withResolvers<string | undefined>()
    const reader = new FileReader()
    reader.addEventListener('loadend', () => resolve(typeof reader.result === 'string' ? reader.result : undefined))
    reader.readAsDataURL(blob)
    return await promise
  } catch {
    return undefined
  }
}

/**
 * Write every offered draft to the tab's storage — text and images, or the text alone when the
 * images do not fit — then reload. A composer with nothing in it keeps nothing.
 */
export async function reloadKeepingDrafts(reload: () => void = () => window.location.reload()): Promise<void> {
  const storage = tabStorage()
  const kept: Record<string, KeptDraft> = readKept(storage)
  for (const [threadId, read] of offered) {
    const { text, files } = read()
    if (text.trim().length === 0 && files.length === 0) continue
    const converted = await Promise.all(
      files.map(async (file) => {
        const url = await dataUrlOf(file.url)
        return url === undefined ? [] : [{ ...file, url }]
      }),
    )
    kept[threadId] = { text, files: converted.flat() }
  }
  try {
    storage?.setItem(KEPT_DRAFTS_KEY, JSON.stringify(kept))
  } catch {
    // The images did not fit: the words matter most.
    const textOnly = Object.fromEntries(
      Object.entries(kept).map(([id, draft]) => [id, { text: draft.text, files: [] }]),
    )
    try {
      storage?.setItem(KEPT_DRAFTS_KEY, JSON.stringify(textOnly))
    } catch {
      // No storage at all (a private window refusing it): the reload goes ahead regardless.
    }
  }
  reload()
}

/** What a composer opens holding: its text, and its form's props — the kept images, when a reload kept any. */
export interface ComposerOpening {
  readonly text: string
  readonly form: { readonly initialFiles?: readonly PromptAttachment[] }
}

/**
 * A composer's opening (#919): the draft Reload kept for its thread, else `text` (a fork's prefill,
 * or nothing). Read once, on mount.
 */
export function useComposerOpening(threadId: string, text: string): ComposerOpening {
  const [opening] = useState<ComposerOpening>(() => {
    const kept = readKept(tabStorage())[threadId]
    return kept === undefined ? { text, form: {} } : { text: kept.text, form: { initialFiles: kept.files } }
  })
  return opening
}

/**
 * A composer's side (#919): offer its draft to Reload while mounted, and forget the copy Reload
 * kept for its thread once it has mounted holding it (`useComposerOpening`, read before this runs).
 */
export function useDraftKeptForReload(threadId: string, text: string, files: readonly PromptAttachment[]): void {
  const latest = useRef<KeptDraft>({ text, files })
  useEffect(() => {
    latest.current = { text, files }
  })
  useEffect(() => {
    offered.set(threadId, () => latest.current)
    return () => {
      offered.delete(threadId)
    }
  }, [threadId])
  useEffect(() => {
    const storage = tabStorage()
    const kept = readKept(storage)
    if (kept[threadId] === undefined) return
    delete kept[threadId]
    try {
      storage?.setItem(KEPT_DRAFTS_KEY, JSON.stringify(kept))
    } catch {
      // Smaller than what was read; a storage that refuses it now refuses everything.
    }
  }, [threadId])
}
