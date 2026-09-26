import type { EnsoGuardRule } from '@enso/core'
import { ShieldXIcon } from 'lucide-react'
import { useContext } from 'react'
import { type Store, ThreadStoresContext, useStore } from './store.ts'

/**
 * A guard refusal as the design draws it (`Enso-Design-Direction` `.guard`, #407 item 1): the tool,
 * the verdict in the refusal colour, what was asked, why it was refused, and who refused it. A
 * refusal is a receipt, not a failure — pi hands it over shaped exactly like a failed command
 * (#387), and the step row it replaces drew both with the same coral border and the word `error`.
 */

/** The verdict after "Refused ·" — what the rule guards, in the reader's words. One per rule: a new rule fails the build here. */
const GUARD_RULE_VERDICT: Readonly<Record<EnsoGuardRule, string>> = {
  'policy-mismatch': 'policy names a missing tool',
  'cc-safety-net': 'safety analyzer',
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
}

/** What a row outside a thread pane reads: nothing refused, and nothing can ever be — it has no setter. */
const NO_DENIALS: Store<ReadonlyMap<string, EnsoGuardRule>> = {
  get: () => EMPTY_DENIALS,
  subscribe: () => () => undefined,
}
const EMPTY_DENIALS: ReadonlyMap<string, EnsoGuardRule> = new Map()

/**
 * The rule that refused this call, or undefined. Read from the thread's `guardDenials` store —
 * seeded from the history, fed live — so a row outside a thread pane (a test's static render)
 * knows of no refusal rather than throwing.
 */
export function useGuardDenial(toolCallId: string): EnsoGuardRule | undefined {
  const stores = useContext(ThreadStoresContext)
  return useStore(stores?.guardDenials ?? NO_DENIALS).get(toolCallId)
}

export interface GuardRefusalProps {
  readonly toolCallId: string
  readonly toolName: string
  /** The call's input in one line — the command, the path, the URL; undefined when it names none. */
  readonly asked: string | undefined
  /** The guard's reason, as the tool result carries it; undefined until the result lands. */
  readonly reason: string | undefined
  readonly rule: EnsoGuardRule
}

export function GuardRefusal({ toolCallId, toolName, asked, reason, rule }: GuardRefusalProps): React.ReactNode {
  return (
    // `data-tool-call-id`: where the stats drawer's rows land (#359), as on a step row.
    <article
      aria-label={`${toolName}, refused by Enso guard`}
      data-enso-tool-call="refused"
      data-tool-call-id={toolCallId}
      className="my-1 max-w-3xl overflow-hidden rounded-md border border-refuse bg-card ledger:rounded-xs"
    >
      <header className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2">
        <span className="font-mono text-sm">{toolName}</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wider text-refuse uppercase">
          <ShieldXIcon aria-hidden="true" className="size-4 shrink-0" />
          Refused · {GUARD_RULE_VERDICT[rule]}
        </span>
      </header>
      {asked === undefined ? null : (
        <pre className="border-t bg-background px-3 py-2 font-mono text-sm break-words whitespace-pre-wrap">
          {asked}
        </pre>
      )}
      {reason === undefined ? null : (
        <p className="px-3 pt-3 pb-2 leading-relaxed break-words ink:font-heading ink:text-lg">{reason}</p>
      )}
      <dl className="grid grid-cols-label-value gap-x-3 gap-y-0.5 border-t px-3 pt-2 pb-3 font-mono text-xs text-muted-foreground ledger:border-dashed">
        <dt>by</dt>
        <dd className="text-foreground">Enso guard</dd>
        <dt>rule</dt>
        <dd className="text-foreground">{rule}</dd>
      </dl>
    </article>
  )
}
