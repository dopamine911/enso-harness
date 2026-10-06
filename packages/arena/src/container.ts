import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Dogfood Arena in a container (#676): `bun run arena container build | credential | start`.
 *
 * ⚠ WHY. A run on the host links the operator's own login into its home (#610) — a token refresh
 * once revoked it (#639) — and Enso's coding agent runs whatever `bash` its work takes ON THE HOST.
 * In the container, the run touches two things of the host and nothing else:
 *
 * - **its runs directory**, bind-mounted at the SAME absolute path it has on the host: the evidence
 *   comes out, and the agent's project lives in it. ⚠ The same path, not a fixed `/runs`: the
 *   manifest and score record absolute paths (the project, every screenshot), and a container path
 *   would not exist on the host — scored there, the run lost its project ("enso-did-the-work is
 *   unknown") and the report's screenshot links pointed out of the run;
 * - **the `enso-arena-credentials` volume**, mounted as the container's `pi-agent` directory: the
 *   TEST account's `auth.json`, injected once through stdin, never through an argument or the
 *   environment (Enso scrubs provider keys from its environment anyway, #89). A Docker volume, not
 *   a host path, so the host's `~/.enso` is never reachable; and writable, so an OAuth refresh
 *   that rotates the token keeps it for the next run.
 *
 * No host network, no privilege, no Docker socket. `--manual` stays a host-only run: its `act`
 * command reaches the recorder's loopback endpoint, which is inside the container.
 */

/** The image `build` makes and `start` runs. */
const ARENA_IMAGE = 'enso-arena:latest'
/** The volume holding the test account's credentials: the container's whole `pi-agent` directory. */
export const ARENA_CREDENTIALS_VOLUME = 'enso-arena-credentials'
/** Where the image's user keeps Enso's home; its `pi-agent` is the credentials volume. */
const CONTAINER_AGENT_DIRECTORY = '/home/pwuser/.enso/pi-agent'

/**
 * The `start` flags the container decides, refused from a caller: its home is the credentials
 * volume, its runs go to the mounted runs directory, its Chromium is the image's, nothing is headed, and `--manual`
 * would need a host-side `act` the container's loopback endpoint cannot hear.
 */
const CONTAINER_OWNED_FLAGS = ['--home', '--out', '--chromium', '--headed', '--manual'] as const

/** The arguments to `docker` that build the image from the repository at `repoRoot`. */
function containerBuildArgs(repoRoot: string, image: string = ARENA_IMAGE): string[] {
  return ['build', '--file', join(repoRoot, 'packages/arena/container/Dockerfile'), '--tag', image, repoRoot]
}

/** Why a `start` argument list cannot run in the container, or undefined when it can. */
export function containerStartRefusal(arenaArguments: readonly string[]): string | undefined {
  const owned = arenaArguments.find((argument) => (CONTAINER_OWNED_FLAGS as readonly string[]).includes(argument))
  if (owned !== undefined) return `${owned} is the container's to decide: it is not taken by \`arena container start\``
  if (!arenaArguments.includes('--agent')) return 'a container run needs --agent PROVIDER/MODEL'
  return undefined
}

/**
 * The arguments to `docker` for one arena run in the container: the credentials volume and the
 * runs directory as its only mounts — the latter at its own host path, which is the run's `--out`
 * too — Chromium's shared memory, and `arena start` with the caller's arguments.
 */
export function containerStartArgs(options: {
  readonly runsDirectory: string
  readonly arenaArguments: readonly string[]
  readonly image?: string
}): string[] {
  const runsDirectory = resolve(options.runsDirectory)
  return [
    'run',
    '--rm',
    '--init',
    // Chromium's renderer needs more shared memory than Docker's 64 MB default.
    '--shm-size',
    '1g',
    '--mount',
    `type=volume,source=${ARENA_CREDENTIALS_VOLUME},target=${CONTAINER_AGENT_DIRECTORY}`,
    '--mount',
    `type=bind,source=${runsDirectory},target=${runsDirectory}`,
    options.image ?? ARENA_IMAGE,
    'start',
    '--out',
    runsDirectory,
    ...options.arenaArguments,
  ]
}

/**
 * The arguments to `docker` that write the credentials volume's `auth.json` from stdin, readable by
 * its owner only. The credential is the process's input, never an argument: nothing of it reaches
 * a process list or the container's environment.
 */
export function containerCredentialArgs(image: string = ARENA_IMAGE): string[] {
  return [
    'run',
    '--rm',
    '--interactive',
    '--mount',
    `type=volume,source=${ARENA_CREDENTIALS_VOLUME},target=${CONTAINER_AGENT_DIRECTORY}`,
    '--entrypoint',
    'sh',
    image,
    '-c',
    `umask 077 && cat > ${CONTAINER_AGENT_DIRECTORY}/auth.json`,
  ]
}

/**
 * The arguments to `docker` that say what the credentials volume holds — each provider and its
 * kind — never a value.
 */
function containerCredentialStatusArgs(image: string = ARENA_IMAGE): string[] {
  return [
    'run',
    '--rm',
    '--mount',
    `type=volume,source=${ARENA_CREDENTIALS_VOLUME},target=${CONTAINER_AGENT_DIRECTORY}`,
    '--entrypoint',
    'bun',
    image,
    '-e',
    [
      `const path = '${CONTAINER_AGENT_DIRECTORY}/auth.json'`,
      "const file = Bun.file(path); if (!(await file.exists())) { process.stdout.write('no credential\\n'); process.exit(1) }",
      'const held = await file.json()',
      "for (const [provider, credential] of Object.entries(held)) process.stdout.write(provider + ': ' + (credential?.type ?? 'unknown') + '\\n')",
    ].join('\n'),
  ]
}

/** pi's `auth.json` for one Anthropic API key — the simplest credential to inject: it never rotates. */
export function anthropicApiKeyAuth(key: string): string {
  const trimmed = key.trim()
  if (!/^sk-ant-[\w-]{20,}$/.test(trimmed)) throw new Error('that is not an Anthropic API key (sk-ant-…)')
  return `${JSON.stringify({ anthropic: { type: 'api_key', key: trimmed } }, null, 2)}\n`
}

/**
 * A test account's `auth.json` as given (`--from FILE`): parsed, and refused unless every entry is a
 * pi credential — an API key or an OAuth login — so a wrong file fails here, not in a run.
 */
export function checkedAuthFile(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('the credential file is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('the credential file holds no provider')
  }
  for (const [provider, credential] of Object.entries(parsed)) {
    const kind =
      typeof credential === 'object' && credential !== null && 'type' in credential ? credential.type : undefined
    if (kind !== 'api_key' && kind !== 'oauth') throw new Error(`${provider}: not a pi credential (api_key or oauth)`)
  }
  return text.endsWith('\n') ? text : `${text}\n`
}

/** `docker` with `args`, its output the caller's; the exit code, or 1 when docker could not be run. */
function docker(args: readonly string[], input?: string): number {
  const ran = spawnSync('docker', args, {
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    ...(input === undefined ? {} : { input }),
  })
  if (ran.error !== undefined) {
    process.stderr.write(`arena: docker could not be run: ${ran.error.message}\n`)
    return 1
  }
  return ran.status ?? 1
}

/** All of standard input, as text. */
async function readStandardInput(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text()
}

/**
 * `credential --api-key-stdin` writes an Anthropic API key, read from stdin, into the volume;
 * `--from FILE` writes a test account's `auth.json`; `--status` names the providers it holds.
 */
async function credentialCommand(rest: readonly string[]): Promise<number> {
  if (rest.includes('--status')) return docker(containerCredentialStatusArgs())
  const fromIndex = rest.indexOf('--from')
  const file = fromIndex === -1 ? undefined : rest[fromIndex + 1]
  try {
    if (file !== undefined) return docker(containerCredentialArgs(), checkedAuthFile(readFileSync(file, 'utf8')))
    if (rest.includes('--api-key-stdin')) {
      return docker(containerCredentialArgs(), anthropicApiKeyAuth(await readStandardInput()))
    }
  } catch (error) {
    process.stderr.write(`arena: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  process.stderr.write('usage: bun run arena container credential --api-key-stdin | --from FILE | --status\n')
  return 1
}

/** `start <arena start arguments>`: one run in the container, under `--runs DIR` or the arena's default. */
function startCommand(rest: readonly string[], defaultOut: string): number {
  const runsIndex = rest.indexOf('--runs')
  const runsDirectory = runsIndex === -1 ? defaultOut : (rest[runsIndex + 1] ?? defaultOut)
  const arenaArguments =
    runsIndex === -1
      ? rest
      : rest.filter((_argument, argumentIndex) => argumentIndex !== runsIndex && argumentIndex !== runsIndex + 1)
  const refusal = containerStartRefusal(arenaArguments)
  if (refusal !== undefined) {
    process.stderr.write(`arena: ${refusal}\n`)
    return 1
  }
  if (!existsSync(runsDirectory)) mkdirSync(runsDirectory, { recursive: true })
  return docker(containerStartArgs({ runsDirectory, arenaArguments }))
}

/** `bun run arena container <build | credential | start> …` — the exit code. `build` builds this checkout. */
export async function runContainerCommand(
  argumentList: readonly string[],
  context: { readonly repoRoot: string; readonly defaultOut: string },
): Promise<number> {
  const [subcommand, ...rest] = argumentList
  switch (subcommand) {
    case 'build':
      return docker(containerBuildArgs(context.repoRoot))
    case 'credential':
      return await credentialCommand(rest)
    case 'start':
      return startCommand(rest, context.defaultOut)
    default:
      process.stderr.write(
        'usage: bun run arena container build | credential --api-key-stdin|--from FILE|--status | start --agent PROVIDER/MODEL [--runs DIR] [arena start flags]\n',
      )
      return 1
  }
}
