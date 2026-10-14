/**
 * The identity the local reviewer posts as: a GitHub App the owner created for it (#981), instead
 * of the owner's own `gh` login.
 *
 * WHY AN APP. The reviewer's `gh` used to run on the owner's login, whose token carries `repo`,
 * `workflow` and `admin:public_key`. The grant hook was the only thing between a reviewer steered by
 * a pull request's text and that token, and #989's reviews found six ways around the hook. An App
 * installation token is limited to ONE repository and to the permissions asked for, and it expires
 * after an hour (measured 2026-10-14: `gh pr view` and `gh pr diff` work with it, `gh api user`
 * answers 403, and a second repository is not visible). The model gets a read-only one; the runner
 * alone posts. The reviews read as the App's bot, not as the owner.
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
 * The model's token: read the pull request and its code, nothing else. ⚠ NO WRITE AT ALL. Posting a
 * comment on a pull request needs `pull_requests: write` (measured: `issues: write` is refused for
 * both `gh pr comment`'s GraphQL `addComment` and the REST issue-comment endpoint), and that
 * permission also edits, closes and approves pull requests. So the model never holds it: its
 * `gh pr comment` is captured by the grant hook, and the runner posts the captured text with
 * `POST_TOKEN_PERMISSIONS` (#981).
 */
const READ_TOKEN_PERMISSIONS = { contents: 'read', metadata: 'read', pull_requests: 'read' } as const
/** The runner's token: post the review and the status comment. Never given to the model. */
const POST_TOKEN_PERMISSIONS = { metadata: 'read', pull_requests: 'write' } as const

const GITHUB_API = 'https://api.github.com'
/** GitHub accepts an App's JWT for at most ten minutes; backdated a minute for clock drift, as GitHub advises. */
const JWT_BACKDATE_SECONDS = 60
const JWT_LIFETIME_SECONDS = 540
const MILLISECONDS_PER_SECOND = 1000
const CONFIG_SHAPE = '{ "appId": <number>, "installationId": <number>, "privateKeyPath": "<.pem>" }'

/** The App config, or `undefined` when this machine has none. Throws on a file that is not a config. */
export function readReviewAppConfig(path: string = REVIEW_APP_CONFIG_PATH): ReviewAppConfig | undefined {
  if (!existsSync(path)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const config = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<ReviewAppConfig>
  if (
    !Number.isInteger(config.appId) ||
    !Number.isInteger(config.installationId) ||
    typeof config.privateKeyPath !== 'string'
  ) {
    throw new Error(`${path}: needs ${CONFIG_SHAPE}`)
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

/** The `fetch` this module calls GitHub with; a test passes its own. */
export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>

async function githubJson(
  fetchGithub: GithubFetch,
  path: string,
  jsonWebToken: string,
  body?: object,
): Promise<Record<string, unknown>> {
  const response = await fetchGithub(`${GITHUB_API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${jsonWebToken}`, Accept: 'application/vnd.github+json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  // The status first: an error answer need not be JSON, and its status is the useful part.
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`)
  return (await response.json()) as Record<string, unknown>
}

/** Who a run is on GitHub: the model's read-only token, the runner's posting token, and the login they post as. */
export interface ReviewIdentity {
  readonly readToken: string
  readonly postToken: string
  /** `<app-slug>[bot]`: the author of the status comment a run updates. */
  readonly login: string
}

/**
 * Two one-hour installation tokens for ONE repository (`repositoryName`, without its owner), and
 * the App's bot login.
 */
export async function reviewAppIdentity(
  config: ReviewAppConfig,
  repositoryName: string,
  fetchGithub: GithubFetch = fetch,
): Promise<ReviewIdentity> {
  const jsonWebToken = appJsonWebToken(config.appId, readFileSync(config.privateKeyPath, 'utf8'))
  const tokenPath = `/app/installations/${config.installationId}/access_tokens`
  const app = await githubJson(fetchGithub, '/app', jsonWebToken)
  const read = await githubJson(fetchGithub, tokenPath, jsonWebToken, {
    repositories: [repositoryName],
    permissions: READ_TOKEN_PERMISSIONS,
  })
  const post = await githubJson(fetchGithub, tokenPath, jsonWebToken, {
    repositories: [repositoryName],
    permissions: POST_TOKEN_PERMISSIONS,
  })
  if (typeof read.token !== 'string' || typeof post.token !== 'string' || typeof app.slug !== 'string') {
    throw new Error('GitHub answered without a token or an App slug')
  }
  return { readToken: read.token, postToken: post.token, login: `${app.slug}[bot]` }
}
