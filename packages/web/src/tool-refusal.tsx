import type { EnsoGuardRule, EnsoToolRefusal, EnsoToolRefuser } from '@enso/core'
import { ShieldXIcon } from 'lucide-react'
import { useContext } from 'react'
import { cn } from './lib/utils.ts'
import { PILL } from './step-pill.ts'
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

/** Who refused, as the card's `by` row says it — the reader's own rule and the reader's own No are theirs. The Stats view counts by it too (#928). */
export const REFUSER_NAME: Readonly<Record<EnsoToolRefuser, string>> = {
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
  // In the transcript's step language (#417): a step row's 40px header with the verdict as a pill
  // in the refusal colour, then what was asked in a command block, the reason, and who said no.
  return (
    // `data-tool-call-id`: where the stats drawer's rows land (#359), as on a step row.
    <article
      aria-label={`${toolName}, refused by ${by}`}
      data-enso-tool-call="refused"
      data-tool-call-id={toolCallId}
      className="overflow-hidden rounded-sm border border-refuse bg-card ledger:rounded-xs [[data-tool-call-id]+&]:-mt-1"
    >
      <header className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2 text-detail">
        <span className="font-mono font-semibold">{toolName}</span>
        <span className={cn(PILL, 'ml-auto text-refuse')}>
          <ShieldXIcon aria-hidden="true" className="size-2.5 shrink-0" />
          Refused · {verdictOf(refusal)}
        </span>
      </header>
      <div className="grid gap-3 border-t p-3">
        {asked === undefined ? null : (
          <pre className="rounded-sm border bg-background p-3 font-mono text-xs break-words whitespace-pre-wrap">
            {asCommand ? (
              <span aria-hidden="true" className="hidden text-muted-foreground ledger:inline">
                ${' '}
              </span>
            ) : null}
            {asked}
          </pre>
        )}
        {reason === undefined ? null : (
          <p className="text-sm leading-relaxed break-words ink:font-heading ink:text-lg">{reason}</p>
        )}
        <dl className="grid grid-cols-label-value gap-x-3 gap-y-1 text-detail ledger:border-t ledger:border-dashed ledger:pt-2">
          <dt className="text-muted-foreground">by</dt>
          <dd className="font-mono text-xs">{by}</dd>
          {refusal.by === 'guard' ? (
            <>
              <dt className="text-muted-foreground">rule</dt>
              <dd className="font-mono text-xs">{refusal.rule}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </article>
  )
}
