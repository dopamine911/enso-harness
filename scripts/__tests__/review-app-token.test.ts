import { expect, test } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appJsonWebToken,
  type GithubFetch,
  readReviewAppConfig,
  readTokenPermissions,
  reviewAppIdentity,
} from '../review/app-token.ts'

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

test('a config file holding null is refused with the same message, not a TypeError', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'review-app-')), 'app.json')
  writeFileSync(path, 'null')
  expect(() => readReviewAppConfig(path)).toThrow('appId')
})

/** What the fake GitHub answers: the App, its installation (without checks or statuses), then tokens. */
function fakeAnswer(url: string, requestNumber: number): object {
  if (url.endsWith('/app')) return { slug: 'reviewer' }
  if (url.endsWith(`/installations/${INSTALLATION_ID}`)) {
    return { permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' } }
  }
  return { token: `token-${requestNumber}` }
}

/**
 * ⚠ THE MODEL'S TOKEN CANNOT WRITE (#981). Two tokens are asked for, each for this repository only:
 * the model's with read permissions alone, the runner's with `pull_requests: write` to post. A
 * permission widened in `reviewAppIdentity` fails here, not in a review a pull request steered.
 */
test("⚠ the model's token is read-only and the runner's only posts, both for one repository", async () => {
  const keyPath = join(mkdtempSync(join(tmpdir(), 'review-app-key-')), 'key.pem')
  writeFileSync(keyPath, PRIVATE_KEY_PEM)
  const requests: { url: string; body: unknown }[] = []
  const fakeGithub: GithubFetch = async (url, init) => {
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ url, body })
    return new Response(JSON.stringify(fakeAnswer(url, requests.length)), { status: 200 })
  }
  const identity = await reviewAppIdentity(
    { appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPath: keyPath },
    'zen-harness-foundation',
    fakeGithub,
  )
  expect(identity).toEqual({ readToken: 'token-3', postToken: 'token-4', login: 'reviewer[bot]' })
  const [, , readRequest, postRequest] = requests
  expect(readRequest?.url).toEndWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)
  expect(readRequest?.body).toEqual({
    repositories: ['zen-harness-foundation'],
    permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
  })
  expect(postRequest?.body).toEqual({
    repositories: ['zen-harness-foundation'],
    permissions: { metadata: 'read', pull_requests: 'write' },
  })
})

test('a GitHub refusal names its status, even when its body is not JSON', async () => {
  const keyPath = join(mkdtempSync(join(tmpdir(), 'review-app-key-')), 'key.pem')
  writeFileSync(keyPath, PRIVATE_KEY_PEM)
  const refusing: GithubFetch = async () => new Response('<html>bad gateway</html>', { status: 502 })
  const config = { appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPath: keyPath }
  await expect(reviewAppIdentity(config, 'zen-harness-foundation', refusing)).rejects.toThrow('502')
})

test("checks and statuses join the model's read token only when the installation grants them, and only as read", () => {
  expect(readTokenPermissions({ contents: 'read', pull_requests: 'write' })).toEqual({
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
  })
  expect(readTokenPermissions({ checks: 'write', statuses: 'read', pull_requests: 'write' })).toEqual({
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
    checks: 'read',
    statuses: 'read',
  })
  expect(readTokenPermissions(undefined)).toEqual({ contents: 'read', metadata: 'read', pull_requests: 'read' })
})
