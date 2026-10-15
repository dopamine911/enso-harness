import { WEB_FETCH_MAX_URL_LENGTH } from '@enso/core'

/**
 * web_fetch's pure policy (#54) — every decision that needs no IO. The extension in
 * `extensions/web-fetch/` wires these to the filesystem, DNS and fetch.
 *
 * The gate's evasion dimensions, each pinned by a test (the #55 lesson — enumerate the
 * dimensions BEFORE writing vectors):
 *   - protocol   — `ftp:`, `file:`, `javascript:`, `data:` refused; http(s) only.
 *   - credentials — `https://user:pass@host/` refused outright; also kills the
 *     `https://allowed.example@evil.example/` confusion (the hostname is evil.example,
 *     but the refusal fires first and names the real reason).
 *   - case       — hostnames match case-insensitively on both sides.
 *   - spelling   — `example.com.` (trailing dot) and a punycoded unicode lookalike are
 *     DIFFERENT strings from `example.com` and fail closed; exact match, no wildcard, no
 *     subdomain inheritance — `api.example.com` needs its own allowlist entry.
 *   - address    — an allowlisted host resolving to a private/reserved address is refused
 *     (`nonPublicAddressReason` and its `isPublicIpAddress`, in `@enso/core` — Settings' host check asks them too, #924); an
 *     IP-literal URL classifies the literal directly.
 *   - redirect   — never followed (the extension reports the target instead), so an open
 *     redirect on an allowlisted host cannot reach an unlisted one.
 *
 * ⚠ Stated non-coverage, deliberate (MVP posture): the address check is ADVISORY — the
 * classifier resolves once and fetch resolves again, so a DNS answer that flips between
 * the two (rebinding) gets through, and hex-form mapped/NAT64 IPv6 addresses are not
 * decoded. Closing that needs a resolve-once pinned transport (deepseek-harness carries
 * one); recorded here and in the tests rather than half-built.
 *
 * @group Web fetch policy
 */
export type WebFetchUrlDecision = { kind: 'ok'; url: URL } | { kind: 'refused'; reason: string }

/** The schemes web_fetch accepts, named so the Web access page reads them rather than retyping (#482). */
const FETCHABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

/**
 * Parse and gate a raw URL string. Refusal reasons are written for the model to read.
 *
 * @group Web fetch policy
 */
export function parseWebFetchUrl(rawUrl: string): WebFetchUrlDecision {
  if (rawUrl.length > WEB_FETCH_MAX_URL_LENGTH) {
    return {
      kind: 'refused',
      reason: `the URL is ${rawUrl.length} characters, over the ${WEB_FETCH_MAX_URL_LENGTH}-character cap`,
    }
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { kind: 'refused', reason: 'it is not parseable as an absolute URL' }
  }
  if (!FETCHABLE_PROTOCOLS.has(url.protocol)) {
    return { kind: 'refused', reason: `only http and https URLs are fetchable, got "${url.protocol}"` }
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { kind: 'refused', reason: 'URLs carrying credentials (user:password@host) are never fetched' }
  }
  return { kind: 'ok', url }
}

/**
 * Exact, case-insensitive hostname match.
 *
 * No wildcards and no subdomain inheritance, deliberately: one allowlist entry is one
 * reviewable grant, and `api.example.com` is a different grant from `example.com`. Ports are
 * not part of the match — the protocol gate already confines the scheme, and a host grant is a
 * host grant on any port.
 *
 * @group Web fetch policy
 */
export function isHostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const candidate = hostname.toLowerCase()
  return allowedHosts.some((allowed) => allowed.toLowerCase() === candidate)
}

/** Media types fetchable beyond the `text/` prefix. */
const FETCHABLE_EXACT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
])
/** Structured-syntax suffixes (RFC 6839) that stay textual whatever the vendor prefix. */
const FETCHABLE_MEDIA_TYPE_SUFFIXES: readonly string[] = ['+json', '+xml']

/**
 * True for response bodies worth returning as text.
 *
 * An ABSENT Content-Type header is refused — web_fetch is a docs-reader, and "the server did
 * not say" fails closed.
 *
 * @group Web fetch policy
 */
export function isFetchableContentType(contentTypeHeader: string | null): boolean {
  if (contentTypeHeader === null) return false
  const mediaType = mediaTypeOf(contentTypeHeader)
  if (mediaType.startsWith('text/')) return true
  if (FETCHABLE_EXACT_MEDIA_TYPES.has(mediaType)) return true
  return FETCHABLE_MEDIA_TYPE_SUFFIXES.some((suffix) => mediaType.endsWith(suffix))
}

/**
 * True for an HTML page, which web_fetch returns as its readable text (#927); every other
 * fetchable type is returned as it came.
 *
 * @group Web fetch policy
 */
export function isHtmlContentType(contentTypeHeader: string | null): boolean {
  return contentTypeHeader !== null && mediaTypeOf(contentTypeHeader) === 'text/html'
}

/** The header's media type, parameters dropped: `Text/HTML; charset=utf-8` → `text/html`. */
function mediaTypeOf(contentTypeHeader: string): string {
  return (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase()
}
