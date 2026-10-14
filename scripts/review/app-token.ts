/**
 * The identity the local reviewer posts as: a GitHub App the owner created for it (#981), instead
 * of the owner's own `gh` login.
 *
 * WHY AN APP. The reviewer's `gh` used to run on the owner's login, whose token carries `repo`,
 * `workflow` and `admin:public_key`. The grant hook was the only thing between a reviewer steered by
 * a pull request's text and that token, and #989's reviews found six ways around the hook. An App
 * installation token is limited to ONE repository and to the permissions asked for here, and it
 * expires after an hour (measured 2026-10-14: `gh pr view` and `gh pr diff` work with it, `gh api
 * user` answers 403, and a second repository is not visible). The reviews also read as the App's
 * bot, not as the owner.
 *
 * The App's settings live in `~/.config/enso-review/app.json` (`REVIEW_APP_CONFIG_PATH`), one file
 * per machine, never in the repository. Without the file, the review runs on the owner's `gh`
 * login, as it did before.
 */

import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The machine's App settings: a path to the key, never the key itself. */
const REVIEW_APP_CONFIG_PATH = join(homedir(), '.config', 'enso-review', 'app.json')

/** `REVIEW_APP_CONFIG_PATH`'s contents. */
export interface ReviewAppConfig {
  /** The App ID, from the App's settings page (not the installation ID). */
  readonly appId: number
  /** The installation on the owner's account that covers this repository. */
  readonly installationId: number
  /** The App's private key (`.pem`), as GitHub generated it. */
  readonly privateKeyPath: string
}

/**
 * What the token may do: read the pull request and its code, and write comments (a pull request's
 * comments are issue comments). Asked for explicitly, so a permission later added to the App does
 * not silently reach the reviewer.
 */
const REVIEW_TOKEN_PERMISSIONS = {
  contents: 'read',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'read',
} as const

const GITHUB_API = 'https://api.github.com'
/** GitHub accepts an App's JWT for at most ten minutes; backdated a minute for clock drift, as GitHub advises. */
const JWT_BACKDATE_SECONDS = 60
const JWT_LIFETIME_SECONDS = 540
const MILLISECONDS_PER_SECOND = 1000

/** The App config, or `undefined` when this machine has none. Throws on a file that is not a config. */
export function readReviewAppConfig(path: string = REVIEW_APP_CONFIG_PATH): ReviewAppConfig | undefined {
  if (!existsSync(path)) return undefined
  const config = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReviewAppConfig>
  if (
    !Number.isInteger(config.appId) ||
    !Number.isInteger(config.installationId) ||
    typeof config.privateKeyPath !== 'string'
  ) {
    throw new Error(`${path}: needs { "appId": <number>, "installationId": <number>, "privateKeyPath": "<.pem>" }`)
  }
  return config as ReviewAppConfig
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

/** The App's JSON web token: what proves to GitHub that this machine holds the App's key. */
export function appJsonWebToken(appId: number, privateKey: string, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / MILLISECONDS_PER_SECOND) - JWT_BACKDATE_SECONDS
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + JWT_LIFETIME_SECONDS, iss: String(appId) }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${base64Url(signer.sign(privateKey))}`
}

async function githubJson(path: string, jsonWebToken: string, body?: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${jsonWebToken}`, Accept: 'application/vnd.github+json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const answer = (await response.json()) as Record<string, unknown>
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${String(answer.message)}`)
  return answer
}

/** What a run posts with: the token, and the login its comments carry. */
export interface ReviewIdentity {
  readonly token: string
  /** `<app-slug>[bot]`: the author the "was it posted" check looks for. */
  readonly login: string
}

/** A one-hour installation token for ONE repository (`name`, without its owner), and the App's bot login. */
export async function reviewAppIdentity(config: ReviewAppConfig, repositoryName: string): Promise<ReviewIdentity> {
  const jsonWebToken = appJsonWebToken(config.appId, readFileSync(config.privateKeyPath, 'utf8'))
  const app = await githubJson('/app', jsonWebToken)
  const installation = await githubJson(`/app/installations/${config.installationId}/access_tokens`, jsonWebToken, {
    repositories: [repositoryName],
    permissions: REVIEW_TOKEN_PERMISSIONS,
  })
  if (typeof installation.token !== 'string' || typeof app.slug !== 'string') {
    throw new Error('GitHub answered without a token or an App slug')
  }
  return { token: installation.token, login: `${app.slug}[bot]` }
}
