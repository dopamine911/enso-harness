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
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  checkoutOrInstalledRoot,
  checkoutRootOfPackage,
  ensoAgentDir,
  ensoHome,
  ensoPermissionRulesPath,
  ensoProjectsDir,
  fileUrlToPath,
  findRepoRoot,
  HARNESS_PACKAGE_NAME,
  harnessPackageDir,
  installedPackageDir,
  isFileUrl,
  migrateCheckoutEnso,
  migrateCheckoutEnsoOnLaunch,
  migrateSessionsIntoProjects,
  PackageDirNotFoundError,
  printHarnessDir,
  projectIdOf,
  projectSessionsDir,
  projectTreesDir,
  RepoRootNotFoundError,
  realpathOrSelf,
  resolvePackageDir,
  threadTreeRoot,
  treeProjectId,
  WEB_PACKAGE_NAME,
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
  // The permission policy pi runs under (#446, #496): the user's, beside their config — not the
  // agent dir's, which a second agent dir (a test's, a worktree's) would not share.
  expect(ensoPermissionRulesPath('/home/u/.enso')).toBe('/home/u/.enso/permissions.json')
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
  expect([...migration.moved].toSorted()).toEqual([
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

// #754: a checkout's `.enso/` holding only the project's own tiers is no leftover, and a launch with
// ENSO_HOME set must not tell the operator to move it by hand.
test("with ENSO_HOME set, a checkout .enso holding only the project's own files is not held (#754)", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'enso-project-own-'))
  mkdirSync(join(repoRoot, '.enso', 'prompts'), { recursive: true })
  writeFileSync(join(repoRoot, '.enso', 'config.json'), '{}')
  writeFileSync(join(repoRoot, '.enso', 'config.local.json'), '{}')
  const home = join(repoRoot, 'home')
  expect(migrateCheckoutEnsoOnLaunch(repoRoot, { ENSO_HOME: home }).held).toBe(false)
  writeFileSync(join(repoRoot, '.enso', 'secrets.env'), 'OLD=1\n')
  expect(migrateCheckoutEnsoOnLaunch(repoRoot, { ENSO_HOME: home }).held).toBe(true)
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

test("⚠ the project's own tiers stay in the checkout: only the legacy files move (#754)", () => {
  const root = mkdtempSync(join(tmpdir(), 'enso-migrate-project-'))
  const repoRoot = join(root, 'checkout')
  const home = join(root, 'home', '.enso')
  const legacy = join(repoRoot, '.enso')
  mkdirSync(join(legacy, 'prompts'), { recursive: true })
  writeFileSync(join(legacy, 'config.json'), '{"threads":{"setup":["bun install"]}}')
  writeFileSync(join(legacy, 'config.local.json'), '{"threads":{"tree":"off"}}')
  writeFileSync(join(legacy, 'prompts', 'x.md'), 'a prompt')
  writeFileSync(join(legacy, 'secrets.env'), 'TAVILY_API_KEY=x')
  const migration = migrateCheckoutEnso(repoRoot, home)
  expect(migration).toMatchObject({ moved: ['secrets.env'], kept: [] })
  expect(readFileSync(join(legacy, 'config.json'), 'utf8')).toBe('{"threads":{"setup":["bun install"]}}')
  expect(readFileSync(join(legacy, 'config.local.json'), 'utf8')).toBe('{"threads":{"tree":"off"}}')
  expect(readFileSync(join(legacy, 'prompts', 'x.md'), 'utf8')).toBe('a prompt')
  expect(existsSync(join(home, 'config.json'))).toBe(false)
  expect(existsSync(join(home, 'prompts'))).toBe(false)
  expect(existsSync(join(legacy, 'secrets.env'))).toBe(false)
})

// ── The project folders (#552) ────────────────────────────────────────────────────────────────

/** A pi session file as pi writes it: the header line names the cwd; the rest is any entries. */
function writeSession(directory: string, name: string, cwd: string): string {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, name)
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session', version: 3, id: name.split('_')[1]?.replace('.jsonl', ''), timestamp: 't', cwd })}\n{"type":"message"}\n`,
  )
  return file
}

test('⚠ a session pi filed by cwd moves into its project folder, keyed by the id of the REAL path; a cwd that is gone is orphaned, never guessed (#552)', () => {
  const home = mkdtempSync(join(tmpdir(), 'enso-home-'))
  const agentDir = ensoAgentDir(home)
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'enso-proj-')))
  // The project reached through a symlink: the session's cwd is the LINK, the id is the target's.
  const link = join(home, 'link-to-project')
  symlinkSync(project, link)
  const legacy = join(agentDir, 'sessions', '--encoded-link--')
  const viaLink = writeSession(legacy, '2026-01-01T00-00-00-000Z_aaaa.jsonl', link)
  const direct = writeSession(
    join(agentDir, 'sessions', '--encoded-direct--'),
    '2026-01-02T00-00-00-000Z_bbbb.jsonl',
    project,
  )
  const gone = writeSession(
    join(agentDir, 'sessions', '--encoded-gone--'),
    '2026-01-03T00-00-00-000Z_cccc.jsonl',
    join(home, 'no-such-dir'),
  )

  const migration = migrateSessionsIntoProjects(agentDir, ensoProjectsDir(home))
  const target = projectSessionsDir(ensoProjectsDir(home), projectIdOf(project))
  // Both land under ONE project folder: the link and the target are the same project.
  expect(migration.moved.toSorted()).toEqual([
    join(target, '2026-01-01T00-00-00-000Z_aaaa.jsonl'),
    join(target, '2026-01-02T00-00-00-000Z_bbbb.jsonl'),
  ])
  expect(existsSync(viaLink)).toBe(false)
  expect(existsSync(direct)).toBe(false)
  expect(readFileSync(join(target, '2026-01-01T00-00-00-000Z_aaaa.jsonl'), 'utf8')).toContain(link)
  // Emptied legacy directories are gone; the orphan's stays, with its file, and is named.
  expect(existsSync(legacy)).toBe(false)
  expect(existsSync(gone)).toBe(true)
  expect(migration.orphaned).toEqual([join(agentDir, 'sessions', '--encoded-gone--')])
  expect(migration.kept).toEqual([])
})

test('⚠ a session the project folder already holds is never overwritten: the legacy file stays and is reported; a second run moves nothing (#552)', () => {
  const home = mkdtempSync(join(tmpdir(), 'enso-home-'))
  const agentDir = ensoAgentDir(home)
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'enso-proj-')))
  const target = projectSessionsDir(ensoProjectsDir(home), projectIdOf(project))
  writeSession(target, '2026-01-01T00-00-00-000Z_aaaa.jsonl', project)
  writeFileSync(join(target, '2026-01-01T00-00-00-000Z_aaaa.jsonl'), 'the project folder had this one first\n')
  const legacy = writeSession(join(agentDir, 'sessions', '--encoded--'), '2026-01-01T00-00-00-000Z_aaaa.jsonl', project)

  const first = migrateSessionsIntoProjects(agentDir, ensoProjectsDir(home))
  expect(first).toEqual({ moved: [], kept: [legacy], orphaned: [], unreadable: [] })
  expect(readFileSync(join(target, '2026-01-01T00-00-00-000Z_aaaa.jsonl'), 'utf8')).toBe(
    'the project folder had this one first\n',
  )
  expect(existsSync(legacy)).toBe(true)
  expect(migrateSessionsIntoProjects(agentDir, ensoProjectsDir(home))).toEqual({
    moved: [],
    kept: [legacy],
    orphaned: [],
    unreadable: [],
  })
  // No agent dir at all: nothing to do, nothing created.
  expect(migrateSessionsIntoProjects(join(home, 'nowhere'), ensoProjectsDir(home))).toEqual({
    moved: [],
    kept: [],
    orphaned: [],
    unreadable: [],
  })
})

test('⚠ a file with no session header — the tail a running pre-#552 process appended after a move — is reported unreadable, by name, and left; the files beside it still move (#552)', () => {
  const home = mkdtempSync(join(tmpdir(), 'enso-home-'))
  const agentDir = ensoAgentDir(home)
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'enso-proj-')))
  const legacy = join(agentDir, 'sessions', '--encoded--')
  const whole = writeSession(legacy, '2026-01-01T00-00-00-000Z_aaaa.jsonl', project)
  mkdirSync(legacy, { recursive: true })
  const tail = join(legacy, '2026-01-02T00-00-00-000Z_bbbb.jsonl')
  writeFileSync(tail, '{"type":"message","id":"m1"}\n')

  const migration = migrateSessionsIntoProjects(agentDir, ensoProjectsDir(home))
  const target = projectSessionsDir(ensoProjectsDir(home), projectIdOf(project))
  expect(migration).toEqual({
    moved: [join(target, '2026-01-01T00-00-00-000Z_aaaa.jsonl')],
    kept: [],
    orphaned: [],
    unreadable: [tail],
  })
  expect(existsSync(whole)).toBe(false)
  // The tail stays, readable where it was; its directory is not removed around it.
  expect(readFileSync(tail, 'utf8')).toBe('{"type":"message","id":"m1"}\n')
})

test('a header longer than one 4 KiB read (a fork naming a long parent path) is read whole and the file migrates by its cwd (#552)', () => {
  const home = mkdtempSync(join(tmpdir(), 'enso-home-'))
  const agentDir = ensoAgentDir(home)
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'enso-proj-')))
  const legacy = join(agentDir, 'sessions', '--encoded--')
  mkdirSync(legacy, { recursive: true })
  const file = join(legacy, '2026-01-01T00-00-00-000Z_aaaa.jsonl')
  // `cwd` sits AFTER a 6 KiB field, so a 4 KiB read truncates the JSON before reaching it.
  const header = {
    type: 'session',
    version: 3,
    id: 'aaaa',
    timestamp: 't',
    parentSession: 'p'.repeat(6 * 1024),
    cwd: project,
  }
  writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message"}\n`)

  const migration = migrateSessionsIntoProjects(agentDir, ensoProjectsDir(home))
  const target = projectSessionsDir(ensoProjectsDir(home), projectIdOf(project))
  expect(migration).toEqual({ moved: [join(target, basename(file))], kept: [], orphaned: [], unreadable: [] })
})

// ⚠ #551: the one way a thread's cwd becomes its project. A tree's path names its project's id;
// nothing else under the projects folder does, and nothing outside it can.
test("a thread tree's path — its root or anything under it — names its project's id; a project's sessions, the trees folder itself and any other path name none (#551)", () => {
  const projectsDir = '/h/.enso/projects'
  const id = '0123456789abcdef'
  const tree = join(projectTreesDir(projectsDir, id), 'thread-1')
  expect(treeProjectId(projectsDir, tree)).toBe(id)
  expect(treeProjectId(projectsDir, join(tree, 'src', 'a.ts'))).toBe(id)
  expect(treeProjectId(projectsDir, projectTreesDir(projectsDir, id))).toBeUndefined()
  expect(treeProjectId(projectsDir, join(projectSessionsDir(projectsDir, id), 'x.jsonl'))).toBeUndefined()
  expect(treeProjectId(projectsDir, join(projectsDir, 'not-an-id', 'trees', 't'))).toBeUndefined()
  expect(treeProjectId(projectsDir, `/h/.enso/projects-elsewhere/${id}/trees/t`)).toBeUndefined()
  expect(treeProjectId(projectsDir, '/srv/app')).toBeUndefined()
})

// #615: the guard judges a session's files relative to this root, so it must be the tree's own —
// never a parent that would also take in the project's sessions, snapshots or other threads' trees.
test("a path in a thread tree is cut to that tree's root; a path in no tree has none (#615)", () => {
  const projectsDir = '/h/.enso/projects'
  const tree = join(projectTreesDir(projectsDir, '0123456789abcdef'), 'thread-1')
  expect(threadTreeRoot(projectsDir, tree)).toBe(tree)
  expect(threadTreeRoot(projectsDir, join(tree, 'src', 'a.ts'))).toBe(tree)
  expect(threadTreeRoot(projectsDir, projectTreesDir(projectsDir, '0123456789abcdef'))).toBeUndefined()
  expect(
    threadTreeRoot(projectsDir, join(projectSessionsDir(projectsDir, '0123456789abcdef'), 'x.jsonl')),
  ).toBeUndefined()
  expect(threadTreeRoot(projectsDir, '/srv/app')).toBeUndefined()
})

/**
 * An INSTALLED layout (#950): a pi agent dir's `npm/node_modules/` with the harness and the web
 * package side by side, and no `package.json` declaring `workspaces` anywhere above them. Built
 * under the run's scratch `TMPDIR`, which is outside every checkout.
 */
function makeInstalledFixture(): { readonly harnessDir: string; readonly webDir: string } {
  const modules = join(mkdtempSync(join(tmpdir(), 'enso-installed-fixture-')), 'npm', 'node_modules')
  const harnessDir = join(modules, HARNESS_PACKAGE_NAME)
  const webDir = join(modules, ...WEB_PACKAGE_NAME.split('/'))
  mkdirSync(join(harnessDir, 'extensions', 'guards'), { recursive: true })
  writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({ name: HARNESS_PACKAGE_NAME, version: '0.0.0' }))
  writeFileSync(join(harnessDir, 'extensions', 'guards', 'index.ts'), 'export {};\n')
  mkdirSync(join(webDir, 'src', 'server'), { recursive: true })
  writeFileSync(join(webDir, 'package.json'), JSON.stringify({ name: WEB_PACKAGE_NAME, version: '0.0.0' }))
  writeFileSync(join(webDir, 'src', 'server', 'dev.ts'), 'export {};\n')
  return { harnessDir, webDir }
}

test("the package-name constants are the manifests' own names — a rename (#948) changes both or fails here", () => {
  const root = findRepoRoot(import.meta.url)
  const nameOf = (packageDir: string): unknown =>
    (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>).name
  expect(nameOf(harnessPackageDir(root))).toBe(HARNESS_PACKAGE_NAME)
  expect(nameOf(webPackageDir(root))).toBe(WEB_PACKAGE_NAME)
})

test('⚠ installed, with no workspace root above (#950): each package is found by name, from a path or a file:// URL', () => {
  const { harnessDir, webDir } = makeInstalledFixture()
  expect(() => findRepoRoot(join(harnessDir, 'extensions', 'guards', 'index.ts'))).toThrow(RepoRootNotFoundError)
  const guardsModule = pathToFileURL(join(harnessDir, 'extensions', 'guards', 'index.ts')).href
  expect(installedPackageDir(guardsModule, HARNESS_PACKAGE_NAME)).toBe(realpathSync(harnessDir))
  expect(installedPackageDir(join(webDir, 'src', 'server', 'dev.ts'), WEB_PACKAGE_NAME)).toBe(realpathSync(webDir))
})

test('a package.json of another name below the package root is walked past, not taken for the package (#950)', () => {
  const { harnessDir } = makeInstalledFixture()
  const nested = join(harnessDir, 'extensions', 'guards')
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'a-nested-fixture' }))
  expect(installedPackageDir(join(nested, 'index.ts'), HARNESS_PACKAGE_NAME)).toBe(realpathSync(harnessDir))
})

test('no package of that name above throws a NAMED error carrying the start path and the name (#950)', () => {
  const { harnessDir } = makeInstalledFixture()
  const start = join(harnessDir, 'extensions', 'guards', 'index.ts')
  expect(() => installedPackageDir(start, 'not-installed-here')).toThrow(PackageDirNotFoundError)
  expect(() => installedPackageDir(start, 'not-installed-here')).toThrow('not-installed-here')
})

test("⚠ the guards' harnessRoot (#950): the checkout root for a workspace member, the package itself when installed", () => {
  const checkout = makeWorkspaceFixture()
  writeFileSync(join(checkout, 'packages', 'harness', 'package.json'), JSON.stringify({ name: HARNESS_PACKAGE_NAME }))
  const checkedOutModule = join(checkout, 'packages', 'harness', 'extensions', 'deep', 'module.ts')
  expect(checkoutOrInstalledRoot(checkedOutModule, HARNESS_PACKAGE_NAME)).toBe(realpathSync(checkout))

  const { harnessDir } = makeInstalledFixture()
  const installedModule = join(harnessDir, 'extensions', 'guards', 'index.ts')
  expect(checkoutOrInstalledRoot(installedModule, HARNESS_PACKAGE_NAME)).toBe(realpathSync(harnessDir))
})

test("⚠ a package installed into someone else's monorepo is not a member of it: no checkout, no .env, no .enso to adopt (#950)", () => {
  const strangersRoot = mkdtempSync(join(tmpdir(), 'enso-strangers-monorepo-'))
  writeFileSync(join(strangersRoot, 'package.json'), JSON.stringify({ name: 'theirs', workspaces: ['apps/*'] }))
  const installedHarness = join(strangersRoot, 'node_modules', HARNESS_PACKAGE_NAME)
  mkdirSync(installedHarness, { recursive: true })
  writeFileSync(join(installedHarness, 'package.json'), JSON.stringify({ name: HARNESS_PACKAGE_NAME }))
  // The workspace-root walk would adopt their root; the membership test does not.
  expect(realpathSync(findRepoRoot(installedHarness))).toBe(realpathSync(strangersRoot))
  expect(checkoutRootOfPackage(installedHarness)).toBeUndefined()
  expect(checkoutOrInstalledRoot(installedHarness, HARNESS_PACKAGE_NAME)).toBe(realpathSync(installedHarness))
})

test('the web package and the dev launchers (#950): its checkout when it is a member, none when installed', () => {
  const checkout = makeWorkspaceFixture()
  expect(checkoutRootOfPackage(join(checkout, 'packages', 'harness'))).toBe(checkout)
  const { webDir } = makeInstalledFixture()
  expect(checkoutRootOfPackage(webDir)).toBeUndefined()
})

test("dev.ts's harness (#950): resolved by name from the web package, the same with or without a checkout", () => {
  const { harnessDir, webDir } = makeInstalledFixture()
  expect(resolvePackageDir(HARNESS_PACKAGE_NAME, webDir)).toBe(realpathSync(harnessDir))
  // This checkout: the workspace link in node_modules lands on packages/harness itself.
  const root = findRepoRoot(import.meta.url)
  expect(resolvePackageDir(HARNESS_PACKAGE_NAME, webPackageDir(root))).toBe(realpathSync(harnessPackageDir(root)))
})
