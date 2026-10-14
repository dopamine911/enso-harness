import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fillPrompt,
  REVIEW_WORKFLOW_PATH,
  ReviewWorkflowShapeError,
  readReviewWorkflow,
  splitAllowedTools,
  UnknownPromptExpressionError,
} from '../review/workflow-config.ts'

const workflowText = readFileSync(join(import.meta.dir, '..', '..', REVIEW_WORKFLOW_PATH), 'utf8')
const VALUES = {
  repository: 'owner/name',
  pullRequestNumber: 42,
  scope: 'new-commits',
  headSha: 'f'.repeat(40),
} as const

/**
 * ⚠ THE LOCAL REVIEWER IS CONFIGURED BY THE REAL WORKFLOW (#981). Read from the checked-in file, so
 * a workflow edit that moves the prompt, the grant or the comment-list step fails here — not as a
 * local review run on an empty prompt.
 */
test('⚠ the real workflow yields the prompt, the read-only grant and the comment-list command (#981)', () => {
  const config = readReviewWorkflow(workflowText)
  expect(config.allowedTools).toEqual([
    'Read',
    'Grep',
    'Glob',
    'Bash(gh pr view:*)',
    'Bash(gh pr diff:*)',
    'Bash(gh pr comment:*)',
  ])
  expect(config.listCommand).toContain('scripts/docs/touched-comments.ts --base "$FROM"')
  expect(config.promptTemplate).toContain('## Output')
  expect(config.reviewCondition).toContain("needs.pull-request.outputs.draft == 'false'")
})

test("every expression in the real workflow's prompt is one the local review fills (#981)", () => {
  const prompt = fillPrompt(readReviewWorkflow(workflowText).promptTemplate, VALUES)
  expect(prompt).not.toContain('${{')
  // The reviewer's shell has no $PR_NUMBER, and the grant refuses `$` (#989's review).
  expect(prompt).not.toContain('$PR_NUMBER')
  expect(prompt).toContain('gh pr diff 42')
  expect(prompt).toContain('PR NUMBER: 42')
  expect(prompt).toContain('REVIEW SCOPE: new-commits')
  expect(prompt).toContain(`HEAD: ${'f'.repeat(40)}`)
})

test('a prompt expression the local review does not know is refused, not passed through as text', () => {
  expect(() => fillPrompt(`PR: \${{ github.event.pull_request.title }}`, VALUES)).toThrow(UnknownPromptExpressionError)
})

test.each([
  ['the review job', (text: string) => text.replace(/^ {2}review:$/m, '  renamed-review:')],
  ['the claude step', (text: string) => text.replace(/id: claude$/m, 'id: someone-else')],
  ['the --allowedTools list', (text: string) => text.replace('--allowedTools "', '--model "')],
  ['the comment-list step', (text: string) => text.replace('List the comments this run puts at risk', 'Renamed')],
  ['the scope step', (text: string) => text.replace('Choose the review scope', 'Renamed')],
])('a workflow without %s fails loudly', (_piece, mutate) => {
  const mutated = mutate(workflowText)
  expect(mutated).not.toBe(workflowText)
  expect(() => readReviewWorkflow(mutated)).toThrow(ReviewWorkflowShapeError)
})

test('a comma inside a pattern belongs to the pattern', () => {
  expect(splitAllowedTools('Read, Bash(gh pr view:*),Bash(a,b:*) ,')).toEqual([
    'Read',
    'Bash(gh pr view:*)',
    'Bash(a,b:*)',
  ])
})

/**
 * The local reviewer reads the BASE branch's workflow, so for one merge it may still meet the earlier,
 * `pull_request`-event spelling of the prompt. Both fill the same way.
 */
test('the earlier pull_request-event prompt expressions still fill, for a base branch that has them', () => {
  const earlier = `PR NUMBER: \${{ github.event.pull_request.number }}\nHEAD: \${{ github.event.pull_request.head.sha }}`
  expect(fillPrompt(earlier, VALUES)).toBe(`PR NUMBER: 42\nHEAD: ${'f'.repeat(40)}`)
})

test('the workflow runs only by hand, and every job reads the pull request from the pull-request job', async () => {
  const workflow = Bun.YAML.parse(workflowText) as {
    on: Record<string, unknown>
    jobs: Record<string, { needs?: string | string[] }>
  }
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflowText).not.toContain('github.event.')
  expect(workflowText).not.toContain('track_progress: true')
  expect([workflow.jobs['touched-comments']?.needs].flat()).toContain('pull-request')
  expect([workflow.jobs.review?.needs].flat()).toContain('pull-request')
})

/**
 * ⚠ THE REVIEW JOB CHECKS OUT THE PULL REQUEST'S HEAD (#994's review). A manual run's default checkout is
 * the ref it was started from, normally `main`; the reviewer would read main's files against the PR's diff.
 */
test("⚠ the review job checks out the pull request's head, and the comment-list job keeps no cache", () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> }
  const workflow = Bun.YAML.parse(workflowText) as { jobs: Record<string, { steps?: Step[] }> }
  const reviewCheckout = workflow.jobs.review?.steps?.find((step) => step.uses?.startsWith('actions/checkout'))
  expect(reviewCheckout?.with?.ref).toBe(`\${{ needs.pull-request.outputs.head_sha }}`)
  const listSetupBun = workflow.jobs['touched-comments']?.steps?.find((step) =>
    step.uses?.startsWith('oven-sh/setup-bun'),
  )
  expect(listSetupBun?.with?.['no-cache']).toBe(true)
  // ⚠ The Actions status step updates only its own comment: the local reviewer's, under the same marker,
  // carries the head it last reviewed, and overwriting it makes the local reviewer forget (#994's review).
  const statusStep = workflow.jobs.review?.steps?.find((step) => step.name === 'Post run indicator (sticky comment)')
  expect(statusStep?.run).toContain('.user.login == \\"github-actions[bot]\\"')
})
