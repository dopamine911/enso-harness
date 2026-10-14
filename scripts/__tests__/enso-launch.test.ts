import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { permissionEngineConfigPath } from '@enso/core/permission-rules'
import { flowTrace } from '@enso/test-support/flow-trace'
import { recordEnsoLogs, releaseEnsoLogs } from '@enso/test-support/log-recorder'
import { piVersionText, SUPPORTED_PI_VERSIONS } from '../../packages/core/src/supported-pi-versions.ts'
import { isPrintRun, isRegisteredProject, piArguments, projectLine } from '../enso-launch.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The terminal launcher's decisions (docs/flows/boot-and-launchers.md). What `enso.ts` decides
 * before spawning is pinned as pure functions — the isolation triple and the print-run reading —
 * and one test below drives `enso.ts` itself, against a `pi` shim first on `PATH`. The version
 * range moved to `@enso/core` with #953, because the harness checks it too, and its boundaries are
 * pinned there (`packages/core/src/__tests__/supported-pi-versions.test.ts`). The vendor-path
 * precondition moved out with #221 — it is pi's manifest layout, not the launcher's decision,
 * and is pinned at its owner (`packages/core/src/__tests__/pi-manifest.test.ts`). Whether the
 * RANGE still covers the pi the guard corpus pins against is a different question again, and
 * is `pi-version-parity.test.ts`, beside this file.
 */

// ⚠ THE ISOLATION TRIPLE. Two legs are arguments and one is the environment; the arguments
// must be exactly these, in this order, BEFORE whatever the user passed — a flag the user adds
// cannot displace `--no-skills`, which neither of the other two covers (header).
// @pins boot-and-launchers/isolation-triple boot-and-launchers/package-dir
test('pi is launched with --no-extensions, --no-skills and -e <package>, ahead of the user’s arguments', () => {
  expect(piArguments('/pkg', ['-p', 'hello'])).toEqual(['--no-extensions', '--no-skills', '-e', '/pkg', '-p', 'hello'])
  expect(piArguments('/pkg', [])).toEqual(['--no-extensions', '--no-skills', '-e', '/pkg'])
})

// @pins boot-and-launchers/print-mirror
test('a print run is -p, --print, or stdin that is not a TTY; an interactive run is none of those', () => {
  expect(isPrintRun(['-p', 'x'], true)).toBe(true)
  expect(isPrintRun(['--print', 'x'], true)).toBe(true)
  expect(isPrintRun([], false)).toBe(true)
  expect(isPrintRun([], true)).toBe(false)
  expect(isPrintRun(['--model', 'x'], true)).toBe(false)
})

// #552: the terminal's project is the directory it is launched in. The web lists that project's
// threads only if it is registered — or is the web's own launch directory, which has no entry.
test("a launch directory is 'registered' when projects.json names it OR it is the web's launch directory; a subdirectory of a registered project is neither (#552)", () => {
  const registered = ['/srv/app', '/srv/lib']
  expect(isRegisteredProject('/srv/app', registered, '/home/u/enso')).toBe(true)
  expect(isRegisteredProject('/home/u/enso', registered, '/home/u/enso')).toBe(true)
  expect(isRegisteredProject('/srv/app/packages/web', registered, '/home/u/enso')).toBe(false)
  expect(isRegisteredProject('/home/u/enso/packages/web', [], '/home/u/enso')).toBe(false)
  expect(projectLine({ projectId: 'abcd', cwd: '/srv/app', registered: true })).toBe('enso: project=abcd (/srv/app)')
  expect(projectLine({ projectId: 'abcd', cwd: '/srv/x', registered: false })).toContain('not in projects.json')
})

// ── the launch itself: enso.ts, end to end, against a pi shim ─────────────────────────────

/** A `pi` first on `PATH` that answers `--version` and records every call's argv and env. */
function piShim(directory: string, version: string): string {
  const script = join(directory, 'pi')
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${join(directory, 'calls')}'`,
      `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
      `for argument in "$@"; do printf '%s\\n' "$argument"; done > '${join(directory, 'argv')}'`,
      `printf '%s\\n' "$PI_CODING_AGENT_DIR" > '${join(directory, 'env')}'`,
      '',
    ].join('\n'),
  )
  chmodSync(script, 0o755)
  return directory
}

const extensionName = (extensionPath: string): string =>
  extensionPath.startsWith('node_modules/')
    ? (extensionPath.split('/').at(-2) ?? extensionPath)
    : basename(dirname(extensionPath))

// ⚠ The one test that runs the launcher rather than its decisions. Piped stdin makes it a print
// run; ENSO_HOME points at a scratch dir, so no user state is read or moved. The diagram's arrows
// are the argv and env the shim received and the files the launcher left, with the scratch paths
// masked; the launcher writes stderr, not log records, so it has no notes.
// @pins boot-and-launchers/isolation-triple boot-and-launchers/package-dir boot-and-launchers/print-mirror
test('a print launch reads pi --version from PATH, then spawns that pi with the isolation triple and the print mirror', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'enso-launch-test-'))
  const logs = await recordEnsoLogs()
  try {
    const version = piVersionText(SUPPORTED_PI_VERSIONS.minimum)
    const shimDir = piShim(scratch, version)
    const home = join(scratch, 'home')
    const mask = (text: string): string => text.replaceAll(home, 'ENSO_HOME').replaceAll(repoRoot, '.')
    const trace = flowTrace({
      participants: {
        U: 'user shell (the test)',
        Z: 'terminal launcher (scripts/enso.ts)',
        M: 'manifest (packages/harness/package.json → pi)',
        X: 'print mirror (print-harness.ts)',
        P: 'pi on PATH (a shim)',
      },
      categories: {},
      logs,
    })

    trace.send('U', 'Z', 'bun scripts/enso.ts -p hello · stdin not a TTY')
    // Through `sh`, so the shim goes first on the inherited `PATH` without this file reading the
    // environment (`scripts/lint/process-environment.ts`).
    const launch = `PATH='${shimDir}':"$PATH" ENSO_HOME='${home}' exec '${process.execPath}' '${join(repoRoot, 'scripts', 'enso.ts')}' -p hello`
    const launcher = Bun.spawn(['/bin/sh', '-c', launch], {
      cwd: scratch,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await launcher.stdin.end()
    const [stderr, status] = await Promise.all([new Response(launcher.stderr).text(), launcher.exited])
    expect(status).toBe(0)
    const said = stderr.split('\n')
    const line = (prefix: string): string => mask(said.find((each) => each.startsWith(prefix)) ?? `(no ${prefix})`)

    const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', 'harness', 'package.json'), 'utf8'))
    const mirrorDir = join(repoRoot, 'node_modules', '.cache', 'enso', 'print-harness')
    const mirror = JSON.parse(readFileSync(join(mirrorDir, 'package.json'), 'utf8'))
    const calls = readFileSync(join(scratch, 'calls'), 'utf8').trim().split('\n')
    const argv = readFileSync(join(scratch, 'argv'), 'utf8').trim().split('\n')
    const [agentDir = ''] = readFileSync(join(scratch, 'env'), 'utf8').trim().split('\n')
    const resourceCount = /(\d+) declared resource path/.exec(stderr)?.[1] ?? '?'

    // The version is asked first, then pi is spawned: two calls, in that order.
    expect(calls).toEqual(['--version', argv.join(' ')])
    expect(argv).toEqual(piArguments(mirrorDir, ['-p', 'hello']))
    expect(agentDir).toBe(join(home, 'pi-agent'))
    // The engine reads its policy through the link the launcher made, before the spawn (#496).
    expect(realpathSync(permissionEngineConfigPath(agentDir))).toBe(realpathSync(join(home, 'permissions.json')))
    expect(mirror.pi.extensions).toEqual(
      manifest.pi.extensions.filter((extensionPath: string) => !extensionPath.includes('pi-permission-system')),
    )

    trace.send('Z', 'M', `read pi.* · ${resourceCount} declared resource paths, every node_modules/ path present`)
    trace.send('Z', 'U', line('enso: permission policy'))
    trace.send('Z', 'P', mask(`pi ${calls[0]}`))
    trace.send('P', 'Z', `${version} · exit 0`)
    trace.send(
      'Z',
      'X',
      `materialize: pi.extensions minus the permission engine (${mirror.pi.extensions.length} of ${manifest.pi.extensions.length}), every package-root entry linked`,
    )
    trace.send('Z', 'U', line('enso: vanilla pi'))
    trace.send('Z', 'P', mask(`spawn pi ${argv.join(' ')} · env PI_CODING_AGENT_DIR=${agentDir}`))
    trace.send('X', 'P', `pi.extensions in manifest order: ${mirror.pi.extensions.map(extensionName).join(' → ')}`)
    trace.send('P', 'Z', 'exit 0')
    trace.send('Z', 'U', `exit ${status}`)
    // The flow page's diagram (#482): what the launcher did, as its doubles and outputs saw it.
    expect(trace.diagram()).toMatchSnapshot('flow boot-and-launchers: the terminal launcher')
  } finally {
    await releaseEnsoLogs()
    rmSync(scratch, { recursive: true, force: true })
  }
})
