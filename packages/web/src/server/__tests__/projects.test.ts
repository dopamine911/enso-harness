import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createProjectRegistry, ProjectUnavailable } from '../projects.ts'

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
  expect(outcome).toEqual({ kind: 'refused', reason: expect.stringContaining('not under a declared project root') })
})

test('⚠ nothing inside a hidden directory under a root can be a project', () => {
  const { launch, root, statePath } = layout()
  mkdirSync(join(root, 'app', '.config', 'tool'), { recursive: true })
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  expect(projects.register({ path: join(root, 'app', '.config', 'tool') })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('hidden directory (.config)'),
  })
  expect(projects.register({ path: join(root, 'app') })).toMatchObject({ kind: 'registered' })
})

test('with no roots declared, only the launch directory is a project, and registering says how to declare one', () => {
  const { launch, root } = layout()
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [] })
  expect(projects.list()).toEqual([expect.objectContaining({ path: launch, launch: true, status: 'ok' })])
  expect(projects.register({ path: root })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('"projects": { "roots"'),
  })
  // Registering the launch directory is not a new project — it already is one.
  expect(projects.register({ path: launch })).toMatchObject({ kind: 'existing', project: { launch: true } })
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

  const rootRemoved = createProjectRegistry({ launchDirectory: launch, roots: [], statePath })
  expect(rootRemoved.get(registered.project.projectId)).toBeUndefined()
  expect(rootRemoved.byDirectory(app)).toBeUndefined()
  expect(readFileSync(statePath, 'utf8')).toContain(app)
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
    expect(projects.register({ path: sub })).toMatchObject({ kind: 'registered', project: { path: sub } })
    expect(projects.register({ path: join(sub, 'app') })).toMatchObject({ kind: 'registered' })
  }
  // …and the refusal a root gives is still the reason when no root accepts.
  const alone = createProjectRegistry({ launchDirectory: launch, roots: [sub], statePath: `${statePath}.alone` })
  expect(alone.register({ path: sub })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('a project root itself'),
  })
})

test('a directory merely NAMED `..something` under a root is inside it: refused as hidden, not as outside', () => {
  const { launch, root, statePath } = layout()
  mkdirSync(join(root, '..dotted'))
  const projects = createProjectRegistry({ launchDirectory: launch, roots: [root], statePath })
  expect(projects.register({ path: join(root, '..dotted') })).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('hidden directory (..dotted)'),
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

  expect(projects.browse(undefined)).toEqual({
    kind: 'listing',
    listing: {
      path: null,
      parent: null,
      registrable: false,
      directories: [{ name: root, path: root }],
      truncated: false,
    },
  })
  expect(projects.browse(root)).toEqual({
    kind: 'listing',
    listing: {
      path: root,
      parent: null,
      registrable: false,
      directories: [
        { name: 'app', path: join(root, 'app'), projectId: app.project.projectId },
        { name: 'web', path: join(root, 'web') },
        { name: 'web-link', path: join(root, 'web') },
      ],
      truncated: false,
    },
  })
  expect(projects.browse(join(root, 'app'))).toMatchObject({
    kind: 'listing',
    listing: { parent: root, registrable: true, directories: [{ name: 'src' }] },
  })
  expect(projects.browse(outside)).toEqual({
    kind: 'refused',
    reason: expect.stringContaining('not under a declared project root'),
  })
})
