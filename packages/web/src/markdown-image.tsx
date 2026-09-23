import { type ComponentPropsWithoutRef, useState } from 'react'

/**
 * ⚠ A MARKDOWN IMAGE IS A FETCH, so a remote one waits for a click (PR #350 review).
 *
 * `@tanstack/markdown` renders `![alt](https://host/p.png?q=…)` as an `<img>` the moment the
 * text streams in, and the browser requests it with no click. That is the classic
 * prompt-injection exfiltration channel: a poisoned file or fetched page asks the agent to
 * "add this badge", and whatever the agent has read rides out in the query string. So a
 * remote image renders as a button showing its alt text, host and FULL URL; one click loads
 * it. An image on this page's own server renders at once — it leaves nothing.
 *
 * Wired as `TextPart`'s `components.img`, TanStack's public override for intrinsic elements.
 */

/** A base no page is served from: resolving against it separates this server's own paths from another host. */
const LOCAL_BASE = new URL('http://enso.invalid/')

/**
 * The host a markdown image would be fetched from, or `undefined` when it stays on this page's
 * own server. PARSED, not pattern-matched: `//host/x` and `/\host/x` look relative, the link
 * filter keeps both, and a browser resolves both to another host. A source the parser refuses
 * is treated as remote — the click is the safe default for anything unrecognised.
 */
export function remoteImageHost(source: string): string | undefined {
  if (!URL.canParse(source, LOCAL_BASE)) return source
  const { host } = new URL(source, LOCAL_BASE)
  return host === LOCAL_BASE.host ? undefined : host
}

/** `TextPart`'s `img`: a local image as itself, a remote one behind one click. */
export function MarkdownImage(props: ComponentPropsWithoutRef<'img'>): React.ReactNode {
  const { alt, title } = props
  const [requested, setRequested] = useState(false)
  const source = typeof props.src === 'string' ? props.src : ''
  // The link filter blanks a scheme it refuses (`javascript:`, `data:`): nothing to load, the alt text stays.
  if (source === '') return alt ? <span>{alt}</span> : null
  const host = remoteImageHost(source)
  if (host === undefined || requested) {
    return <img alt={alt ?? ''} className="max-w-full rounded-md" src={source} title={title} />
  }
  return (
    <button
      aria-label={`load image from ${host}`}
      className="not-prose my-1 flex max-w-full flex-col items-start gap-0.5 rounded-md border bg-muted/50 px-2 py-1 text-left text-muted-foreground text-xs hover:bg-muted"
      onClick={() => setRequested(true)}
      type="button"
    >
      <span>
        {alt || 'image'} · <strong className="text-foreground">{host}</strong> · click to load
      </span>
      <span className="break-all font-mono">{source}</span>
    </button>
  )
}
