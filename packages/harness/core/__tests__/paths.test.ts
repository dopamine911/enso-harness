import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_GUARD_POLICY } from '@enso/core'
import {
  isInsideAnyRoot,
  isPersistenceWriteTarget,
  isProtectedForWrite,
  looksLikeSecret,
  normalizeWindowsShellPath,
  resolveAgainstCwd,
} from '../paths.ts'

const root = mkdtempSync(join(tmpdir(), 'enso-guard-'))
const outside = mkdtempSync(join(tmpdir(), 'enso-outside-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(outside, 'target.txt'), 'x')

test('a relative path inside the workspace is allowed', () => {
  const target = resolveAgainstCwd('src/app.ts', root)
  expect(isInsideAnyRoot(target, [root])).toBe(true)
})

// ⚠ FAIL CLOSED (#53 S3): no roots means nothing is inside — a misconfigured policy with an
// empty root list must deny, not allow, every write.
test('an empty root list refuses every path', () => {
  expect(isInsideAnyRoot(resolveAgainstCwd('src/app.ts', root), [])).toBe(false)
  expect(isInsideAnyRoot(root, [])).toBe(false)
})

test('an absolute path outside the workspace is refused', () => {
  const target = resolveAgainstCwd(join(outside, 'app.ts'), root)
  expect(isInsideAnyRoot(target, [root])).toBe(false)
})

test('a ../ escape is refused', () => {
  const target = resolveAgainstCwd('../../etc/passwd', root)
  expect(isInsideAnyRoot(target, [root])).toBe(false)
})

test("a sibling directory sharing a name prefix is not 'inside'", () => {
  expect(isInsideAnyRoot(`${root}-evil/x.ts`, [root])).toBe(false)
})

test('⚠ a symlink inside the workspace pointing outside it is refused', () => {
  // The case a plain string-containment check lets through.
  const link = join(root, 'escape')
  symlinkSync(outside, link, 'dir')
  const target = resolveAgainstCwd('escape/target.txt', root)
  expect(target.startsWith(root)).toBe(true) // string check would pass
  expect(isInsideAnyRoot(target, [root])).toBe(false) // realpath check catches it
})

test('credential material is recognised by basename and by directory', () => {
  const f = DEFAULT_GUARD_POLICY.secretPathFragments
  expect(looksLikeSecret('/home/u/project/.env', f)).toBe(true)
  expect(looksLikeSecret('/home/u/project/.env.production', f)).toBe(true)
  expect(looksLikeSecret('/home/u/.ssh/id_ed25519', f)).toBe(true)
  expect(looksLikeSecret('/home/u/.aws/credentials', f)).toBe(true)
  expect(looksLikeSecret('/home/u/certs/server.pem', f)).toBe(true)
  expect(looksLikeSecret('/home/u/project/src/env.ts', f)).toBe(false)
  expect(looksLikeSecret('/home/u/project/README.md', f)).toBe(false)
})

test('⚠ a symlink with an innocent name pointing at credential material is recognised', () => {
  // The reader gate's own hole, the mirror of the workspace-boundary case above: pi follows
  // the link, so judging only the literal name reads `~/.aws/credentials` as `notes.txt`.
  const credentials = join(outside, '.aws')
  mkdirSync(credentials, { recursive: true })
  writeFileSync(join(credentials, 'credentials'), 'aws_secret_access_key = x')
  const link = join(root, 'notes.txt')
  symlinkSync(join(credentials, 'credentials'), link, 'file')
  const f = DEFAULT_GUARD_POLICY.secretPathFragments
  expect(looksLikeSecret(link, f)).toBe(true)
})

test("⚠ a process's environment is credential material — the bash deny's twin, for read", () => {
  const f = DEFAULT_GUARD_POLICY.secretPathFragments
  expect(looksLikeSecret('/proc/self/environ', f)).toBe(true)
  expect(looksLikeSecret('/proc/1234/environ', f)).toBe(true)
  // Neighbouring /proc entries are ordinary reads.
  expect(looksLikeSecret('/proc/self/status', f)).toBe(false)
  expect(looksLikeSecret('/home/u/project/environ.ts', f)).toBe(false)
})

// ── #21: write-persistence vectors ────────────────────────────────────────────────────────

test('every shell-init basename is a persistence write target', () => {
  for (const name of ['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile']) {
    expect(isPersistenceWriteTarget(`/home/u/${name}`)).toBe(true)
  }
})

test('git config files are persistence write targets, wherever they live', () => {
  expect(isPersistenceWriteTarget('/home/u/.gitconfig')).toBe(true)
  expect(isPersistenceWriteTarget(join(root, '.gitmodules'))).toBe(true)
})

test('agent and tool config files are persistence write targets', () => {
  expect(isPersistenceWriteTarget('/home/u/.claude.json')).toBe(true)
  expect(isPersistenceWriteTarget(join(root, '.mcp.json'))).toBe(true)
  expect(isPersistenceWriteTarget(join(root, '.ripgreprc'))).toBe(true)
})

test('anything inside a dangerous directory is a persistence write target', () => {
  expect(isPersistenceWriteTarget(join(root, '.vscode', 'tasks.json'))).toBe(true)
  expect(isPersistenceWriteTarget(join(root, '.idea', 'workspace.xml'))).toBe(true)
  expect(isPersistenceWriteTarget(join(root, '.claude', 'settings.json'))).toBe(true)
  expect(isPersistenceWriteTarget(join(root, '.git', 'hooks', 'pre-commit'))).toBe(true)
})

// ⚠ The ZEN ADDITIONS: pi's OWN persistence surfaces, which picc's Claude-Code corpus
// cannot know about. Each line is a real load path (receipts in scripts/enso.ts's header).
test("pi's own persistence surfaces are write targets — the enso additions", () => {
  // A project-local .pi/settings.json installs an extension for the next plain `pi` run.
  expect(isPersistenceWriteTarget(join(root, '.pi', 'settings.json'))).toBe(true)
  // pi discovers skills from ~/.agents/skills/ even under a redirected agent dir.
  expect(isPersistenceWriteTarget('/home/u/.agents/skills/evil/SKILL.md')).toBe(true)
  // The harness's own agent dir holds settings, extensions and auth for future sessions.
  expect(isPersistenceWriteTarget(join(root, '.enso', 'pi-agent', 'settings.json'))).toBe(true)
  // Segment-anchored, like the vendored list: a name merely containing one is NOT caught.
  expect(isPersistenceWriteTarget(join(root, 'api', 'spec.ts'))).toBe(false)
  expect(isPersistenceWriteTarget(join(root, 'pi-tools', 'x.ts'))).toBe(false)
})

test('matching is case-insensitive, for case-folding filesystems', () => {
  expect(isPersistenceWriteTarget('/home/u/.BASHRC')).toBe(true)
  expect(isPersistenceWriteTarget(join(root, '.VSCode', 'tasks.json'))).toBe(true)
})

// ⚠ Basename-ANCHORED, never fragment matching — the false-positive class the issue names.
test('a name merely containing a dangerous name is NOT caught', () => {
  expect(isPersistenceWriteTarget(join(root, '.profile-notes', 'x.ts'))).toBe(false)
  expect(isPersistenceWriteTarget(join(root, 'my.bashrc'))).toBe(false)
  expect(isPersistenceWriteTarget(join(root, 'vscode-notes', 'a.md'))).toBe(false)
  expect(isPersistenceWriteTarget(join(root, 'src', 'app.ts'))).toBe(false)
})

test('⚠ a symlink with an innocent name pointing at a shell-init file is caught', () => {
  // The write target EXISTS as a symlink; realpath reveals the true basename.
  const dotfiles = mkdtempSync(join(tmpdir(), 'enso-dotfiles-'))
  writeFileSync(join(dotfiles, '.bashrc'), '# rc')
  const link = join(root, 'innocent-notes.txt')
  symlinkSync(join(dotfiles, '.bashrc'), link)
  expect(isPersistenceWriteTarget(link)).toBe(true)
})

test('⚠ a NEW file through a symlinked directory that is really a dangerous dir is caught', () => {
  const agentConfigDir = mkdtempSync(join(tmpdir(), 'enso-agent-'))
  const realClaude = join(agentConfigDir, '.claude')
  mkdirSync(realClaude)
  const link = join(root, 'innocent-dir')
  symlinkSync(realClaude, link, 'dir')
  // settings.json does not exist yet — the nearest existing ancestor is the symlink.
  expect(isPersistenceWriteTarget(join(link, 'settings.json'))).toBe(true)
})

// ── #53 S1.1: the guard resolves paths exactly as pi's tools do ───────────────────────────
// pi's write/edit/read/grep/find/ls all resolve their `path` through `resolveToCwd`, which
// strips a leading `@`, expands `~`, decodes `file://` URLs and collapses unicode spaces.
// The guard used to do plain `resolve(cwd, path)`, so `@/etc/passwd` was judged as
// `<cwd>/@/etc/passwd` (inside the workspace) while pi wrote `/etc/passwd`.

test("⚠ a leading @ is stripped, as pi does — the audit's first bypass", () => {
  expect(resolveAgainstCwd('@/etc/passwd', root)).toBe('/etc/passwd')
  expect(resolveAgainstCwd('@src/app.ts', root)).toBe(join(root, 'src', 'app.ts'))
  expect(isInsideAnyRoot(resolveAgainstCwd('@/etc/passwd', root), [root])).toBe(false)
})

test('a mid-path @ is NOT stripped — only the leading one', () => {
  expect(resolveAgainstCwd('src/@scope/x.ts', root)).toBe(join(root, 'src', '@scope', 'x.ts'))
})

test("⚠ a ~ is expanded to the home directory, as pi does — the audit's second bypass", () => {
  expect(resolveAgainstCwd('~/evil.sh', root)).toBe(join(homedir(), 'evil.sh'))
  expect(resolveAgainstCwd('~', root)).toBe(homedir())
  expect(isInsideAnyRoot(resolveAgainstCwd('~/evil.sh', root), [root])).toBe(false)
})

test('~user is NOT expanded — pi only knows the bare ~ and ~/', () => {
  expect(resolveAgainstCwd('~alice/x', root)).toBe(join(root, '~alice', 'x'))
})

test("⚠ a file:// URL is decoded to its path, as pi does — the audit's third bypass", () => {
  expect(resolveAgainstCwd('file:///etc/cron.d/x', root)).toBe('/etc/cron.d/x')
  expect(isInsideAnyRoot(resolveAgainstCwd('file:///etc/cron.d/x', root), [root])).toBe(false)
})

test("the prefixes compose in pi's order: @ first, then ~ or file://", () => {
  expect(resolveAgainstCwd('@~/x', root)).toBe(join(homedir(), 'x'))
  expect(resolveAgainstCwd('@file:///tmp/x', root)).toBe('/tmp/x')
})

test('unicode spaces collapse to a plain space, as pi does', () => {
  // Written as escapes, never as literal characters — a literal NBSP is indistinguishable
  // from a space in an editor, and a row that secretly holds a plain space tests nothing.
  expect(resolveAgainstCwd('src/a\u00A0b.ts', root)).toBe(join(root, 'src', 'a b.ts'))
  expect(resolveAgainstCwd('src/a\u3000b.ts', root)).toBe(join(root, 'src', 'a b.ts'))
})

test('a ~-prefixed cwd is expanded too — pi normalises the base directory as well', () => {
  expect(resolveAgainstCwd('x.ts', '~/work')).toBe(join(homedir(), 'work', 'x.ts'))
})

test("⚠ a unicode space in the cwd is NOT collapsed — pi's base-directory options are the defaults", () => {
  // Found by the corpus test: the first replication collapsed it and pi does not.
  expect(resolveAgainstCwd('x.ts', join(root, 'a\u00A0b'))).toBe(join(root, 'a\u00A0b', 'x.ts'))
})

/**
 * ⚠ THE LOAD-BEARING TEST: the guard's resolver and pi's must agree byte-for-byte on every
 * input below. pi's `resolveToCwd` is not on the package's export map (only `.`,
 * `./rpc-entry` and `./client` are), so production code REPLICATES it in `paths.ts`; this
 * corpus is what keeps the copy honest. It reaches the real implementation by resolving the
 * package's entry point and walking to `utils/paths.js` beside it — the file pi's own
 * `core/tools/path-utils.js` imports. If pi grows a new normaliser rule, this goes red
 * BEFORE the guard silently disagrees with the tool it gates.
 *
 * ⚠ WHICH pi, exactly: the one in the WORKSPACE tree, which is the one the in-process host
 * imports (#69) and NOT, by construction, the `pi` the terminal launcher finds on `PATH`.
 * That second resolution is bounded by `scripts/enso-launch.ts#SUPPORTED_PI_VERSIONS` — the
 * launcher refuses a pi outside the range this corpus has been run against, and
 * `scripts/__tests__/pi-version-parity.test.ts` asserts the range still covers the pi resolved here (#217).
 *
 * Two failure shapes, read differently: an ASSERTION diff means pi changed how it
 * normalises — update the replica in `paths.ts`; a `Cannot find module` means pi moved or
 * renamed its internal `utils/paths.js` (no export-map contract covers it) — re-point the
 * walk below, the replica is not implicated.
 */
interface PiPathsModule {
  normalizeWindowsShellPath: (filePath: string) => string
  resolvePath: (
    input: string,
    baseDir: string,
    options: { normalizeUnicodeSpaces: boolean; stripAtPrefix: boolean },
  ) => string
}

test("⚠ corpus: the guard resolver agrees with pi's resolveToCwd on every input", async () => {
  // `import.meta.resolve`, not `require.resolve`: pi's export map declares an `import`
  // condition only, so the CommonJS resolver refuses the package outright.
  const piEntryPoint = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const piPaths = (await import(join(dirname(piEntryPoint), 'utils', 'paths.js'))) as PiPathsModule
  // The exact options pi's tools pass (core/tools/path-utils.js `resolveToCwd`).
  const piResolveToCwd = (input: string, cwd: string): string =>
    piPaths.resolvePath(input, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true })

  const corpus: readonly (readonly [input: string, cwd: string])[] = [
    ['src/app.ts', root],
    ['/etc/passwd', root],
    ['../../etc/passwd', root],
    ['@/etc/passwd', root],
    ['@', root],
    ['@relative/x.ts', root],
    ['src/@scope/x.ts', root],
    ['~', root],
    ['~/evil.sh', root],
    ['~alice/x', root],
    ['@~/x', root],
    ['~/@x', root],
    ['file:///etc/cron.d/x', root],
    ['@file:///tmp/x', root],
    ['src/a\u00A0b.ts', root],
    ['src/a\u2003b\u3000c.ts', root],
    ['x.ts', '~/work'],
    ['x.ts', '~'],
    // pi normalises the BASE DIRECTORY with default options — no unicode-space collapse.
    ['x.ts', join(root, 'a\u00A0b')],
    ['', root],
    ['.', root],
  ]
  for (const [input, cwd] of corpus) {
    expect(resolveAgainstCwd(input, cwd)).toBe(piResolveToCwd(input, cwd))
  }
})

/**
 * The Windows shell-path branch never runs on Linux, but the function is pure and pi
 * exports its own — so the replica is pinned against the real one here, on every input
 * shape: drive paths in the three spellings, a bare drive, and every early-return.
 */
test("⚠ corpus: normalizeWindowsShellPath agrees with pi's on every input", async () => {
  const piEntryPoint = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const piPaths = (await import(join(dirname(piEntryPoint), 'utils', 'paths.js'))) as PiPathsModule
  const corpus = [
    '/c/Users/x',
    '/mnt/c/Users/x',
    '/cygdrive/c/Users/x',
    '/C/x',
    '/c',
    '/c/',
    '/mnt/d',
    '//unc/share/x',
    '/etc/passwd',
    '/mnt/cc/x',
    'C:\\already\\native',
    '/c/with\\backslash',
    'relative/x',
    '',
  ]
  for (const input of corpus) {
    expect(normalizeWindowsShellPath(input)).toBe(piPaths.normalizeWindowsShellPath(input))
  }
  // And the receipt that the corpus is not vacuous: the drive spellings really do convert.
  expect(normalizeWindowsShellPath('/mnt/c/Users/x')).toBe('C:\\Users\\x')
  expect(normalizeWindowsShellPath('/c')).toBe('C:\\')
})

// ── #53 S1.2: the credential DIRECTORY itself is credential material ──────────────────────
// Every directory-shaped fragment carries a trailing `/`, and `resolve()` strips the trailing
// slash a model supplies — so `~/.aws` never contained `/.aws/`, and its basename `.aws`
// matches no SECRET_BASENAME_PATTERNS. `grep pattern=aws_secret path=~/.aws` went through.

test('⚠ the credential directory itself is recognised, not only files inside it', () => {
  const f = DEFAULT_GUARD_POLICY.secretPathFragments
  expect(looksLikeSecret('/home/u/.aws', f)).toBe(true)
  expect(looksLikeSecret('/home/u/.ssh', f)).toBe(true)
  expect(looksLikeSecret('/home/u/.gnupg', f)).toBe(true)
})

// One case per fragment that NO basename pattern satisfies — so emptying the fragment list
// fails here. (Before this, every fragment test was also satisfied by a basename regex, and
// deleting the fragment check failed zero tests.)
test('every secret path fragment is load-bearing on its own — a basename regex cannot stand in', () => {
  const fragments = DEFAULT_GUARD_POLICY.secretPathFragments
  const onlyTheFragmentCatches: Record<string, string> = {
    '/.ssh/': '/home/u/.ssh/known_hosts',
    '/.aws/': '/home/u/.aws/config',
    '/.gnupg/': '/home/u/.gnupg/pubring.kbx',
    '/.docker/config.json': '/home/u/.docker/config.json',
    '/.npmrc': '/home/u/.npmrc',
    '/.netrc': '/home/u/.netrc',
    '/.pgpass': '/home/u/.pgpass',
    '/.kube/config': '/home/u/.kube/config',
    // #204: `auth.json` matches no basename pattern, which is exactly how it was readable.
    '/.enso/': '/home/u/project/.enso/pi-agent/auth.json',
  }
  // The map must cover the policy exactly — a fragment added without a case here is a gap.
  expect(Object.keys(onlyTheFragmentCatches).sort()).toEqual([...fragments].sort())
  for (const [fragment, path] of Object.entries(onlyTheFragmentCatches)) {
    expect(looksLikeSecret(path, fragments)).toBe(true)
    // The receipt that the basename alone does NOT catch it: without its fragment, it passes.
    expect(
      looksLikeSecret(
        path,
        fragments.filter((other) => other !== fragment),
      ),
    ).toBe(false)
  }
})

test('a name merely containing a credential directory name is not caught', () => {
  const f = DEFAULT_GUARD_POLICY.secretPathFragments
  expect(looksLikeSecret('/home/u/project/aws-notes.md', f)).toBe(false)
  expect(looksLikeSecret('/home/u/project/.awsome/x.ts', f)).toBe(false)
})

test('a protected-write directory itself is protected, not only files inside it', () => {
  expect(isProtectedForWrite(join(root, '.git'), DEFAULT_GUARD_POLICY.protectedWriteFragments)).toBe(true)
  expect(isProtectedForWrite(join(root, '.github'), DEFAULT_GUARD_POLICY.protectedWriteFragments)).toBe(false)
})
