import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitChildEnvironment } from '../../packages/core/src/git.ts'
import { ENSO_DEFAULT_PERMISSION_POLICY } from '../../packages/core/src/permission-rules.ts'
import {
  plainNameOf,
  prepareScratch,
  regionCrop,
  screenshotOptions,
  shotsDuring,
  wantedFeatures,
} from '../docs/feature-screenshots.ts'
import { DEMO_FILES, DEMO_PROJECT, PROMPT_LIBRARY } from '../docs/feature-session.ts'
import { FEATURE_SPECS } from '../docs/features/index.ts'
import type { FeatureSpec, Shot } from '../docs/features/spec.ts'

/**
 * `bun run docs:screenshots` (#437), the parts that need no browser (#838): the command line, which
 * features a run captures, a region shot's crop, what a mark is called, which shots the session
 * takes at each stop, and the throwaway home and project it runs in.
 */

const scratch = mkdtempSync(join(tmpdir(), 'feature-screenshots-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

test('the command line: --only splits on commas, --chromium takes the next word, --keep is a switch', () => {
  expect(screenshotOptions(['bun', 'feature-screenshots.ts'])).toEqual({
    only: undefined,
    chromium: undefined,
    keep: false,
  })
  expect(screenshotOptions(['--keep', '--only', 'stats,chat', '--chromium', '/usr/bin/chrome'])).toEqual({
    only: ['stats', 'chat'],
    chromium: '/usr/bin/chrome',
    keep: true,
  })
  // A flag with nothing after it: `--only` names one empty feature (refused below), `--chromium` none.
  expect(screenshotOptions(['--chromium', '--only'])).toEqual({ only: [''], chromium: '--only', keep: false })
  expect(screenshotOptions(['--only'])).toMatchObject({ only: [''] })
  expect(screenshotOptions(['--chromium'])).toMatchObject({ chromium: undefined })
})

test('the features a run captures: all by default, the named ones in registry order, an unknown name refused', () => {
  expect(wantedFeatures(undefined)).toEqual(FEATURE_SPECS)
  const [first, second] = FEATURE_SPECS
  if (first === undefined || second === undefined) throw new Error('the registry has fewer than two features')
  expect(wantedFeatures([second.id, first.id])).toEqual([first, second])
  expect(() => wantedFeatures([first.id, 'nope', ''])).toThrow('feature-screenshots: --only names no feature: nope, ')
})

test("a region shot's crop: every box inside, 24 pixels of padding, never off the 1440×900 viewport", () => {
  expect(regionCrop([{ left: 100, top: 200, width: 50, height: 40 }])).toEqual({
    left: 76,
    top: 176,
    width: 98,
    height: 88,
  })
  // The union of several boxes, wherever each one is.
  expect(
    regionCrop([
      { left: 300, top: 100, width: 10, height: 10 },
      { left: 100, top: 400, width: 20, height: 20 },
    ]),
  ).toEqual({ left: 76, top: 76, width: 258, height: 368 })
  // At the edges, the padding stops at the viewport.
  expect(regionCrop([{ left: 10, top: 5, width: 1420, height: 890 }])).toEqual({
    left: 0,
    top: 0,
    width: 1440,
    height: 900,
  })
})

test('what a mark is called: the plain name or label it was found by, else nothing (the page reads it)', () => {
  expect(plainNameOf({ role: 'button', name: 'Start session' })).toBe('Start session')
  expect(plainNameOf({ label: 'Saved prompt' })).toBe('Saved prompt')
  expect(plainNameOf({ placeholder: 'ask pi something', within: { label: 'Composer' } })).toBe('ask pi something')
  expect(plainNameOf({ role: 'tab', name: /^Failure$/ })).toBeUndefined()
  expect(plainNameOf({ text: 'idle', exact: true })).toBeUndefined()
  expect(plainNameOf({ toolCall: 'curl', summary: true })).toBeUndefined()
})

test('the shots the session takes at a stop: each spec’s for that moment, in registry order, never one reached by `go`', () => {
  const [base] = FEATURE_SPECS
  if (base === undefined) throw new Error('the registry is empty')
  const during = (image: string, moment: 'start-dialog' | 'questionnaire'): Shot => ({
    image,
    alt: image,
    marks: [],
    during: moment,
  })
  const reached: Shot = { image: 'reached', alt: 'reached', marks: [], go: async (ui) => ui.openThread() }
  const specs: FeatureSpec[] = [
    { ...base, id: 'one', shots: [during('a', 'start-dialog'), reached, during('b', 'questionnaire')] },
    { ...base, id: 'two', shots: [reached] },
    { ...base, id: 'three', shots: [during('c', 'start-dialog')] },
  ]
  const taken = (moment: 'start-dialog' | 'questionnaire' | 'permission-prompt'): string[] =>
    shotsDuring(specs, moment).map(({ spec, shot }) => `${spec.id}/${shot.image}`)
  expect(taken('start-dialog')).toEqual(['one/a', 'three/c'])
  expect(taken('questionnaire')).toEqual(['one/b'])
  expect(taken('permission-prompt')).toEqual([])
})

test('⚠ the throwaway home names only the scripted provider, and the demo project is a clean, committed repository', () => {
  const into = join(scratch, 'run')
  mkdirSync(into, { recursive: true })
  writeFileSync(join(into, 'left-over'), 'from the last run')
  const { home, project } = prepareScratch(into)
  expect([home, project]).toEqual([join(into, 'home'), join(into, DEMO_PROJECT)])
  expect(readdirSync(into).toSorted()).toEqual([DEMO_PROJECT, 'home'].toSorted())
  const json = (path: string): unknown => JSON.parse(readFileSync(join(home, path), 'utf8'))

  const models = json('pi-agent/models.json') as { providers: Record<string, { baseUrl: string }> }
  expect(Object.keys(models.providers)).toEqual(['demo'])
  expect(models.providers.demo?.baseUrl).toBe('http://127.0.0.1:5199')
  expect(json('pi-agent/settings.json')).toEqual({
    compaction: { keepRecentTokens: 300 },
    defaultProjectTrust: 'always',
  })
  expect(json('config.json')).toEqual({ security: { incidents: { halt: true } } })
  // Enso's default policy, with `web_fetch` allowed and nothing else changed.
  expect(json('permissions.json')).toEqual(
    JSON.parse(
      JSON.stringify({
        ...ENSO_DEFAULT_PERMISSION_POLICY,
        permission: { ...ENSO_DEFAULT_PERMISSION_POLICY.permission, web_fetch: 'allow' },
      }),
    ),
  )
  expect(readdirSync(join(home, 'prompts')).toSorted()).toEqual(Object.keys(PROMPT_LIBRARY).toSorted())

  for (const [path, contents] of Object.entries(DEMO_FILES))
    expect(readFileSync(join(project, path), 'utf8')).toBe(contents)
  const git = (...gitArguments: string[]): string =>
    spawnSync('git', gitArguments, { cwd: project, encoding: 'utf8', env: gitChildEnvironment() }).stdout.trim()
  expect(git('log', '--format=%s %an')).toBe('shop-api demo')
  expect(git('status', '--porcelain')).toBe('')
  expect(git('rev-parse', '--show-toplevel')).toBe(project)
})
