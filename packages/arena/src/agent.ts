import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Agent,
  type AgentTool,
  type AgentToolResult,
  type StreamFn,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model, TextContent } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { redactJudgeText } from '@enso/core/judge'
import { ensoAgentDir } from '@enso/core/paths'
import { ArenaActToolParameters, ArenaVisualActToolParameters } from './act-tool.ts'
import { ARENA_UI_TOOL, ARENA_VIEW } from './actions.ts'
import type { ArenaActOutcome, ArenaDriver, ArenaDriverSession } from './recorder.ts'
import type { ArenaPerception } from './timeline.ts'

/**
 * Dogfood Arena's agent runner (#556, #584): the agent under test, given the brief and ONE tool.
 *
 * ⚠ THE BOUNDARY IS THE TOOL LIST. The agent is a pi `Agent` over a bare model call, not a
 * coding agent: it has no shell, no file access, no web — pi-agent-core adds no tool of its own,
 * and a call to any name but `act` is answered "Tool … not found" with nothing run (measured:
 * a scripted `bash` call). `act` hands the action to the recorder in this process, which
 * performs it on its page and records it as sent by the agent. So the agent cannot write the
 * project's files itself, cannot reach Enso's API, and cannot read Enso's source: the only way
 * the work gets done is by using Enso through its page. The manifest's `boundary` re-checks this
 * from the timeline after the run, rather than taking this comment's word for it.
 *
 * What it does NOT bound: Enso's own agent. The agent under test may ask Enso, through the
 * prompt box, to run anything Enso's permissions allow. That is using the product — it goes
 * through the UI and is in Enso's records — and a finding about it is a finding about Enso.
 */

/** The picture an `act` answer carries: a visual run's view (#680), else the screenshot a result names. */
function screenshotPath(outcome: ArenaActOutcome): string | undefined {
  if (outcome.view !== undefined) return outcome.view
  const result = outcome.result
  if (typeof result !== 'object' || result === null || !('screenshot' in result)) return undefined
  return typeof result.screenshot === 'string' ? result.screenshot : undefined
}

/**
 * The tool result the model sees: the recorder's answer as JSON, and — on a model that takes images —
 * the picture itself: a visual run's view after every action (#680), a tree run's screenshot when
 * asked for, because a person using Enso sees the screen, not only its accessibility tree.
 */
export function arenaToolResult(outcome: ArenaActOutcome, imagesAccepted: boolean): AgentToolResult<undefined> {
  const content: (TextContent | ImageContent)[] = [{ type: 'text', text: JSON.stringify(outcome, null, 2) }]
  const shot = imagesAccepted ? screenshotPath(outcome) : undefined
  if (shot !== undefined) {
    content.push({ type: 'image', data: readFileSync(shot).toString('base64'), mimeType: 'image/png' })
  }
  return { content, details: undefined, ...(outcome.ok ? {} : { isError: true }) }
}

/** `act`: the agent's one tool. Each call is one action on the recorder's page, recorded as the agent's. */
export function arenaUiTool(
  session: Pick<ArenaDriverSession, 'act'>,
  imagesAccepted: boolean,
  onStopped: () => void,
  perception: ArenaPerception = 'tree',
): AgentTool<typeof ArenaActToolParameters | typeof ArenaVisualActToolParameters, undefined> {
  return {
    name: ARENA_UI_TOOL,
    label: 'Act on Enso',
    description:
      perception === 'visual'
        ? `One action on Enso’s page, as a person at the browser would make it: a click, a key, text typed. ` +
          `Every answer brings a ${ARENA_VIEW.width}×${ARENA_VIEW.height} screenshot of the page after the action; ` +
          'that picture is the only way you see the page. This is your only tool: everything you do, you do through Enso.'
        : 'One action on Enso’s page, as a person at the browser would make it. Returns what happened as JSON. ' +
          'This is your only tool: everything you do, you do through Enso.',
    parameters: perception === 'visual' ? ArenaVisualActToolParameters : ArenaActToolParameters,
    executionMode: 'sequential',
    execute: async (_toolCallId, parameters) => {
      const outcome = await session.act(parameters)
      const stopping = parameters.action === 'stop' && outcome.ok
      if (stopping) onStopped()
      return { ...arenaToolResult(outcome, imagesAccepted), ...(stopping ? { terminate: true } : {}) }
    },
  }
}

/** The reasoning levels `--thinking` accepts: pi's own, so the runner passes one straight through. */
export const ARENA_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** The first user turn: the brief is the system prompt, this only starts the work. */
const KICKOFF: Readonly<Record<ArenaPerception, string>> = {
  tree: 'Begin the assignment. Start by reading the page.',
  visual: 'Begin the assignment. Start by taking a screenshot to see the page: {"action":"screenshot"}.',
}

/** Sent when the agent ends a turn without stopping the run: it may be done, or may have just paused. */
const NUDGE =
  'Your turn ended, but the run is still going. If you are finished, write your retrospective note and send ' +
  '{"action":"stop"}. Otherwise, carry on with the assignment.'

/** How many times a turn that ends without `stop` is answered with the nudge before the runner gives up. */
const MAX_NUDGES = 3

/** What the runner is given: the model, how to reach it, and what the agent is told. */
export interface ArenaAgentOptions {
  readonly model: Model<Api>
  readonly streamFn: StreamFn
  readonly thinking: ThinkingLevel
  /** The brief (`arenaBrief(scenario, 'tool')`): the assignment and the one way in. */
  readonly brief: string
  /** The home's known secret values: the transcript on disk is redacted with them. */
  readonly secretValues: readonly string[]
  readonly maxNudges?: number
  /** How the agent perceives the page (#680): the tree (the default), or a screenshot after every action. */
  readonly perception?: ArenaPerception
}

/** A transcript line on disk: image bytes left out (the screenshot is on disk already), text redacted. */
function transcriptLine(message: unknown, secretValues: readonly string[]): string {
  const json = JSON.stringify(message, (key, value: unknown) =>
    key === 'data' && typeof value === 'string' && value.length > 1000
      ? `[${value.length} base64 characters omitted]`
      : value,
  )
  return `${redactJudgeText(json, secretValues)}\n`
}

/**
 * The runner as the recorder's driver: start the agent with the brief and its one tool, answer a
 * turn that ends without `stop` with a nudge (at most `maxNudges` times), abort it when the run
 * stops, and keep its transcript in `<run>/agent/transcript.jsonl`. Settles with why it ended.
 */
export function arenaAgentDriver(options: ArenaAgentOptions): ArenaDriver {
  return async (session) => {
    const agentDirectory = join(session.runDirectory, 'agent')
    mkdirSync(agentDirectory, { recursive: true })
    const transcriptPath = join(agentDirectory, 'transcript.jsonl')
    let stopSent = false
    let runStopped: string | undefined
    const agent = new Agent({
      initialState: {
        systemPrompt: options.brief,
        model: options.model,
        thinkingLevel: options.thinking,
        tools: [
          arenaUiTool(
            session,
            options.model.input.includes('image'),
            () => (stopSent = true),
            options.perception ?? 'tree',
          ),
        ],
      },
      streamFn: options.streamFn,
      toolExecution: 'sequential',
    })
    // Read off the agent itself, not restated: what the model was actually given.
    session.record({
      kind: 'agent-start',
      provider: options.model.provider,
      model: options.model.id,
      thinking: options.thinking,
      tools: agent.state.tools.map((tool) => tool.name),
    })
    agent.subscribe((event) => {
      if (event.type === 'message_end')
        appendFileSync(transcriptPath, transcriptLine(event.message, options.secretValues))
      if (event.type === 'tool_execution_start' && event.toolName !== ARENA_UI_TOOL) {
        session.record({ kind: 'agent-tool-refused', tool: event.toolName })
      }
    })
    void session.stopped.then((reason) => {
      runStopped = reason
      agent.abort()
    })

    const maxNudges = options.maxNudges ?? MAX_NUDGES
    for (let turn = 0; turn <= maxNudges; turn += 1) {
      if (runStopped !== undefined) return `the run stopped (${runStopped})`
      await agent.prompt(turn === 0 ? KICKOFF[options.perception ?? 'tree'] : NUDGE)
      if (stopSent) return 'it stopped the run'
      const failure = agent.state.errorMessage
      if (failure !== undefined && runStopped === undefined) {
        return `the model call failed: ${redactJudgeText(failure, options.secretValues)}`
      }
    }
    return runStopped === undefined
      ? `it ended its turn ${maxNudges + 1} times without stopping the run`
      : `the run stopped (${runStopped})`
  }
}

/** A model reference, `provider/model-id`, split at the first slash (model ids may hold more). */
export function parseModelReference(reference: string): { readonly provider: string; readonly id: string } | undefined {
  const slash = reference.indexOf('/')
  if (slash <= 0 || slash === reference.length - 1) return undefined
  return { provider: reference.slice(0, slash), id: reference.slice(slash + 1) }
}

/**
 * The model the agent under test runs on, through pi's model runtime over the home's agent dir —
 * the same login Enso's own sessions use (`agent-host.ts`). Fails before anything starts when the
 * model is unknown or its provider has no login.
 */
export async function resolveArenaModel(
  home: string,
  reference: string,
): Promise<{ readonly model: Model<Api>; readonly streamFn: StreamFn }> {
  const named = parseModelReference(reference)
  if (named === undefined) throw new Error(`--agent takes provider/model-id, not "${reference}"`)
  const agentDir = ensoAgentDir(home)
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  })
  const model = runtime.getModel(named.provider, named.id)
  if (model === undefined) {
    const known = runtime.getModels(named.provider).map((candidate) => candidate.id)
    throw new Error(
      `no model "${named.id}" for provider "${named.provider}"${known.length === 0 ? '' : ` — known: ${known.join(', ')}`}`,
    )
  }
  if (!runtime.hasConfiguredAuth(named.provider)) {
    throw new Error(`provider "${named.provider}" has no login in ${agentDir} — log in through Enso first`)
  }
  return { model, streamFn: (target, context, streamOptions) => runtime.streamSimple(target, context, streamOptions) }
}
