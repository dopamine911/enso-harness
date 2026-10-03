import { createConnection } from 'node:net'

/**
 * Whether something is listening on `port` on loopback: the check a launcher makes before it
 * starts a stack on the dev ports, so a stack already there (serving someone's own home) is
 * refused by name rather than half-reused. Shared by the Features capture and Dogfood Arena (#556).
 */
export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}
