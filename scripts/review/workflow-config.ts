/**
 * The PR reviewer's configuration, read from the one place it is written: the GitHub workflow
 * `.github/workflows/claude-pr-review.yml` (#981). The local review (`review-pr.ts`) runs the SAME
 * prompt under the SAME tool grant as the Actions review, so the two cannot drift apart: changing
 * the review means editing the workflow, as it always has.
 *
 * ⚠ READ, NEVER COPIED. A second copy of the prompt would be the drift this file exists to
 * prevent. So every piece is found by its place in the workflow (the step `id: claude`, its
 * `prompt` and `claude_args`), and a workflow refactor that moves one fails here, loudly, rather
 * than leaving the local reviewer on an empty or stale prompt.
 */

/** The workflow file, from the repository root. */
export const REVIEW_WORKFLOW_PATH = '.github/workflows/claude-pr-review.yml'

/** The job that runs the review, and the id of its Claude step. */
const REVIEW_JOB = 'review'
const REVIEW_STEP_ID = 'claude'
/** The job that builds the comment list, and the names of its two steps the local run repeats. */
const LIST_JOB = 'touched-comments'
const SCOPE_STEP_NAME = 'Choose the review scope'
const LIST_STEP_NAME = 'List the comments this run puts at risk'

/** `--allowedTools "A,B(c:*)"` inside the step's `claude_args`: the quoted list. */
const ALLOWED_TOOLS_ARGUMENT = /--allowedTools\s+"([^"]+)"/
/**
 * The prompt's shell variable for the pull request's number, as written in its commands
 * (`gh pr diff $PR_NUMBER`). ⚠ Filled with the number here: the reviewer's shell has no such
 * variable, and the grant hook refuses any `$` in a command (#989's review found the reviewer
 * refused on the first command the prompt gives it).
 */
const PULL_REQUEST_NUMBER_VARIABLE = /\$PR_NUMBER\b/g
/** A GitHub expression, `${{ … }}`, with the expression inside captured. */
const WORKFLOW_EXPRESSION = /\$\{\{\s*([^}]+?)\s*\}\}/g
/** The touched-comments command's `--base` argument, which the workflow fills from an env var. */
const LIST_COMMAND_BASE = /--base\s+"\$FROM"/

/** A workflow step, as much of one as this file reads. */
interface WorkflowStep {
  readonly id?: string
  readonly name?: string
  readonly run?: string
  readonly with?: Record<string, unknown>
}

interface WorkflowJob {
  readonly if?: string
  readonly steps?: readonly WorkflowStep[]
}

interface Workflow {
  readonly jobs?: Record<string, WorkflowJob>
}

/** Everything the local review takes from the workflow. */
export interface ReviewWorkflowConfig {
  /** The review prompt, with its `${{ … }}` expressions still in it — `fillPrompt` fills them. */
  readonly promptTemplate: string
  /** The tool grant, one entry per tool or `Tool(prefix:*)` pattern, as `--allowedTools` lists it. */
  readonly allowedTools: readonly string[]
  /** The touched-comments command, with `$FROM` where the workflow passes the scope's base commit. */
  readonly listCommand: string
  /** The review job's `if:`, kept so the skip rule (drafts, bot authors) is visible beside the local one. */
  readonly reviewCondition: string
}

/** A workflow that no longer has a piece the local review reads. */
export class ReviewWorkflowShapeError extends Error {
  constructor(what: string) {
    super(`${REVIEW_WORKFLOW_PATH}: ${what} — the local review reads it from there (#981)`)
    this.name = 'ReviewWorkflowShapeError'
  }
}

function jobOf(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name]
  if (job === undefined) throw new ReviewWorkflowShapeError(`no \`${name}\` job`)
  return job
}

function stepNamed(job: WorkflowJob, jobName: string, stepName: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === stepName)
  if (step === undefined) throw new ReviewWorkflowShapeError(`no "${stepName}" step in the \`${jobName}\` job`)
  return step
}

function stringInput(step: WorkflowStep, input: string): string {
  const value = step.with?.[input]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReviewWorkflowShapeError(`the \`${REVIEW_STEP_ID}\` step has no \`${input}\``)
  }
  return value
}

/**
 * Splits `--allowedTools`' comma list into its entries. A comma inside a pattern's parentheses
 * (none today) belongs to the pattern, so the split tracks depth rather than splitting blindly.
 */
export function splitAllowedTools(list: string): string[] {
  const entries: string[] = []
  let depth = 0
  let current = ''
  for (const character of list) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      entries.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  entries.push(current.trim())
  return entries.filter((toolEntry) => toolEntry.length > 0)
}

/**
 * The reviewer's configuration from the workflow's text. Throws `ReviewWorkflowShapeError` when a
 * piece the local review needs is not where it is looked for.
 */
export function readReviewWorkflow(workflowText: string): ReviewWorkflowConfig {
  const workflow = Bun.YAML.parse(workflowText) as Workflow
  const reviewJob = jobOf(workflow, REVIEW_JOB)
  const claudeStep = reviewJob.steps?.find((step) => step.id === REVIEW_STEP_ID)
  if (claudeStep === undefined)
    throw new ReviewWorkflowShapeError(`no step \`id: ${REVIEW_STEP_ID}\` in the review job`)
  const allowed = ALLOWED_TOOLS_ARGUMENT.exec(stringInput(claudeStep, 'claude_args'))?.[1]
  if (allowed === undefined) throw new ReviewWorkflowShapeError('the `claude_args` input names no `--allowedTools "…"`')
  const listJob = jobOf(workflow, LIST_JOB)
  // The scope step is looked up so a rename fails here; its rule is restated in `review-pr.ts#planReview`.
  stepNamed(listJob, LIST_JOB, SCOPE_STEP_NAME)
  const listCommand = stepNamed(listJob, LIST_JOB, LIST_STEP_NAME).run?.trim()
  if (listCommand === undefined || !LIST_COMMAND_BASE.test(listCommand)) {
    throw new ReviewWorkflowShapeError(`the "${LIST_STEP_NAME}" step no longer runs a command with \`--base "$FROM"\``)
  }
  return {
    promptTemplate: stringInput(claudeStep, 'prompt'),
    allowedTools: splitAllowedTools(allowed),
    listCommand,
    reviewCondition: (reviewJob.if ?? '').trim(),
  }
}

/** The values a local run fills the prompt's four expressions with. */
export interface PromptValues {
  /** `owner/name`. */
  readonly repository: string
  readonly pullRequestNumber: number
  /** `full`, or `new-commits` when only a push's own commits are reviewed. */
  readonly scope: 'full' | 'new-commits'
  readonly headSha: string
}

/** An expression in the prompt that a local run does not know how to fill. */
export class UnknownPromptExpressionError extends Error {
  constructor(expression: string) {
    super(
      `${REVIEW_WORKFLOW_PATH}: the review prompt uses \`\${{ ${expression} }}\`, which the local review cannot fill — teach \`fillPrompt\` what it means (#981)`,
    )
    this.name = 'UnknownPromptExpressionError'
  }
}

/**
 * The prompt with its `${{ … }}` expressions, and its `$PR_NUMBER`, filled from a local run's
 * values. Each expression the workflow uses today is listed by its exact text; any other throws, so
 * a new expression added to the workflow is caught here instead of reaching the model as literal
 * `${{ … }}` text.
 */
export function fillPrompt(template: string, values: PromptValues): string {
  const known: Record<string, string> = {
    'github.repository': values.repository,
    'github.event.pull_request.number': String(values.pullRequestNumber),
    "needs.touched-comments.outputs.scope || 'full'": values.scope,
    'github.event.pull_request.head.sha': values.headSha,
  }
  return template
    .replace(WORKFLOW_EXPRESSION, (_whole, expression: string) => {
      const value = known[expression]
      if (value === undefined) throw new UnknownPromptExpressionError(expression)
      return value
    })
    .replace(PULL_REQUEST_NUMBER_VARIABLE, String(values.pullRequestNumber))
}
