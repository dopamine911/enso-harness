/** The one address this server and its previews bind: the machine itself, never the network. */
export const LOOPBACK_ONLY = '127.0.0.1'

/**
 * Is this `Host`/`Origin` authority the machine itself? Port is irrelevant (either dev
 * surface may ask); the NAME is the whole point, because a hostname that merely resolves
 * to 127.0.0.1 today is a rebinding attack, not localhost.
 */
export function isLoopbackAuthority(authority: string): boolean {
  const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
  return host === LOOPBACK_ONLY || host === 'localhost' || host === '[::1]'
}
