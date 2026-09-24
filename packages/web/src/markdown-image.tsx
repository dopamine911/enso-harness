import type { TextPartProps } from '@tanstack/ai-react/ui'
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

/**
 * Two bases no page is served from. A source that resolves to a DIFFERENT origin against each is
 * relative — it names no host of its own and stays on this page's server. One that resolves to
 * the same origin against both named its host itself, whatever that host is.
 */
const PROBE_BASES = [new URL('http://a.invalid/'), new URL('http://b.invalid/')] as const
/** What the button names when the source is not a URL at all — still behind the click. */
const UNRECOGNISED_ADDRESS = 'an unrecognised address'

/**
 * The host a markdown image would be fetched from, or `undefined` when it stays on this page's
 * own server. Decided by whether the source DEPENDS on the base, not by comparing hosts:
 * `//host/x` and `/\host/x` look relative, the link filter keeps both, and a browser resolves
 * both to another host; and no host a model can write — a placeholder's included — is exempt.
 *
 * ⚠ An ABSOLUTE URL to this page's own origin counts as remote and waits for a click. That is
 * deliberate: rendering has no page origin to compare against (static render and tests have no
 * `window`), and the click is the safe direction. Do not "fix" it with `window.location`.
 */
export function remoteImageHost(source: string): string | undefined {
  const [first, second] = PROBE_BASES
  if (!URL.canParse(source, first)) return UNRECOGNISED_ADDRESS
  const resolved = new URL(source, first)
  return resolved.origin === new URL(source, second).origin ? resolved.host || UNRECOGNISED_ADDRESS : undefined
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

/** The intrinsic elements `TextPart` renders through ours — a remote image waits for a click. */
export const TEXT_PART_COMPONENTS: NonNullable<TextPartProps['components']> = { img: MarkdownImage }
