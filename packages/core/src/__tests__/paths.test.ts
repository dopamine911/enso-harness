import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ensoAgentDir,
  ensoHome,
  fileUrlToPath,
  findRepoRoot,
  harnessPackageDir,
  isFileUrl,
  migrateCheckoutEnso,
  migrateCheckoutEnsoOnLaunch,
  printHarnessDir,
  RepoRootNotFoundError,
  realpathOrSelf,
  webPackageDir,
} from '../paths.ts'

/**
 * `findRepoRoot` against tmp fixtures. ⚠ These fixtures double as the cwd-independence
 * proof: `bun test` runs with `process.cwd()` AT the Enso checkout — itself a
 * workspace root — so every assertion below that returns a TMP root would fail if the
 * walk consulted the cwd instead of the given file's ancestry.
 */

/** A fixture workspace root: package.json with `workspaces`, plus nested dirs. */
function makeWorkspaceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'enso-paths-fixture-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }))
  mkdirSync(join(root, 'packages', 'harness', 'extensions', 'deep'), { recursive: true })
  writeFileSync(join(root, 'packages', 'harness', 'extensions', 'deep', 'module.ts'), 'export {};\n')
  return root
}

test('finds the nearest ancestor whose package.json declares workspaces', () => {
  const root = makeWorkspaceFixture()
  const deepFile = join(root, 'packages', 'harness', 'extensions', 'deep', 'module.ts')
  expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(root))
})

test('accepts a file:// URL, so callers can pass import.meta.url directly', () => {
  const root = makeWorkspaceFixture()
  const deepFile = join(root, 'packages', 'harness', 'extensions', 'deep', 'module.ts')
  expect(realpathSync(findRepoRoot(pathToFileURL(deepFile).href))).toBe(realpathSync(root))
})

// ⚠ THE #59 TRAP, made to discriminate: the print harness (#20) runs extensions through a
// symlink mirror, and bun does NOT realpath import.meta.url through it (observed live,
// PR #58). Here the mirror lives inside a DIFFERENT workspace root, so a walk that skips
// the realpath finds the WRONG root — this test is red without realpath-first, not merely
// green with it (mutation-proven).
test('realpath FIRST: a symlinked mirror inside another workspace root still finds the REAL root', () => {
  const realRoot = makeWorkspaceFixture()
  const otherRoot = mkdtempSync(join(tmpdir(), 'enso-paths-other-'))
  writeFileSync(join(otherRoot, 'package.json'), JSON.stringify({ name: 'other', workspaces: [] }))
  mkdirSync(join(otherRoot, 'mirror'))
  symlinkSync(join(realRoot, 'packages', 'harness', 'extensions'), join(otherRoot, 'mirror', 'extensions'), 'dir')

  const throughMirror = join(otherRoot, 'mirror', 'extensions', 'deep', 'module.ts')
  expect(realpathSync(findRepoRoot(throughMirror))).toBe(realpathSync(realRoot))
})

test('a malformed package.json on the walk means keep walking, never a throw', () => {
  const root = makeWorkspaceFixture()
  const middle = join(root, 'packages', 'harness')
  writeFileSync(join(middle, 'package.json'), '{ this is not json')
  const deepFile = join(root, 'packages', 'harness', 'extensions', 'deep', 'module.ts')
  expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(root))
})

test('a package.json WITHOUT a workspaces field is not a root — the walk continues past it', () => {
  const root = makeWorkspaceFixture()
  const middle = join(root, 'packages', 'harness')
  writeFileSync(join(middle, 'package.json'), JSON.stringify({ name: 'Enso' }))
  const deepFile = join(root, 'packages', 'harness', 'extensions', 'deep', 'module.ts')
  expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(root))
})

test('a workspaces field with a shape npm rejects (null, string) is not a root either — PR #60 review', () => {
  const root = makeWorkspaceFixture()
  const middle = join(root, 'packages', 'harness')
  writeFileSync(join(middle, 'package.json'), JSON.stringify({ name: 'x', workspaces: null }))
  const deepFile = join(root, 'packages', 'harness', 'extensions', 'deep', 'module.ts')
  expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(root))
  // The object form npm DOES accept still counts as a root.
  writeFileSync(join(middle, 'package.json'), JSON.stringify({ name: 'x', workspaces: { packages: ['a'] } }))
  expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(middle))
})

test('no workspace root anywhere above throws a NAMED error carrying the start path', () => {
  const orphanDir = mkdtempSync(join(tmpdir(), 'enso-paths-orphan-'))
  const orphanFile = join(orphanDir, 'module.ts')
  writeFileSync(orphanFile, 'export {};\n')
  expect(() => findRepoRoot(orphanFile)).toThrow(RepoRootNotFoundError)
  expect(() => findRepoRoot(orphanFile)).toThrow(orphanFile)
})

test('realpathOrSelf returns the input unchanged for a path that does not exist', () => {
  expect(realpathOrSelf('/no/such/path/anywhere')).toBe('/no/such/path/anywhere')
})

test('the derived directories assemble from their roots: runtime under ENSO_HOME, the build cache in the checkout', () => {
  expect(ensoAgentDir('/home/u/.enso')).toBe('/home/u/.enso/pi-agent')
  expect(printHarnessDir('/repo')).toBe('/repo/node_modules/.cache/enso/print-harness')
  expect(harnessPackageDir('/repo')).toBe('/repo/packages/harness')
  expect(webPackageDir('/repo')).toBe('/repo/packages/web')
})

test("this checkout's own root is findable from this test file", () => {
  // ⚠ Assert properties of the root, never its NAME — the directory is machine-specific
  // (locally `Enso`, on CI `zen-harness-foundation`; caught by CI on PR #60).
  const root = findRepoRoot(import.meta.url)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
  expect('workspaces' in manifest).toBe(true)
  // The root is an ancestor of this very file (both realpath'd).
  expect(realpathSync(import.meta.dir).startsWith(realpathSync(root))).toBe(true)
})

test('isFileUrl / fileUrlToPath — the one shared file:// decoder (#53 added its second caller)', () => {
  expect(isFileUrl('file:///etc/cron.d/x')).toBe(true)
  expect(isFileUrl('/etc/cron.d/x')).toBe(false)
  expect(isFileUrl('https://example.test/x')).toBe(false)
  expect(fileUrlToPath('file:///etc/cron.d/x')).toBe('/etc/cron.d/x')
  expect(fileUrlToPath('file:///tmp/a%20b')).toBe('/tmp/a b')
})

// ── #421: ENSO_HOME, and the checkout's .enso moved into it ──────────────────────────────

test("ENSO_HOME is the environment's when set, else ~/.enso — pi's PI_CODING_AGENT_DIR pattern", () => {
  expect(ensoHome({ ENSO_HOME: '/elsewhere/.enso' })).toBe('/elsewhere/.enso')
  expect(ensoHome({})).toBe(join(homedir(), '.enso'))
  expect(ensoHome({ ENSO_HOME: '' })).toBe(join(homedir(), '.enso'))
})

/** A checkout holding a pre-#421 `.enso/`, and an ENSO_HOME for it to move into. */
function legacyCheckout(): { repoRoot: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'enso-migrate-'))
  const repoRoot = join(root, 'checkout')
  const legacy = join(repoRoot, '.enso')
  mkdirSync(join(legacy, 'pi-agent', 'sessions', '--project--'), { recursive: true })
  writeFileSync(join(legacy, 'pi-agent', 'auth.json'), '{"old":true}')
  writeFileSync(join(legacy, 'pi-agent', 'sessions', '--project--', 's1.jsonl'), 'session')
  writeFileSync(join(legacy, 'secrets.env'), 'TAVILY_API_KEY=x')
  mkdirSync(join(legacy, 'print-harness'))
  symlinkSync('../../packages/harness/core', join(legacy, 'print-harness', 'core'))
  return { repoRoot, home: join(root, 'home', '.enso') }
}

test("⚠ the checkout's .enso moves into ENSO_HOME whole, and the emptied .enso is gone (#421)", () => {
  const { repoRoot, home } = legacyCheckout()
  const migration = migrateCheckoutEnso(repoRoot, home)
  expect([...migration.moved].sort()).toEqual([
    'pi-agent/auth.json',
    'pi-agent/sessions/--project--/s1.jsonl',
    'secrets.env',
  ])
  expect(migration.kept).toEqual([])
  expect(readFileSync(join(home, 'pi-agent', 'auth.json'), 'utf8')).toBe('{"old":true}')
  expect(readFileSync(join(home, 'pi-agent', 'sessions', '--project--', 's1.jsonl'), 'utf8')).toBe('session')
  expect(existsSync(join(repoRoot, '.enso'))).toBe(false)
  // The build cache is regenerated elsewhere, never carried into ENSO_HOME with broken links.
  expect(existsSync(join(home, 'print-harness'))).toBe(false)
  expect(statSync(home).mode & 0o777).toBe(0o700)
})

test('⚠ a file ENSO_HOME already holds is never overwritten: it stays in the checkout and is reported (#421)', () => {
  const { repoRoot, home } = legacyCheckout()
  mkdirSync(join(home, 'pi-agent'), { recursive: true })
  writeFileSync(join(home, 'pi-agent', 'auth.json'), '{"already":true}')
  const migration = migrateCheckoutEnso(repoRoot, home)
  expect(migration.kept).toEqual(['pi-agent/auth.json'])
  expect(readFileSync(join(home, 'pi-agent', 'auth.json'), 'utf8')).toBe('{"already":true}')
  expect(readFileSync(join(repoRoot, '.enso', 'pi-agent', 'auth.json'), 'utf8')).toBe('{"old":true}')
  // Everything else still moved.
  expect(existsSync(join(home, 'secrets.env'))).toBe(true)
})

// The launch's rule: a scratch or test ENSO_HOME must never receive a checkout's logins — they
// would be lost with it. Only the default ~/.enso is migrated into without being asked.
test("⚠ with ENSO_HOME set explicitly, a launch moves nothing: the checkout's .enso is held and said (#421)", () => {
  const { repoRoot, home } = legacyCheckout()
  const migration = migrateCheckoutEnsoOnLaunch(repoRoot, { ENSO_HOME: home })
  expect(migration).toMatchObject({ moved: [], kept: [], held: true })
  expect(readFileSync(join(repoRoot, '.enso', 'pi-agent', 'auth.json'), 'utf8')).toBe('{"old":true}')
  expect(existsSync(home)).toBe(false)
})

test('migrating twice moves nothing the second time, and a checkout with no .enso creates no ENSO_HOME', () => {
  const { repoRoot, home } = legacyCheckout()
  migrateCheckoutEnso(repoRoot, home)
  expect(migrateCheckoutEnso(repoRoot, home)).toMatchObject({ moved: [], kept: [] })
  const fresh = mkdtempSync(join(tmpdir(), 'enso-fresh-'))
  const untouched = join(fresh, 'home', '.enso')
  expect(migrateCheckoutEnso(fresh, untouched)).toMatchObject({ moved: [], kept: [] })
  expect(existsSync(untouched)).toBe(false)
})
