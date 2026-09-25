import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('a new thread is built in the first project a page named for it, else the launch directory; never in a vanished one', () => {
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
  expect(projects.claim('t1', otherProject.project.projectId)).toBeUndefined()
  expect(projects.directoryForNewThread('t1')).toBe(app)
  expect(projects.claim('t2', '0123456789abcdef')).toBe('no registered project has the id 0123456789abcdef')

  rmSync(app, { recursive: true })
  expect(projects.get(appProject.project.projectId)?.status).toBe('missing-dir')
  expect(() => projects.directoryForNewThread('t1')).toThrow(ProjectUnavailable)
})
