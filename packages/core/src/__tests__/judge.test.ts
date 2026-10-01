import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENSO_JUDGE_POLICY } from '../command-judge.ts'
import { DEFAULT_GUARD_POLICY } from '../guard.ts'
import { judgeFilesOf, redactJudgeState, redactJudgeText } from '../judge.ts'

/**
 * The command judge's node half (#469): what must never cross to a backend, and what a command
 * runs, read off disk for the judge.
 */

const fragments = DEFAULT_GUARD_POLICY.secretPathFragments
const workspace = mkdtempSync(join(tmpdir(), 'enso-judge-'))
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

const LIVE_KEY = 'tsk-live-0123456789abcdef'
const ROTATED_KEY = `${LIVE_KEY}-rotated99`

// ⚠ #469's acceptance: no secret-shaped value reaches any backend. Every shape the issue names, and
// a known secret value inside a longer one, which a first-match alternation would cut short.
test('⚠ redaction: known values (longest first), secret assignments and flags, auth headers and token shapes', () => {
  const redact = (text: string): string => redactJudgeText(text, [LIVE_KEY, ROTATED_KEY])
  expect(redact(`echo ${ROTATED_KEY} && echo ${LIVE_KEY}`)).toBe('echo [REDACTED:value] && echo [REDACTED:value]')
  expect(redact('GITHUB_TOKEN=abc123 export API_KEY="s3cr3t" PATH=/usr/bin make')).toBe(
    'GITHUB_TOKEN=[REDACTED] export API_KEY=[REDACTED] PATH=/usr/bin make',
  )
  expect(redact('deploy --token hunter2 --password=pw1 --verbose')).toBe(
    'deploy --token [REDACTED] --password=[REDACTED] --verbose',
  )
  expect(redact(`curl -H 'Authorization: Basic dXNlcjpwYXNz' -H "X-Other: 1"`)).toBe(
    `curl -H 'Authorization: [REDACTED]' -H "X-Other: 1"`,
  )
  expect(redact('wget --header "Bearer abc.def-ghi" x')).toBe('wget --header "Bearer [REDACTED]" x')
  expect(redact('gh auth login --with-token ghp_0123456789abcdefghijABCDEFGHIJ')).toBe(
    'gh auth login --with-token [REDACTED]',
  )
  expect(redact('git remote set-url origin https://x:ghp_0123456789abcdefghijABCDEFGHIJ@github.com/a/b')).toBe(
    'git remote set-url origin https://x:[REDACTED:value]@github.com/a/b',
  )
  expect(redact('echo sk-ant-api03-ABCDEFGHIJKLMNOP && echo AKIAABCDEFGHIJKLMNOP')).toBe(
    'echo [REDACTED:value] && echo [REDACTED:value]',
  )
  // A path is not a secret: the judge has to see which file a command reads.
  expect(redact('cat ~/.aws/credentials private.env')).toBe('cat ~/.aws/credentials private.env')
})

test('every string of the state is redacted: the command, the files, the calls before it and the refusal', () => {
  const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ'
  const redacted = redactJudgeState(
    {
      cwd: '/w',
      policy: ENSO_JUDGE_POLICY,
      command: `echo ${secret}`,
      files: { 'deploy.sh': `TOKEN=${secret} ./push` },
      recentCalls: [{ tool: 'bash', command: `curl -H "Authorization: token ${secret}"`, refused: true }],
      denied: { command: `curl -H "Authorization: token ${secret}"`, reason: `refused ${secret}` },
    },
    [],
  )
  expect(JSON.stringify(redacted)).not.toContain(secret)
  expect(redacted.cwd).toBe('/w')
  expect(redacted.policy).toBe(ENSO_JUDGE_POLICY)
})

function inWorkspace(name: string, contents: string | Uint8Array): void {
  mkdirSync(join(workspace, name, '..'), { recursive: true })
  writeFileSync(join(workspace, name), contents)
}

inWorkspace('cleanup.sh', '#!/bin/sh\nrm -rf records\n')
inWorkspace('tools/run.py', 'import shutil; shutil.rmtree("records")\n')
inWorkspace('package.json', JSON.stringify({ scripts: { test: 'bun test', wipe: 'rm -rf records' } }))
inWorkspace('Makefile', 'clean:\n\trm -rf build\n')
inWorkspace('.env', 'API_KEY=never-sent\n')
inWorkspace('bin/tool', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]))
// Named like Bun's own commands: under a shell or another interpreter they are files (PR #533 review).
inWorkspace('build', '#!/bin/sh\nrm -rf records\n')
inWorkspace('run', 'import os; os.remove("records/a")\n')
symlinkSync(join(workspace, '.env'), join(workspace, 'notes.sh'))

// "Write it to a file, then run it" stays open unless the judge reads the file (#469).
test('script resolution: a script handed to a shell or interpreter, a package script, the Makefile', () => {
  expect(judgeFilesOf('bash cleanup.sh', workspace, fragments)).toEqual({ 'cleanup.sh': '#!/bin/sh\nrm -rf records\n' })
  expect(judgeFilesOf('cd x && python3 tools/run.py --fast', workspace, fragments)).toEqual({
    'tools/run.py': 'import shutil; shutil.rmtree("records")\n',
  })
  expect(judgeFilesOf('npm run wipe', workspace, fragments)).toEqual({ 'package.json#scripts.wipe': 'rm -rf records' })
  expect(judgeFilesOf('npm test', workspace, fragments)).toEqual({ 'package.json#scripts.test': 'bun test' })
  expect(judgeFilesOf('make clean', workspace, fragments)).toEqual({ Makefile: 'clean:\n\trm -rf build\n' })
  // Bun's own test runner and a program from the system run nothing from the workspace.
  expect(judgeFilesOf('bun test && git status', workspace, fragments)).toEqual({})
  expect(judgeFilesOf('python3 -c "print(1)"', workspace, fragments)).toEqual({})
  // Bun's command names are Bun's alone: `bash build` runs the file called build.
  expect(judgeFilesOf('bash build && python3 run', workspace, fragments)).toEqual({
    build: '#!/bin/sh\nrm -rf records\n',
    run: 'import os; os.remove("records/a")\n',
  })
})

// ⚠ A secret's contents never reach the judge — by its name, or through a link with an innocent one.
test('⚠ a secret-looking path is withheld, also through a symlink; a binary is withheld', () => {
  expect(judgeFilesOf('source .env', workspace, fragments)).toEqual({
    '.env': '[withheld: the path looks like credential material]',
  })
  expect(judgeFilesOf('bash notes.sh', workspace, fragments)).toEqual({
    'notes.sh': '[withheld: the path looks like credential material]',
  })
  expect(judgeFilesOf('./bin/tool', workspace, fragments)).toEqual({ 'bin/tool': '[withheld: a binary file]' })
  expect(JSON.stringify(judgeFilesOf('bash notes.sh; source .env', workspace, fragments))).not.toContain('never-sent')
})
