import type { EnsoGuardRule, EnsoToolRefusal, EnsoToolRefuser } from '@enso/core'
import { ShieldXIcon } from 'lucide-react'
import { useContext } from 'react'
import { constantStore, ThreadStoresContext, useStore } from './store.ts'

/**
 * A refusal as the design draws it (`Enso-Design-Direction` `.guard`, #407 item 1): the tool,
 * the verdict in the refusal colour, what was asked, why it was refused, and who refused it. A
 * refusal is a receipt, not a failure — pi hands it over shaped exactly like a failed command
 * (#387), and the step row it replaces drew both with the same coral border and the word `error`.
 *
 * Who refused (#523) is the thread's `refusals` store: Enso's guard with its rule, the user's
 * permission rule, `auto`'s classifier, or the person — the engine's refusals used to render as
 * failures because only the guard's entry was read.
 */

/** The verdict after "Refused ·" for a guard's rule — what the rule guards, in the reader's words. One per rule: a new rule fails the build here. */
const GUARD_RULE_VERDICT: Readonly<Record<EnsoGuardRule, string>> = {
  'policy-mismatch': 'policy names a missing tool',
  'cc-safety-net': 'unsafe shell command',
  'network-egress': 'network egress',
  'environment-dump': 'environment dump',
  'secret-path': 'credential path',
  'write-confinement': 'outside the workspace',
  'protected-internals': 'protected internals',
  'persistence-write': 'persistence path',
  'secret-write': 'credential write',
  'stale-write': 'changed since read',
  'read-before-write': 'not read before write',
  'secret-read': 'credential read',
  'incident-suspension': 'suspended by an incident',
  'protected-records': 'protected records',
}

/** Who refused, as the card's `by` row says it — the reader's own rule and the reader's own No are theirs. */
const REFUSER_NAME: Readonly<Record<EnsoToolRefuser, string>> = {
  guard: 'Enso guard',
  rule: 'your rule',
  auto: "auto's classifier",
  operator: 'you',
}

/** The verdict after "Refused ·": the guard's rule in the reader's words, else who said no. */
function verdictOf(refusal: EnsoToolRefusal): string {
  if (refusal.by === 'guard') return GUARD_RULE_VERDICT[refusal.rule]
  return refusal.by === 'operator' ? 'you said no' : `denied by ${REFUSER_NAME[refusal.by]}`
}

/** What a row outside a thread pane reads: nothing refused. */
const NO_REFUSALS = constantStore<ReadonlyMap<string, EnsoToolRefusal>>(new Map())

/**
 * Who refused this call, or undefined. Read from the thread's `refusals` store — seeded from the
 * history, fed live — so a row outside a thread pane (a test's static render) knows of no
 * refusal rather than throwing.
 */
export function useToolRefusal(toolCallId: string): EnsoToolRefusal | undefined {
  const stores = useContext(ThreadStoresContext)
  return useStore(stores?.refusals ?? NO_REFUSALS).get(toolCallId)
}

export interface ToolRefusalProps {
  readonly toolCallId: string
  readonly toolName: string
  /** The call's input in one line — the command, the path, the URL; undefined when it names none. */
  readonly asked: string | undefined
  /** `asked` is a shell command: Ledger prints it after a `$ `, as a terminal would (#407). */
  readonly asCommand: boolean
  /** The refuser's reason, as the tool result carries it; undefined until the result lands. */
  readonly reason: string | undefined
  readonly refusal: EnsoToolRefusal
}

export function ToolRefusal({
  toolCallId,
  toolName,
  asked,
  asCommand,
  reason,
  refusal,
}: ToolRefusalProps): React.ReactNode {
  const by = REFUSER_NAME[refusal.by]
  return (
    // `data-tool-call-id`: where the stats drawer's rows land (#359), as on a step row.
    <article
      aria-label={`${toolName}, refused by ${by}`}
      data-enso-tool-call="refused"
      data-tool-call-id={toolCallId}
      className="my-1 max-w-3xl overflow-hidden rounded-md border border-refuse bg-card ledger:rounded-xs"
    >
      <header className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2">
        <span className="font-mono text-sm">{toolName}</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wider text-refuse uppercase">
          <ShieldXIcon aria-hidden="true" className="size-4 shrink-0" />
          Refused · {verdictOf(refusal)}
        </span>
      </header>
      {asked === undefined ? null : (
        <pre className="border-t bg-background px-3 py-2 font-mono text-sm break-words whitespace-pre-wrap">
          {asCommand ? (
            <span aria-hidden="true" className="hidden text-muted-foreground ledger:inline">
              ${' '}
            </span>
          ) : null}
          {asked}
        </pre>
      )}
      {reason === undefined ? null : (
        <p className="px-3 pt-3 pb-2 leading-relaxed break-words ink:font-heading ink:text-lg">{reason}</p>
      )}
      <dl className="grid grid-cols-label-value gap-x-3 gap-y-0.5 border-t px-3 pt-2 pb-3 font-mono text-xs text-muted-foreground ledger:border-dashed">
        <dt>by</dt>
        <dd className="text-foreground">{by}</dd>
        {refusal.by === 'guard' ? (
          <>
            <dt>rule</dt>
            <dd className="text-foreground">{refusal.rule}</dd>
          </>
        ) : null}
      </dl>
    </article>
  )
}
