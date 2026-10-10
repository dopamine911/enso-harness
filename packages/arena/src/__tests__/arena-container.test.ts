import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ContainerIo,
  ARENA_CREDENTIALS_VOLUME,
  anthropicApiKeyAuth,
  checkedAuthFile,
  containerBuildArgs,
  containerCredentialArgs,
  containerStartArgs,
  containerStartRefusal,
  docker,
  runContainerCommand,
} from '../container.ts'

/**
 * Dogfood Arena in a container (#676). The run's isolation is the `docker run` it is started with,
 * so what that command may and may not carry is pinned here; the image itself is proven by a run.
 */

/** Each `--mount` value of a docker argument list. */
const mountsOf = (dockerArguments: readonly string[]): string[] =>
  dockerArguments.flatMap((argument, index) => (dockerArguments[index - 1] === '--mount' ? [argument] : []))

// ⚠ #676, after #639: a run on the host linked the operator's login, and a refresh in the run revoked it.
test('⚠ a container run mounts the credentials volume and its run directory — nothing else of the host', () => {
  const dockerArguments = containerStartArgs({
    runsDirectory: 'relative/runs',
    arenaArguments: ['--agent', 'anthropic/claude-sonnet-5-5', '--scenario', 'iterate'],
  })
  const runs = `${process.cwd()}/relative/runs`
  expect(mountsOf(dockerArguments)).toEqual([
    // The arena login directory of the image's user (#763): the path the Dockerfile makes and links.
    `type=volume,source=${ARENA_CREDENTIALS_VOLUME},target=/home/pwuser/.local/share/enso/arena-login/.enso/pi-agent`,
    // Resolved (docker reads a relative bind source as a volume name), and at the SAME path inside:
    // the manifest's absolute paths must exist on the host too, or the host scores a lost project.
    `type=bind,source=${runs},target=${runs}`,
  ])
  for (const forbidden of [
    '--volume',
    '-v',
    '--network',
    '--net',
    '--privileged',
    '--env',
    '-e',
    '--env-file',
    '--cap-add',
  ]) {
    expect(dockerArguments).not.toContain(forbidden)
  }
  expect(dockerArguments.join(' ')).not.toContain('docker.sock')
  // The caller's arguments reach `arena start`, after the container's own --out: the mounted path.
  expect(dockerArguments.slice(-7)).toEqual([
    'start',
    '--out',
    runs,
    '--agent',
    'anthropic/claude-sonnet-5-5',
    '--scenario',
    'iterate',
  ])
})

test('the flags the container decides are refused, and a container run needs an agent', () => {
  for (const owned of ['--home', '--out', '--chromium', '--headed', '--manual']) {
    expect(containerStartRefusal(['--agent', 'anthropic/claude-sonnet-5-5', owned, 'x'])).toContain(owned)
  }
  expect(containerStartRefusal(['--scenario', 'snake'])).toContain('--agent')
  expect(containerStartRefusal(['--agent', 'anthropic/claude-opus-5-5', '--minutes', '5'])).toBeUndefined()
})

// ⚠ PR #678 review: the base image's pwuser is uid 1001; a bind mount keeps host ownership on native
// Linux Docker, so a container user who is not the host's could not write a run.
test('⚠ the image is built for the building user: its uid and gid go in as build arguments, and root is refused', () => {
  const dockerArguments = containerBuildArgs('/repo', { uid: 1234, gid: 5678 })
  const buildArguments = dockerArguments.flatMap((argument, index) =>
    dockerArguments[index - 1] === '--build-arg' ? [argument] : [],
  )
  expect(buildArguments).toEqual(['ARENA_UID=1234', 'ARENA_GID=5678'])
  // Under sudo the remap would make the container's user root, and the run's bash with it.
  expect(() => containerBuildArgs('/repo', { uid: 0, gid: 0 })).toThrow('root is not one')
})

test('⚠ the credential reaches the volume through stdin only: never an argument, never the environment', () => {
  const key = 'sk-ant-api03-notarealkey-0123456789abcdef'
  const auth = anthropicApiKeyAuth(`${key}\n`)
  expect(JSON.parse(auth)).toEqual({ anthropic: { type: 'api_key', key } })
  const dockerArguments = containerCredentialArgs()
  expect(dockerArguments).toContain('--interactive')
  expect(dockerArguments.join(' ')).not.toContain('sk-ant-')
  expect(dockerArguments).not.toContain('--env')
  // Written readable by its owner only.
  expect(dockerArguments.at(-1)).toContain('umask 077')
})

test('a credential that is not one is refused before it reaches the volume', () => {
  expect(() => anthropicApiKeyAuth('hunter2')).toThrow('not an Anthropic API key')
  expect(() => checkedAuthFile('not json')).toThrow('not JSON')
  expect(() => checkedAuthFile('{}')).toThrow('holds no provider')
  expect(() => checkedAuthFile('[]')).toThrow('holds no provider')
  expect(() => checkedAuthFile('{"anthropic":{"key":"x"}}')).toThrow('anthropic: not a pi credential')
  // A test account's OAuth login and an API key both pass, as given.
  const oauth = '{"anthropic":{"type":"oauth","access":"a","refresh":"r","expires":1}}'
  expect(checkedAuthFile(oauth)).toBe(`${oauth}\n`)
  expect(checkedAuthFile('{"openai":{"type":"api_key","key":"k"}}\n')).toBe('{"openai":{"type":"api_key","key":"k"}}\n')
})

/** The container commands over stand-ins: each docker call with its input, and each line said on stderr. */
function containerIo(
  owner = { uid: 1234, gid: 5678 },
  standardInput = '',
): {
  readonly io: ContainerIo
  readonly calls: { readonly args: readonly string[]; readonly input?: string }[]
  readonly warned: string[]
} {
  const calls: { readonly args: readonly string[]; readonly input?: string }[] = []
  const warned: string[] = []
  return {
    io: {
      docker: (args, input) => {
        calls.push(input === undefined ? { args } : { args, input })
        return 0
      },
      standardInput: () => Promise.resolve(standardInput),
      owner: () => owner,
      warn: (line) => warned.push(line),
    },
    calls,
    warned,
  }
}

const runContainer = (
  argumentList: readonly string[],
  io: ContainerIo,
  defaultOut = '/tmp/arena-default-out',
): Promise<number> => runContainerCommand(argumentList, { repoRoot: '/repo', defaultOut, io })

test('`container build` builds this checkout for the user running it; as root it builds nothing and exits 1', async () => {
  const { io, calls } = containerIo()
  expect(await runContainer(['build'], io)).toBe(0)
  expect(calls).toEqual([{ args: containerBuildArgs('/repo', { uid: 1234, gid: 5678 }) }])

  const root = containerIo({ uid: 0, gid: 0 })
  expect(await runContainer(['build'], root.io)).toBe(1)
  expect(root.calls).toEqual([])
  expect(root.warned).toEqual([
    'arena: the image is built for the user who runs it, and root is not one: build without sudo',
  ])
})

test('⚠ `container credential --api-key-stdin` hands docker the key as its input, never as an argument', async () => {
  const key = 'sk-ant-api03-notarealkey-0123456789abcdef'
  const { io, calls } = containerIo(undefined, `${key}\n`)
  expect(await runContainer(['credential', '--api-key-stdin'], io)).toBe(0)
  expect(calls).toEqual([{ args: containerCredentialArgs(), input: anthropicApiKeyAuth(key) }])
  expect(calls[0]?.args.join(' ')).not.toContain(key)
})

test('`container credential --from FILE` writes the file only once it reads as a pi credential', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-container-'))
  const good = join(directory, 'auth.json')
  writeFileSync(good, '{"anthropic":{"type":"api_key","key":"k"}}')
  const bad = join(directory, 'not-auth.json')
  writeFileSync(bad, '{"anthropic":{"key":"k"}}')

  const { io, calls, warned } = containerIo()
  expect(await runContainer(['credential', '--from', good], io)).toBe(0)
  expect(calls).toEqual([{ args: containerCredentialArgs(), input: '{"anthropic":{"type":"api_key","key":"k"}}\n' }])

  expect(await runContainer(['credential', '--from', bad], io)).toBe(1)
  expect(await runContainer(['credential', '--from', join(directory, 'absent.json')], io)).toBe(1)
  expect(calls).toHaveLength(1)
  expect(warned[0]).toBe('arena: anthropic: not a pi credential (api_key or oauth)')
  expect(warned[1]).toContain('ENOENT')
})

test('`container credential --status` reads the volume and writes nothing; with no mode it is the usage, and no docker', async () => {
  const { io, calls, warned } = containerIo()
  expect(await runContainer(['credential', '--status'], io)).toBe(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.input).toBeUndefined()
  expect(calls[0]?.args).not.toContain('--interactive')
  expect(mountsOf(calls[0]?.args ?? [])).toEqual(mountsOf(containerCredentialArgs()))

  expect(await runContainer(['credential'], io)).toBe(1)
  expect(await runContainer(['credential', '--from'], io)).toBe(1)
  expect(calls).toHaveLength(1)
  expect(warned).toEqual([
    'usage: bun run arena container credential --api-key-stdin | --from FILE | --status',
    'usage: bun run arena container credential --api-key-stdin | --from FILE | --status',
  ])
})

test('`container start` runs under `--runs DIR`, made when absent and not passed on; a refused flag runs nothing', async () => {
  const runs = join(mkdtempSync(join(tmpdir(), 'arena-container-')), 'runs')
  const { io, calls, warned } = containerIo()
  expect(await runContainer(['start', '--runs', runs, '--agent', 'anthropic/claude', '--minutes', '5'], io)).toBe(0)
  expect(existsSync(runs)).toBe(true)
  expect(calls).toEqual([
    {
      args: containerStartArgs({
        runsDirectory: runs,
        arenaArguments: ['--agent', 'anthropic/claude', '--minutes', '5'],
      }),
    },
  ])

  const defaultOut = join(runs, 'default')
  expect(await runContainer(['start', '--agent', 'anthropic/claude'], io, defaultOut)).toBe(0)
  expect(calls[1]).toEqual({
    args: containerStartArgs({ runsDirectory: defaultOut, arenaArguments: ['--agent', 'anthropic/claude'] }),
  })

  expect(await runContainer(['start', '--agent', 'anthropic/claude', '--headed'], io)).toBe(1)
  expect(await runContainer(['start', '--runs', runs], io)).toBe(1)
  expect(calls).toHaveLength(2)
  expect(warned).toEqual([
    "arena: --headed is the container's to decide: it is not taken by `arena container start`",
    'arena: a container run needs --agent PROVIDER/MODEL',
  ])
})

test('an unknown `container` subcommand is the usage, exit 1, and no docker', async () => {
  const { io, calls, warned } = containerIo()
  expect(await runContainer(['push'], io)).toBe(1)
  expect(await runContainer([], io)).toBe(1)
  expect(calls).toEqual([])
  expect(warned).toHaveLength(2)
  expect(warned[0]).toStartWith('usage: bun run arena container build | credential')
})

test('`docker` answers its exit code, hands it the input on stdin, and says so when it cannot be run at all', () => {
  const warned: string[] = []
  const shell = { program: 'sh', warn: (line: string) => warned.push(line) }
  expect(docker(['-c', 'exit 3'], undefined, shell)).toBe(3)
  // A credential goes in on stdin, never on the command line.
  expect(docker(['-c', 'read -r key; [ "$key" = sk-ant-x ]'], 'sk-ant-x\n', shell)).toBe(0)
  expect(docker(['-c', 'read -r key; [ "$key" = sk-ant-x ]'], 'other\n', shell)).toBe(1)
  expect(warned).toEqual([])

  const missing = { program: join(tmpdir(), 'no-docker-here'), warn: (line: string) => warned.push(line) }
  expect(docker(['version'], undefined, missing)).toBe(1)
  expect(warned).toEqual([expect.stringMatching(/^arena: docker could not be run: /)])
})
