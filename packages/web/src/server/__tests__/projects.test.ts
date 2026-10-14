import { expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { projectIdOf, projectTreesDir } from '@enso/core/paths'
import { readProjectsSettings, writeProjectsSettings } from '../../host/projects-config-file.ts'
import { canonicalConfigPath, createProjectRegistry, ProjectUnavailable } from '../projects.ts'

/**
 * The project boundary (#395), decided in `projects.ts`: which directories a page may make
 * projects of, and where a new thread is built. Real directories, because the rules are about
 * what `realpath` says — a symlink, a dot-directory, a directory that went away.
 */

function layout(): { launch: string; root: string; statePath: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'enso-projects-')))
  const launch = join(base, 'launch')
  const root = join(base, 'code')
  mkdirSync(launch)
  mkdirSync(root)
  return { launch, root, statePath: join(base, 'state', 'projects.json') }
}

test('⚠ a symlink under a root that leads out of it is refused: the resolved path is what is checked', () => {
  const { launch, root, statePath } = layout()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'enso-outside-')))
  symlinkSync(outside, join(root, 'escape'))
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  const outcome = projects.register({ path: join(root, 'escape') })
  expect(outcome).toEqual({ kind: 'refused', reason: expect.stringContaining('outside your declared project roots') })
})

test('⚠ nothing inside a hidden directory under a root can be a project', () => {
  const { launch, root, statePath } = layout()
  mkdirSync(join(root, 'app', '.config', 'tool'), { recursive: true })
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  expect(projects.register({ path: join(root, 'app', '.config', 'tool') })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('inside a hidden folder (.config)'),
  })
  expect(projects.register({ path: join(root, 'app') })).toMatchObject({ kind: 'registered' })
})

/** A scratch home holding a launch folder, Enso's own home, and folders a person might add. */
function homeLayout(): { home: string; launch: string; ensoHome: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'enso-home-')))
  const launch = join(home, 'launch')
  const ensoHome = join(home, 'enso-home')
  mkdirSync(launch)
  mkdirSync(join(ensoHome, 'projects'), { recursive: true })
  return { home, launch, ensoHome }
}

// #866: with no roots declared, a page may add any folder by path, absolute or `~/` — and what an agent
// must never be handed stays refused whatever the path says, a symlink into it included.
test('⚠ with no roots declared, any folder registers by path, and the standing refusals hold: home, a folder holding it, ENSO_HOME, a hidden segment, a symlink into one (#866)', () => {
  const { home, launch, ensoHome } = homeLayout()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'enso-elsewhere-')))
  mkdirSync(join(home, 'work', 'app'), { recursive: true })
  mkdirSync(join(home, '.ssh', 'keys'), { recursive: true })
  symlinkSync(join(home, '.ssh', 'keys'), join(home, 'work', 'keys-link'))
  symlinkSync(home, join(home, 'work', 'home-link'))
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [], homeDirectory: home, ensoHome })

  expect(projects.register({ path: '~/work/app' })).toMatchObject({
    kind: 'registered',
    project: { path: join(home, 'work', 'app') },
  })
  expect(projects.register({ path: outside })).toMatchObject({ kind: 'registered', project: { path: outside } })
  // Each refusal says why, in the words the Add project page shows (#872).
  const refusals = [
    [home, 'That’s your home folder. An agent there could reach everything you own'],
    [dirname(home), 'That folder holds your home folder'],
    ['/', 'That folder holds your home folder'],
    [ensoHome, 'That’s Enso’s own folder (ENSO_HOME)'],
    [join(ensoHome, 'projects'), 'inside Enso’s own folder (ENSO_HOME)'],
    [join(home, '.ssh', 'keys'), 'inside a hidden folder (.ssh)'],
    [join(home, 'work', 'keys-link'), 'inside a hidden folder (.ssh)'],
    [join(home, 'work', 'home-link'), 'That’s your home folder'],
    ['~/nope/does-not-exist', 'There’s no folder at ~/nope/does-not-exist.'],
  ] as const
  for (const [path, reason] of refusals) {
    expect(projects.register({ path })).toEqual({ kind: 'refused', reason: expect.stringContaining(reason) })
  }
  // Registering the launch directory is not a new project — it already is one.
  expect(projects.register({ path: launch })).toMatchObject({ kind: 'existing', project: { launch: true } })
})

test('with no roots declared, browsing starts at the home folder, takes a typed path anywhere the rule allows, and never goes up into a folder holding home (#866)', () => {
  const { home, launch, ensoHome } = homeLayout()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'enso-elsewhere-')))
  mkdirSync(join(home, 'work', 'app'), { recursive: true })
  mkdirSync(join(home, '.config'))
  mkdirSync(join(outside, 'proj'))
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [], homeDirectory: home, ensoHome })

  expect(projects.browse(undefined, false)).toMatchObject({
    kind: 'listing',
    listing: { path: null, directories: [{ path: home }] },
  })
  // Home is where browsing starts, never a project — the listing says why; Enso's own home and hidden folders are not listed.
  expect(projects.browse(home, false)).toEqual({
    kind: 'listing',
    listing: {
      path: home,
      parent: null,
      registrable: false,
      refusal: expect.stringContaining('That’s your home folder'),
      directories: [
        { name: 'launch', path: launch, projectId: expect.any(String) },
        { name: 'work', path: join(home, 'work') },
      ],
      truncated: false,
    },
  })
  expect(projects.browse('~/work/app', false)).toMatchObject({
    kind: 'listing',
    listing: { path: join(home, 'work', 'app'), parent: join(home, 'work'), registrable: true },
  })
  expect(projects.browse(join(outside, 'proj'), false)).toMatchObject({
    kind: 'listing',
    listing: { path: join(outside, 'proj'), parent: outside, registrable: true },
  })
  // `outside` is home's sibling: up from it would be the folder holding home, so there is no up.
  expect(projects.browse(outside, false)).toMatchObject({
    kind: 'listing',
    listing: { parent: null, registrable: true },
  })
  expect(projects.browse(dirname(home), false)).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('That folder holds your home folder'),
  })
})

// #866: "show hidden folders" lifts the hidden rule for the request that asks, never the standing
// refusals. ⚠ Serving re-checks every stored project on each read: a project added this way must
// stay served — after a restart too — though every request without the flag still refuses it.
test('⚠ with hidden folders shown, a folder inside a hidden one is listed, registers and stays served; without the flag it is refused, and home and ENSO_HOME are refused either way (#866)', () => {
  const { home, launch, ensoHome } = homeLayout()
  const nvim = join(home, '.config', 'nvim')
  mkdirSync(nvim, { recursive: true })
  const options = {
    launchDirectory: launch,
    roots: [],
    homeDirectory: home,
    ensoHome,
    statePath: join(ensoHome, 'projects.json'),
  }
  const projects = createProjectRegistry(options)

  const config = { name: '.config', path: join(home, '.config') }
  expect(projects.browse(home, false)).toMatchObject({ listing: { directories: expect.not.arrayContaining([config]) } })
  expect(projects.browse(home, true)).toMatchObject({ listing: { directories: expect.arrayContaining([config]) } })
  expect(projects.browse(nvim, false)).toMatchObject({ kind: 'refused' })
  expect(projects.browse(nvim, true)).toMatchObject({ kind: 'listing', listing: { path: nvim, registrable: true } })

  expect(projects.register({ path: '~/.config/nvim' })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('Tick “show hidden folders” to add it'),
  })
  expect(projects.register({ path: '~/.config/nvim', hidden: true })).toMatchObject({
    kind: 'registered',
    project: { path: nvim },
  })
  expect(projects.list().map((project) => project.path)).toContain(nvim)
  expect(
    createProjectRegistry(options)
      .list()
      .map((project) => project.path),
  ).toContain(nvim)

  for (const path of [home, ensoHome]) {
    expect(projects.register({ path, hidden: true })).toMatchObject({ kind: 'refused' })
  }
})

// ⚠ #551: a thread on its own tree runs in a directory no one registered. The tree belongs to the
// project its path names, and is served exactly when that project is — removed, it is not.
test("⚠ a thread's tree is its project's: served while the project is, not once it is removed; a lookalike path is no tree (#551)", () => {
  const { launch, root, statePath } = layout()
  const app = join(root, 'app')
  mkdirSync(app)
  const projectsDir = join(dirname(statePath), 'projects')
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath, projectsDir })
  const registered = projects.register({ path: app })
  if (registered.kind === 'refused') throw new Error(registered.reason)
  const tree = join(projectTreesDir(projectsDir, projectIdOf(app)), 'thread-1')
  expect(projects.byDirectory(tree)).toMatchObject({ projectId: registered.project.projectId, path: app })
  expect(projects.byDirectory(join(tree, 'src'))?.projectId).toBe(registered.project.projectId)
  // The launch project's trees too.
  expect(projects.byDirectory(join(projectTreesDir(projectsDir, projectIdOf(launch)), 't'))?.launch).toBe(true)
  // A tree of no project this server knows, and the same layout outside the projects folder.
  expect(projects.byDirectory(join(projectTreesDir(projectsDir, 'ffffffffffffffff'), 't'))).toBeUndefined()
  expect(projects.byDirectory(join(root, projectIdOf(app), 'trees', 't'))).toBeUndefined()
  projects.remove(registered.project.projectId)
  expect(projects.byDirectory(tree)).toBeUndefined()
})

test('registrations outlive the process; a root taken out of the config hides its projects without forgetting them', () => {
  const { launch, root, statePath } = layout()
  const app = join(root, 'app')
  mkdirSync(app)
  const first = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  const registered = first.register({ path: app, title: 'The app' })
  if (registered.kind === 'refused') throw new Error(registered.reason)

  const restarted = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  expect(restarted.get(registered.project.projectId)).toMatchObject({ path: app, title: 'The app' })

  // Narrowed to another root, the fence hides the project without forgetting it. With no roots at all
  // there is no fence (#866): the project is served again, as any folder the standing refusals allow.
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'enso-other-root-')))
  const rootNarrowed = createProjectRegistry({ launchDirectory: launch, roots: [elsewhere], statePath })
  expect(rootNarrowed.get(registered.project.projectId)).toBeUndefined()
  expect(rootNarrowed.byDirectory(app)).toBeUndefined()
  expect(readFileSync(statePath, 'utf8')).toContain(app)
  const noRoots = createProjectRegistry({ launchDirectory: launch, roots: [], statePath })
  expect(noRoots.byDirectory(app)?.projectId).toBe(registered.project.projectId)
  const rootBack = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  expect(rootBack.byDirectory(app)?.projectId).toBe(registered.project.projectId)
})

test('a new thread is built in the one project a page named for it, else the launch directory; never in a vanished one', () => {
  const { launch, root } = layout()
  const app = join(root, 'app')
  const other = join(root, 'other')
  mkdirSync(app)
  mkdirSync(other)
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root] })
  const appProject = projects.register({ path: app })
  const otherProject = projects.register({ path: other })
  if (appProject.kind === 'refused' || otherProject.kind === 'refused') throw new Error('registration refused')

  expect(projects.directoryForNewThread('unnamed')).toBe(launch)
  expect(projects.claim('t1', appProject.project.projectId)).toBeUndefined()
  // The same name again is no news; a DIFFERENT one is refused out loud, never dropped (PR #399 review).
  expect(projects.claim('t1', appProject.project.projectId)).toBeUndefined()
  expect(projects.claim('t1', otherProject.project.projectId)).toEqual({
    status: 409,
    reason: expect.stringContaining(`already named for project ${appProject.project.projectId}`),
  })
  expect(projects.directoryForNewThread('t1')).toBe(app)
  expect(projects.claim('t2', '0123456789abcdef')).toEqual({
    status: 400,
    reason: 'project 0123456789abcdef is not registered here — it was removed, or never added',
  })
  // Built: the claim is dropped, and the thread's session decides from here on.
  projects.dropClaim('t1')
  expect(projects.claim('t1', otherProject.project.projectId)).toBeUndefined()

  rmSync(app, { recursive: true })
  expect(projects.get(appProject.project.projectId)?.status).toBe('missing-dir')
  expect(projects.claim('t3', appProject.project.projectId)).toBeUndefined()
  expect(() => projects.directoryForNewThread('t3')).toThrow(ProjectUnavailable)
})

// PR #399 review: roots may nest, and whether a directory is accepted must not depend on the order
// they are declared in. `code/sub` is a root itself for the second root, and strictly under the first.
test('⚠ a directory any declared root accepts is registered, whatever order nested roots are declared in', () => {
  const { launch, root, statePath } = layout()
  const sub = join(root, 'sub')
  mkdirSync(join(sub, 'app'), { recursive: true })
  for (const roots of [
    [sub, root],
    [root, sub],
  ]) {
    const projects = createProjectRegistry({
      launchDirectory: launch,
      roots,
      statePath: `${statePath}.${roots[0] === sub}`,
    })
    // PR #867 review: a page may add exactly what a registration takes — `sub` is a root it browses
    // from AND a folder under `root`, so it is addable. (`main` said it was not, though `register` took it.)
    expect(projects.browse(sub, false)).toMatchObject({ kind: 'listing', listing: { registrable: true } })
    expect(projects.register({ path: sub })).toMatchObject({ kind: 'registered', project: { path: sub } })
    expect(projects.register({ path: join(sub, 'app') })).toMatchObject({ kind: 'registered' })
  }
  // …and the refusal a root gives is still the reason when no root accepts.
  const alone = createProjectRegistry({ launchDirectory: launch, roots: [sub], statePath: `${statePath}.alone` })
  expect(alone.register({ path: sub })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('a project root itself'),
  })
  expect(alone.browse(sub, false)).toMatchObject({
    kind: 'listing',
    listing: { registrable: false, refusal: expect.stringContaining('a project root itself') },
  })
})

test('a directory merely NAMED `..something` under a root is inside it: refused as hidden, not as outside', () => {
  const { launch, root, statePath } = layout()
  mkdirSync(join(root, '..dotted'))
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  expect(projects.register({ path: join(root, '..dotted') })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('inside a hidden folder (..dotted)'),
  })
})

// PR #399 review: a relative root would resolve against the server PROCESS's cwd, which the launch
// directory need not be — a boundary nobody wrote down. It fails the launch instead, with the fix.
test('⚠ a relative project root is refused at construction; `~/` is the home directory', () => {
  const { launch, root } = layout()
  expect(() => createProjectRegistry({ launchDirectory: launch, roots: ['code'] })).toThrow(
    'projects.roots entry code is not an absolute or ~/ path',
  )
  mkdirSync(join(root, 'app'))
  const home = createProjectRegistry({ launchDirectory: launch, roots: ['~/code'], homeDirectory: dirname(root) })
  expect(home.register({ path: join(root, 'app') })).toMatchObject({ kind: 'registered' })
})

// #395 slice 3: what a page may browse while adding a project is exactly what it may register —
// every directory it is shown resolves inside a root, none is hidden, and a symlink out is not shown.
test('⚠ browsing lists only directories a registration would take: resolved, inside a root, never hidden', () => {
  const { launch, root } = layout()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'enso-outside-')))
  mkdirSync(join(root, 'app', 'src'), { recursive: true })
  mkdirSync(join(root, 'web'))
  mkdirSync(join(root, '.cache'))
  symlinkSync(outside, join(root, 'escape'))
  symlinkSync(join(root, 'web'), join(root, 'web-link'))
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root] })
  const app = projects.register({ path: join(root, 'app') })
  if (app.kind === 'refused') throw new Error(app.reason)

  expect(projects.browse(undefined, false)).toEqual({
    kind: 'listing',
    listing: {
      path: null,
      parent: null,
      registrable: false,
      directories: [{ name: root, path: root }],
      truncated: false,
    },
  })
  expect(projects.browse(root, false)).toEqual({
    kind: 'listing',
    listing: {
      path: root,
      parent: null,
      registrable: false,
      refusal: expect.stringContaining('a project root itself'),
      directories: [
        { name: 'app', path: join(root, 'app'), projectId: app.project.projectId },
        { name: 'web', path: join(root, 'web') },
        { name: 'web-link', path: join(root, 'web') },
      ],
      truncated: false,
    },
  })
  expect(projects.browse(join(root, 'app'), false)).toMatchObject({
    kind: 'listing',
    listing: { parent: root, registrable: true, directories: [{ name: 'src' }] },
  })
  expect(projects.browse(outside, false)).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('outside your declared project roots'),
  })
  // #866: hidden folders shown, `.cache` under the root is listed — and the roots' fence still holds.
  expect(projects.browse(root, true)).toMatchObject({
    listing: { directories: expect.arrayContaining([{ name: '.cache', path: join(root, '.cache') }]) },
  })
  expect(projects.browse(outside, true)).toMatchObject({ kind: 'refused' })
})

// PR #401 review: a directory can be searchable and not readable (`--x`) — `realpath` and `stat`
// pass, the listing throws. From the browse route that throw had nothing above it and took the
// server down; it is a refusal that says why, not an empty list that would say "no folders here".
test('⚠ browsing a directory the server may enter but not read is a refusal saying so, never a throw', () => {
  const { launch, root } = layout()
  const locked = join(root, 'locked')
  mkdirSync(join(locked, 'inner'), { recursive: true })
  chmodSync(locked, 0o100)
  try {
    const projects = createProjectRegistry({ launchDirectory: launch, roots: [root] })
    expect(projects.browse(locked, false)).toEqual({
      kind: 'refused',
      reason: `Enso can’t read ${locked}: permission denied.`,
    })
  } finally {
    chmodSync(locked, 0o700)
  }
})

// PR #561 review: a `threads.projects` key matched as written silently fell through to the default
// for `~/app`, `app/` or a symlink — each must name the project's canonical path.
test('a config path written with ~/, a trailing slash or through a symlink is the canonical path of the directory it names (#551)', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'enso-home-')))
  mkdirSync(join(home, 'app'))
  symlinkSync(join(home, 'app'), join(home, 'link'))
  const app = join(home, 'app')
  expect(canonicalConfigPath('~/app', home)).toBe(app)
  expect(canonicalConfigPath(`${app}/`, home)).toBe(app)
  expect(canonicalConfigPath('~/link', home)).toBe(app)
  expect(canonicalConfigPath(app, home)).toBe(app)
})

// #979 re-review, testing gap: Settings › Projects & threads keys a project's own mode as the
// resolver does, with this module's `canonicalConfigPath`, so a symlinked key names its target.
test('a project mode keyed through a symlink is read and written as the path it resolves to', () => {
  const home = mkdtempSync(join(tmpdir(), 'enso-projects-settings-'))
  const places = { home, agentDir: join(home, 'pi-agent'), canonical: (key: string) => canonicalConfigPath(key) }
  mkdirSync(places.agentDir)
  const real = join(places.home, 'real-app')
  const link = join(places.home, 'linked-app')
  mkdirSync(real)
  symlinkSync(real, link)
  const resolved = realpathSync(real)
  writeFileSync(join(places.home, 'config.json'), JSON.stringify({ threads: { projects: { [link]: 'off' } } }))
  const read = readProjectsSettings(places)
  if (read.kind !== 'ok' || read.etag === undefined) throw new Error('expected a readable file')
  expect(read.threads.projects).toEqual({ [resolved]: 'off' })

  expect(
    writeProjectsSettings(places, { threads: { projects: { [link]: 'copy' } } }, { kind: 'matches', etag: read.etag }),
  ).toMatchObject({ kind: 'written' })
  expect(JSON.parse(readFileSync(join(places.home, 'config.json'), 'utf8'))).toEqual({
    threads: { projects: { [resolved]: 'copy' } },
  })
  expect(
    writeProjectsSettings(places, { threads: { projects: { [link]: 'off', [real]: 'copy' } } }, { kind: 'present' }),
  ).toMatchObject({ kind: 'refused', reason: expect.stringContaining('name the same project') })
})
