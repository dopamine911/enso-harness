import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { arenaLoginDir } from './run-home.ts'

/**
 * Dogfood Arena in a container (#676): `bun run arena container build | credential | start`.
 *
 * ⚠ WHY. Enso's coding agent runs whatever `bash` its work takes ON THE HOST, and a run on the host
 * once linked the operator's own login into its home (#610), where a token refresh revoked it (#639).
 * In the container, the run touches two things of the host and nothing else:
 *
 * - **its runs directory**, bind-mounted at the SAME absolute path it has on the host: the evidence
 *   comes out, and the agent's project lives in it. ⚠ The same path, not a fixed `/runs`: the
 *   manifest and score record absolute paths (the project, every screenshot), and a container path
 *   would not exist on the host — scored there, the run lost its project ("enso-did-the-work is
 *   unknown") and the report's screenshot links pointed out of the run;
 * - **the `enso-arena-credentials` volume**, mounted as the container's arena login directory (#763):
 *   the TEST account's `auth.json`, injected once through stdin, never through an argument or the
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
/**
 * Where the credentials volume is mounted: the arena login directory of the image's user (#763), so a
 * run inside reaches it as a run on the host does. The image links its `~/.enso/pi-agent` here too,
 * for the driver's model (`Dockerfile`).
 */
const CONTAINER_AGENT_DIRECTORY = arenaLoginDir({ XDG_DATA_HOME: '/home/pwuser/.local/share' })

/**
 * The `start` flags the container decides, refused from a caller: its home is the credentials
 * volume, its runs go to the mounted runs directory, its Chromium is the image's, nothing is headed, and `--manual`
 * would need a host-side `act` the container's loopback endpoint cannot hear.
 */
const CONTAINER_OWNED_FLAGS = ['--home', '--out', '--chromium', '--headed', '--manual'] as const

/**
 * The arguments to `docker` that build the image from the repository at `repoRoot`, its user taking
 * the building user's uid and gid (`owner`): the runs directory is a bind mount, which keeps host
 * ownership on native Linux Docker, so the container's user must be the host's to write a run.
 */
export function containerBuildArgs(
  repoRoot: string,
  owner: { readonly uid: number; readonly gid: number },
  image: string = ARENA_IMAGE,
): string[] {
  // ⚠ Built as root (under sudo, say), the remap would make the container's user
  // root — the run's bash with it. The image is for the unprivileged user who runs it.
  if (owner.uid === 0)
    throw new Error('the image is built for the user who runs it, and root is not one: build without sudo')
  return [
    'build',
    '--file',
    join(repoRoot, 'packages/arena/container/Dockerfile'),
    '--build-arg',
    `ARENA_UID=${owner.uid}`,
    '--build-arg',
    `ARENA_GID=${owner.gid}`,
    '--tag',
    image,
    repoRoot,
  ]
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

/** Where `docker` runs and says it could not: the host's `docker` and stderr, or a test's stand-ins (#838). */
export interface ArenaDockerHost {
  readonly program: string
  readonly warn: (line: string) => void
}

const HOST_DOCKER: ArenaDockerHost = {
  program: 'docker',
  warn: (line) => {
    process.stderr.write(`${line}\n`)
  },
}

/** `docker` with `args`, its output the caller's; the exit code, or 1 when docker could not be run. */
export function docker(args: readonly string[], input?: string, host: ArenaDockerHost = HOST_DOCKER): number {
  const ran = spawnSync(host.program, args, {
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    ...(input === undefined ? {} : { input }),
  })
  if (ran.error !== undefined) {
    host.warn(`arena: docker could not be run: ${ran.error.message}`)
    return 1
  }
  return ran.status ?? 1
}

/** All of standard input, as text. */
async function readStandardInput(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text()
}

/**
 * What the container commands reach outside themselves: docker, standard input, the user building
 * the image, and stderr. The real ones by default; a test's stand-ins so what each command hands
 * docker is checked without one (#832).
 */
export interface ContainerIo {
  readonly docker: (args: readonly string[], input?: string) => number
  readonly standardInput: () => Promise<string>
  readonly owner: () => { readonly uid: number; readonly gid: number }
  readonly warn: (line: string) => void
}

const HOST_IO: ContainerIo = {
  docker: (args, input) => docker(args, input),
  standardInput: readStandardInput,
  owner: () => ({ uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }),
  warn: HOST_DOCKER.warn,
}

/**
 * `credential --api-key-stdin` writes an Anthropic API key, read from stdin, into the volume;
 * `--from FILE` writes a test account's `auth.json`; `--status` names the providers it holds.
 */
async function credentialCommand(rest: readonly string[], io: ContainerIo): Promise<number> {
  if (rest.includes('--status')) return io.docker(containerCredentialStatusArgs())
  const fromIndex = rest.indexOf('--from')
  const file = fromIndex === -1 ? undefined : rest[fromIndex + 1]
  try {
    if (file !== undefined) return io.docker(containerCredentialArgs(), checkedAuthFile(readFileSync(file, 'utf8')))
    if (rest.includes('--api-key-stdin')) {
      return io.docker(containerCredentialArgs(), anthropicApiKeyAuth(await io.standardInput()))
    }
  } catch (error) {
    io.warn(`arena: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  io.warn('usage: bun run arena container credential --api-key-stdin | --from FILE | --status')
  return 1
}

/** `start <arena start arguments>`: one run in the container, under `--runs DIR` or the arena's default. */
function startCommand(rest: readonly string[], defaultOut: string, io: ContainerIo): number {
  const runsIndex = rest.indexOf('--runs')
  const runsDirectory = runsIndex === -1 ? defaultOut : (rest[runsIndex + 1] ?? defaultOut)
  const arenaArguments =
    runsIndex === -1
      ? rest
      : rest.filter((_argument, argumentIndex) => argumentIndex !== runsIndex && argumentIndex !== runsIndex + 1)
  const refusal = containerStartRefusal(arenaArguments)
  if (refusal !== undefined) {
    io.warn(`arena: ${refusal}`)
    return 1
  }
  if (!existsSync(runsDirectory)) mkdirSync(runsDirectory, { recursive: true })
  return io.docker(containerStartArgs({ runsDirectory, arenaArguments }))
}

/** `bun run arena container <build | credential | start> …` — the exit code. `build` builds this checkout. */
export async function runContainerCommand(
  argumentList: readonly string[],
  context: { readonly repoRoot: string; readonly defaultOut: string; readonly io?: ContainerIo },
): Promise<number> {
  const [subcommand, ...rest] = argumentList
  const io = context.io ?? HOST_IO
  switch (subcommand) {
    case 'build':
      try {
        return io.docker(containerBuildArgs(context.repoRoot, io.owner()))
      } catch (error) {
        io.warn(`arena: ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    case 'credential':
      return await credentialCommand(rest, io)
    case 'start':
      return startCommand(rest, context.defaultOut, io)
    default:
      io.warn(
        'usage: bun run arena container build | credential --api-key-stdin|--from FILE|--status | start --agent PROVIDER/MODEL [--runs DIR] [arena start flags]',
      )
      return 1
  }
}
