import { expect, test } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appJsonWebToken, readReviewAppConfig } from '../review/app-token.ts'

/** A throwaway key pair: the test signs with one half and checks with the other. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' })
/** Example ids, not a real App's. */
const APP_ID = 1_234_567
const INSTALLATION_ID = 12_345_678

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
}

/**
 * ⚠ THE JWT IS WHAT GITHUB TRUSTS (#981). RS256, issued by the App's ID, signed by its key, and
 * short-lived: GitHub refuses one that lives longer than ten minutes.
 */
test('⚠ the App JWT is RS256, issued by the App, signed by its key, and valid for under ten minutes', () => {
  const now = new Date('2026-10-14T15:00:00Z')
  const token = appJsonWebToken(APP_ID, PRIVATE_KEY_PEM, now)
  const [header, payload, signature] = token.split('.')
  expect(decodePart(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
  const claims = decodePart(payload) as { iat: number; exp: number; iss: string }
  expect(claims.iss).toBe(String(APP_ID))
  expect(claims.iat).toBeLessThanOrEqual(now.getTime() / 1000)
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
  expect(claims.exp).toBeGreaterThan(now.getTime() / 1000)
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${header}.${payload}`)
  expect(verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true)
})

test('no config file is no App: the review runs on the owner login, as before', () => {
  expect(readReviewAppConfig(join(mkdtempSync(join(tmpdir(), 'review-app-')), 'app.json'))).toBeUndefined()
})

test('a config file that is not a config is refused, naming what it needs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'review-app-')), 'app.json')
  writeFileSync(path, JSON.stringify({ appId: String(APP_ID), installationId: INSTALLATION_ID }))
  expect(() => readReviewAppConfig(path)).toThrow('appId')
  writeFileSync(path, JSON.stringify({ appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPath: '/k.pem' }))
  expect(readReviewAppConfig(path)).toEqual({
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    privateKeyPath: '/k.pem',
  })
})
