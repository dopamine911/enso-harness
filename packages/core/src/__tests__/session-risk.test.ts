import { expect, test } from 'bun:test'
import { ENSO_GUARD_DENIAL_ENTRY, type EnsoGuardRule } from '../guard.ts'
import {
  ENSO_PERMISSION_DENIAL_ENTRY,
  type EnsoPermissionDenialResolution,
  foldSessionRisk,
  INITIAL_SESSION_RISK,
  riskEventsOfEntries,
  sessionRiskOfEntries,
  sessionRiskStep,
} from '../session-risk.ts'

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
  sessionRiskOfEntries(entries).signals.map((signal) => [signal.signal, signal.toolCallId])

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
  for (const event of riskEventsOfEntries(entries)) {
    state = sessionRiskStep(state, event).state
    levels.push(state.level)
  }
  // call c1, deny c1, call c2, deny c2 (retry: medium), call c3, deny c3 (retry + obfuscation: high),
  // call c4 (an alternate path beside obfuscation: incident).
  expect(levels).toEqual(['low', 'low', 'low', 'medium', 'medium', 'high', 'incident'])
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
  expect(riskEventsOfEntries(entries).map((event) => `${event.kind}:${event.toolCallId}`)).toEqual([
    'call:c1',
    'guard-denial:c1',
    'call:c2',
  ])
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

test('the fold is the same whole or step by step, and a replay of nothing is low with no signals', () => {
  expect(foldSessionRisk([])).toEqual(INITIAL_SESSION_RISK)
  expect(sessionRiskOfEntries([])).toEqual({ level: 'low', signals: [] })
})
