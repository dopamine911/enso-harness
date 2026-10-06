import { expect, test } from 'bun:test'
import {
  ARENA_CREDENTIALS_VOLUME,
  anthropicApiKeyAuth,
  checkedAuthFile,
  containerBuildArgs,
  containerCredentialArgs,
  containerStartArgs,
  containerStartRefusal,
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
    `type=volume,source=${ARENA_CREDENTIALS_VOLUME},target=/home/pwuser/.enso/pi-agent`,
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
test('⚠ the image is built for the building user: its uid and gid go in as build arguments', () => {
  const dockerArguments = containerBuildArgs('/repo', { uid: 1234, gid: 5678 })
  const buildArguments = dockerArguments.flatMap((argument, index) =>
    dockerArguments[index - 1] === '--build-arg' ? [argument] : [],
  )
  expect(buildArguments).toEqual(['ARENA_UID=1234', 'ARENA_GID=5678'])
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
