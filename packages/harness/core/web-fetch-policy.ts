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
 *     ({@link isPublicIpAddress}); an IP-literal URL classifies the literal directly.
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
  const mediaType = (contentTypeHeader.split(';')[0] ?? '').trim().toLowerCase()
  if (mediaType.startsWith('text/')) return true
  if (FETCHABLE_EXACT_MEDIA_TYPES.has(mediaType)) return true
  return FETCHABLE_MEDIA_TYPE_SUFFIXES.some((suffix) => mediaType.endsWith(suffix))
}

const IPV4_OCTET_COUNT = 4
const IPV4_MAX_OCTET = 255

type Ipv4Octets = readonly [number, number, number, number]

/** Parse a dotted-quad string into octets, or undefined when it is not one. */
function ipv4OctetsOf(address: string): Ipv4Octets | undefined {
  const parts = address.split('.')
  if (parts.length !== IPV4_OCTET_COUNT) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > IPV4_MAX_OCTET) return undefined
    octets.push(octet)
  }
  const [first, second, third, fourth] = octets
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined
  return [first, second, third, fourth]
}

/**
 * The IPv4 ranges that are not public, as CIDR blocks — `[network address as octets, prefix]`,
 * one row per RFC range with its reason beside it. The classifier below is the table, not a
 * case per row (#175: thirteen `if`s read as the repo's most branching function while being
 * its most regular). Extending the deny is adding a row.
 */
const NON_PUBLIC_IPV4_CIDRS: readonly (readonly [
  address: readonly [number, number, number, number],
  prefix: number,
])[] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 3], // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
]

function ipv4ToInteger(octets: Ipv4Octets): number {
  return octets.reduce((value, octet) => value * 256 + octet, 0)
}

/** Callers hold `Ipv4Octets`, so a length guard here would be a branch nothing can reach. */
function isPublicIpv4(octets: Ipv4Octets): boolean {
  const address = ipv4ToInteger(octets)
  return !NON_PUBLIC_IPV4_CIDRS.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix)
    return address >= ipv4ToInteger(base) && address < ipv4ToInteger(base) + size
  })
}

/**
 * ADVISORY public-address classifier — see the module header's stated non-coverage.
 *
 * Anything not provably public (unparseable included) classifies as non-public: the check gates
 * a refusal, so unknown must fail closed.
 *
 * @group Web fetch policy
 */
export function isPublicIpAddress(address: string): boolean {
  const trimmed = address.trim().toLowerCase()
  if (trimmed.length === 0) return false
  const octets = ipv4OctetsOf(trimmed)
  if (octets !== undefined) return isPublicIpv4(octets)
  if (!trimmed.includes(':')) return false // neither dotted-quad nor IPv6 — not provably public
  // IPv6. A dotted tail (`::ffff:10.0.0.1`, NAT64 `64:ff9b::10.0.0.1`) embeds a v4
  // address — classify the embedded one. Hex-form embeddings are the stated gap.
  if (trimmed.includes('.')) {
    const embedded = trimmed.slice(trimmed.lastIndexOf(':') + 1)
    const embeddedOctets = ipv4OctetsOf(embedded)
    return embeddedOctets !== undefined && isPublicIpv4(embeddedOctets)
  }
  if (trimmed === '::' || trimmed === '::1') return false // unspecified, loopback
  if (trimmed.startsWith('fc') || trimmed.startsWith('fd')) return false // fc00::/7 ULA
  if (/^fe[89ab]/.test(trimmed)) return false // fe80::/10 link-local
  return true
}
