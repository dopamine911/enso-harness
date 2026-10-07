import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent'
import { modeAgentName } from '@enso/core'
import {
  PERMISSIONS_DECISION_CHANNEL,
  PERMISSIONS_UI_PROMPT_CHANNEL,
  type PermissionState,
} from '@gotgenes/pi-permission-system'

/**
 * Where a permission card stands among the questions ONE tool call asks (#728).
 *
 * The engine decides a call gate by gate (`ToolCallGatePipeline.evaluate` in
 * `@gotgenes/pi-permission-system`): the path gates first — `path`, `external_directory`, and for a
 * shell call their bash forms — and the tool's own surface last (`bash`: the command). Every gate
 * that resolves to `ask` asks on its own, with its own answers: the outside path's card offers a
 * session grant for that directory, the command's a grant for the command. So one bash call that
 * writes outside the tree asked twice, one card straight after the other, and nothing on the first
 * said that a second was coming — or that "Yes, for this session" on it left the command unanswered.
 *
 * ⚠ One card answering both is not Enso's to build. The answers, and the session grants they
 * record, are the engine's, gate by gate; a chain link that allowed the second ask on the strength
 * of the first could not record the session grant the user chose, and the engine caps a link's
 * `allow` on the path families to a deferral. So each card says where it stands instead.
 *
 * How: the host hears the engine's `permissions:ui_prompt`, which it emits immediately before its
 * `select`, in the same synchronous step, and `permissions:decision`, one per gate. A path ask opens
 * the call's run of questions; the engine's own query says whether the tool's own gate will ask
 * too (`checkPermission`, the gate's resolution at parity, #309 there); the tool gate's decision —
 * asked or not — or any deny closes it. Sound because pi prepares a turn's tool calls one at a time
 * (`executeToolCallsParallel` awaits each call's `tool_call` hooks before the next call's), so the
 * asks between a call's first path ask and its tool decision are that call's.
 */

const PERMISSION_CALL_QUESTIONS_EXTENSION_NAME = 'enso-permission-call-questions'
export const PERMISSION_CALL_QUESTIONS_EXTENSION_PATH = `<inline:${PERMISSION_CALL_QUESTIONS_EXTENSION_NAME}>`

/** The engine's state for a value on a surface under the asking agent's policy; undefined with no engine. */
type PolicyQuery = (surface: string, value: string, agentName: string | undefined) => PermissionState | undefined

/** Whether the tool's own gate, decided last, asks too: `maybe` when `auto`'s reviewer answers it first. */
type ToolGateAsks = 'yes' | 'maybe' | 'no'

/** The questions one tool call has asked so far. */
interface CallQuestions {
  readonly tool: string
  readonly toolAsks: ToolGateAsks
  asked: number
}

/** One ask as the engine announces it. */
interface AnnouncedAsk {
  /** The gate surface the rule fired on: `external_directory_write`, `bash`, … */
  readonly surface: string
  readonly tool: string
  /** The command for a shell call, the path for a path-bearing tool. */
  readonly value: string
  readonly agentName: string | undefined
}

/** A path gate's surface: `path`, `external_directory`, or one of their directional members. */
const PATH_GATE_SURFACE = /^(?:path|external_directory)(?:_|$)/

function objectOf(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined
}

/**
 * A `permissions:ui_prompt` this session's own call raised, read defensively: a version-skewed
 * event reads as none. A subagent's forwarded ask is not one of this session's calls.
 */
function announcedAsk(raw: unknown): AnnouncedAsk | undefined {
  const event = objectOf(raw)
  const request = objectOf(event?.request)
  if (event?.source !== 'tool_call' || (event.forwarding ?? null) !== null) return undefined
  const { surface, toolName } = request ?? {}
  if (typeof surface !== 'string' || typeof toolName !== 'string' || typeof event.value !== 'string') return undefined
  const agentName = typeof event.agentName === 'string' ? event.agentName : undefined
  return { surface, tool: toolName, value: event.value, agentName }
}

/** What the tool's own question is about. */
function subjectOf(tool: string): string {
  return tool === 'bash' ? 'running the command' : `the ${tool} call itself`
}

/** A path card's lead, or undefined for the only question of its call. */
function pathCardLead(call: CallQuestions): string | undefined {
  if (call.asked === 1 && call.toolAsks === 'no') return undefined
  const place = `Question ${call.asked} about this ${call.tool} call: this answer covers the path only.`
  if (call.toolAsks === 'yes') return `${place} A separate question about ${subjectOf(call.tool)} follows.`
  if (call.toolAsks === 'maybe') {
    return `${place} Auto mode reviews ${subjectOf(call.tool)} next, separately, and may ask you about it too.`
  }
  return place
}

/** The tool card's lead, after the path questions of its call: the last question, and what the others covered. */
function toolCardLead(call: CallQuestions): string {
  const earlier = call.asked === 2 ? 'The question before it' : `The ${call.asked - 1} questions before it`
  return `Question ${call.asked} of ${call.asked} about this ${call.tool} call: ${subjectOf(call.tool)}. ${earlier} covered the path only.`
}

/** Whether the tool's own gate will ask, by the engine's own query for the call's tool and value. */
function toolGateAsks(ask: AnnouncedAsk, query: PolicyQuery): ToolGateAsks {
  if (query(ask.tool, ask.value, ask.agentName) !== 'ask') return 'no'
  // In `auto` the `enso-auto` link answers the tool's ask before the user is asked (permission-mode.md, `auto`).
  return ask.agentName === modeAgentName('auto') ? 'maybe' : 'yes'
}

/** The host's half of #728: an extension that hears the engine, and the title a select's card shows. */
export interface PermissionCallQuestions {
  readonly extension: InlineExtension
  /** The engine's own title led by where its card stands, while the engine is asking; any other title as given. */
  readonly selectTitle: (title: string) => string
}

/** One session's tracker; `query` is the session's engine, resolved when asked. */
export function createPermissionCallQuestions(query: PolicyQuery): PermissionCallQuestions {
  let call: CallQuestions | undefined
  let lead: string | undefined

  const leadFor = (ask: AnnouncedAsk): string | undefined => {
    if (PATH_GATE_SURFACE.test(ask.surface)) {
      if (call?.tool !== ask.tool) call = { tool: ask.tool, toolAsks: toolGateAsks(ask, query), asked: 0 }
      call.asked += 1
      return pathCardLead(call)
    }
    if (call === undefined) return undefined
    call.asked += 1
    const last = toolCardLead(call)
    call = undefined
    return last
  }

  const prompted = (raw: unknown): void => {
    const ask = announcedAsk(raw)
    lead = ask === undefined ? undefined : leadFor(ask)
    // The engine's `select` follows its announcement in this same synchronous step, so no later
    // question — the host's own, another extension's — can wear this lead.
    queueMicrotask(() => {
      lead = undefined
    })
  }

  const decided = (raw: unknown): void => {
    const decision = objectOf(raw)
    if (call === undefined || decision === undefined) return
    // A deny ends the call; so does the tool's own gate, decided last, whether it asked or not.
    const toolGate = typeof decision.surface === 'string' && !PATH_GATE_SURFACE.test(decision.surface)
    if (decision.result === 'deny' || toolGate) call = undefined
  }

  return {
    extension: {
      name: PERMISSION_CALL_QUESTIONS_EXTENSION_NAME,
      factory: (pi: ExtensionAPI): void => {
        pi.events.on(PERMISSIONS_UI_PROMPT_CHANNEL, prompted)
        pi.events.on(PERMISSIONS_DECISION_CHANNEL, decided)
      },
    },
    selectTitle: (title: string): string => {
      if (lead === undefined) return title
      const shown = `${lead}\n${title}`
      lead = undefined
      return shown
    },
  }
}
