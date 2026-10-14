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
  expect(config.reviewCondition).toContain('draft == false')
})

test("every expression in the real workflow's prompt is one the local review fills (#981)", () => {
  const prompt = fillPrompt(readReviewWorkflow(workflowText).promptTemplate, VALUES)
  expect(prompt).not.toContain('${{')
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
  ['the --allowedTools list', (text: string) => text.replace('--allowedTools', '--model')],
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
