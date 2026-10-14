import {
  ENSO_CATCH_ALL,
  ENSO_DRAFTED_RULE_GROUPS,
  ENSO_MODE_PRESETS,
  ENSO_PERMISSION_MODES,
  type EnsoDraftedRuleGroup,
  type EnsoGuardCheck,
  type EnsoPermissionAction,
  type EnsoPermissionMap,
  type EnsoPermissionModeName,
  type EnsoPermissionPolicyRead,
  type EnsoPermissionPolicyRefusal,
  type EnsoPolicyRow,
  decisionAction,
  effectiveRows,
  hasRule,
  permissionOf,
  policyKnobs,
  policyRows,
  withoutRule,
  withRule,
  withRuleMoved,
} from '@enso/core'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { FieldError } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { OptionSelect } from './option-select.tsx'
import { PAGE_BUTTON, PAGE_INPUT, PAGE_OUTLINE_BUTTON, SAVE_BAR, SUB_TITLE } from './page-styles.ts'
import { BehaviourPart, YOLO_ROW_ID } from './permissions-behaviour.tsx'
import {
  checkPermission,
  fetchPermissionPolicy,
  type PermissionCheck,
  type PolicyRead,
  type PolicyResetOutcome,
  type PolicySave,
  resetPermissionPolicy,
  savePermissionPolicy,
} from './permissions-connection.ts'
import {
  newRuleRefusal,
  type PolicyChange,
  policyDiff,
  rowsBySurface,
  checkSurfaces,
  surfaceChoices,
  withAction,
  withGroup,
  type SettingEdits,
  withPatternRenamed,
  withSettings,
} from './permissions-draft.ts'

/**
 * Settings' Permissions section (#474): the rules pi runs under, from `ENSO_HOME/permissions.json`
 * in the engine's own format — shown in the engine's order, per mode, edited on a draft and saved
 * whole under the ETag read, reset to Enso's with the diff shown first, and checked against the
 * open thread's live engine. Only the user's file: project policy is #502's, not this section's.
 *
 * ⚠ THE PAGE NEVER GUESSES A VERDICT. What a mode does to the rules is `effectiveRows` (pinned to
 * the engine by `agent-host.test.ts`); what a given command gets is only ever the open thread's
 * answer (built on ask): its guards' first, which refuse in every mode (#881), then its engine's.
 * When its engine has not loaded, the section says so rather than match patterns itself.
 */

/** Each decision and its word, as the prototype names it: the segments' and the new rule's choice. */
const ACTIONS: ReadonlyArray<readonly [EnsoPermissionAction, string]> = [
  ['allow', 'Allow'],
  ['ask', 'Ask'],
  ['deny', 'Deny'],
]

/** Each decision in its own colour, as the prototype's `.decision-text` (#417): allow ok, ask human, deny refuse. */
const DECISION_TEXT: Readonly<Record<EnsoPermissionAction, string>> = {
  allow: 'text-ok',
  ask: 'text-human',
  deny: 'text-refuse',
}

/** A page's quiet line under a title: the prototype's `.page-note`. */
const PAGE_NOTE = 'text-sm text-muted-foreground'

/** A rule list's header row, as the prototype's `.data-table th`. */
const TABLE_HEAD = 'font-mono text-meta font-semibold tracking-wider text-muted-foreground uppercase'

type PolicyState = { readonly kind: 'loading' } | PolicyRead

/** permissions.json as read: the engine's whole file, whose `permission` is the part this page edits. */
type PolicyFile = Extract<EnsoPermissionPolicyRead, { kind: 'ok' }>['file']

/** Why the last save or reset did not land; the draft is untouched by every one of them. */
export type PolicyProblem =
  | { readonly kind: 'conflict'; readonly detail: string; readonly during: 'save' | 'reset' }
  | { readonly kind: 'refused'; readonly refusal: EnsoPermissionPolicyRefusal }
  | { readonly kind: 'unavailable'; readonly detail: string }

export interface PolicyEditor {
  readonly state: PolicyState
  /** The edited `permission` block; `undefined` while no rule is edited. */
  readonly draft: EnsoPermissionMap | undefined
  /** The Behaviour part's edits to the keys beside `permission` (#935); `undefined` while none is edited. */
  readonly settings: SettingEdits | undefined
  /** Anything unsaved: a rule or a setting. Both go in the one save, under the one ETag. */
  readonly dirty: boolean
  readonly working: boolean
  readonly problem: PolicyProblem | undefined
  /** Where a reset kept the file it replaced. */
  readonly backup: string | undefined
  readonly edit: (change: (permission: EnsoPermissionMap) => EnsoPermissionMap) => void
  /** Set a key beside the rules; `undefined` takes it off the file, the engine's default in force. */
  readonly setSetting: (key: string, value: unknown) => void
  readonly discard: () => void
  readonly save: (overwrite: boolean) => void
  readonly reload: () => void
  readonly reset: () => void
}

/**
 * The policy as read and the draft over it, read each time Settings opens.
 *
 * ⚠ HELD BENEATH SETTINGS, NOT BY THE SECTION: leaving Settings or switching section keeps an unsaved
 * draft (`routed-page.tsx` holds it). An open with a draft pending does not re-read — the draft was
 * made on the version read, and a newer read would let its save overwrite a change it never saw;
 * the save's 412 says so instead.
 */
export function usePermissionPolicy(open: boolean, fetchImpl: FetchLike | undefined): PolicyEditor {
  const [state, setState] = useState<PolicyState>({ kind: 'loading' })
  const [draft, setDraft] = useState<EnsoPermissionMap | undefined>(undefined)
  const [settings, setSettings] = useState<SettingEdits | undefined>(undefined)
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<PolicyProblem | undefined>(undefined)
  const [backup, setBackup] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  // Refs beside the state: a save's answer compares against the draft as it is THEN, and a
  // double-click on Save must not send twice.
  const draftNow = useRef<EnsoPermissionMap | undefined>(undefined)
  const settingsNow = useRef<SettingEdits | undefined>(undefined)
  const inFlight = useRef(false)
  const changeDraft = useCallback((next: EnsoPermissionMap | undefined): void => {
    draftNow.current = next
    setDraft(next)
  }, [])
  const changeSettings = useCallback((next: SettingEdits | undefined): void => {
    settingsNow.current = next
    setSettings(next)
  }, [])

  useEffect(() => {
    if (!open || draftNow.current !== undefined || settingsNow.current !== undefined) return
    let current = true
    void fetchPermissionPolicy(fetchImpl).then((read) => {
      if (current) setState(read)
    })
    return (): void => {
      current = false
    }
  }, [open, fetchImpl, generation])

  const loaded = state.kind === 'loaded' ? state.policy : undefined

  const edit = (change: (permission: EnsoPermissionMap) => EnsoPermissionMap): void => {
    if (loaded?.kind !== 'ok') return
    // A reset's notice describes the file as the reset left it; an edit moves on from it (#519).
    setBackup(undefined)
    changeDraft(change(draftNow.current ?? permissionOf(loaded.file)))
  }

  const setSetting = (key: string, value: unknown): void => {
    if (loaded?.kind !== 'ok') return
    setBackup(undefined)
    changeSettings({ ...settingsNow.current, [key]: value })
  }

  /**
   * What a save writes over, and under which version (#519). A plain save: the file as read, under its
   * ETag. An overwrite after a 412: the file as it is on disk NOW, re-read, under ITS ETag, so only the
   * draft's rules and the settings edited here replace anything, and a setting edited by hand in the
   * meantime (`permissionReviewLog: false`) stays. It used to send the file as first read with
   * `If-Match: *`, reverting such a setting silently. A file that cannot be read now is overwritten as before.
   */
  const saveBase = async (
    file: PolicyFile,
    etag: string,
    overwrite: boolean,
  ): Promise<{ file: PolicyFile; etag: string }> => {
    if (!overwrite) return { file, etag }
    const now = await fetchPermissionPolicy(fetchImpl)
    return now.kind === 'loaded' && now.policy.kind === 'ok'
      ? { file: now.policy.file, etag: now.policy.etag }
      : { file, etag: '*' }
  }

  const save = async (overwrite: boolean): Promise<void> => {
    const sent = draftNow.current
    const sentSettings = settingsNow.current
    if (loaded?.kind !== 'ok' || (sent === undefined && sentSettings === undefined) || inFlight.current) return
    inFlight.current = true
    setWorking(true)
    let outcome: PolicySave
    try {
      const base = await saveBase(loaded.file, loaded.etag, overwrite)
      // One file, one save (#935): the settings edited, then the rules — the file's own where none is edited.
      const file = withSettings(base.file, sentSettings ?? {})
      const write = { file: sent === undefined ? file : { ...file, permission: sent } }
      outcome = await savePermissionPolicy(write, base.etag, fetchImpl)
    } finally {
      inFlight.current = false
      setWorking(false)
    }
    if (outcome.kind !== 'saved') {
      setProblem(outcome.kind === 'conflict' ? { ...outcome, during: 'save' } : outcome)
      return
    }
    setState({ kind: 'loaded', policy: outcome.policy })
    setProblem(undefined)
    // Edits made while the save was in flight are still unsaved: they stay the draft.
    if (draftNow.current === sent) changeDraft(undefined)
    if (settingsNow.current === sentSettings) changeSettings(undefined)
  }

  const reset = async (): Promise<void> => {
    if (loaded === undefined || inFlight.current) return
    inFlight.current = true
    setWorking(true)
    let outcome: PolicyResetOutcome
    try {
      outcome = await resetPermissionPolicy(loaded.etag, fetchImpl)
    } finally {
      inFlight.current = false
      setWorking(false)
    }
    if (outcome.kind !== 'reset') {
      setProblem(outcome.kind === 'conflict' ? { ...outcome, during: 'reset' } : outcome)
      return
    }
    setState({ kind: 'loaded', policy: outcome.reset.policy })
    setBackup(outcome.reset.backup)
    setProblem(undefined)
    changeDraft(undefined)
    changeSettings(undefined)
  }

  return {
    state,
    draft,
    settings,
    dirty: draft !== undefined || settings !== undefined,
    working,
    problem,
    backup,
    edit,
    setSetting,
    discard: (): void => {
      changeDraft(undefined)
      changeSettings(undefined)
      setProblem(undefined)
    },
    save: (overwrite: boolean): void => void save(overwrite),
    reload: (): void => {
      changeDraft(undefined)
      changeSettings(undefined)
      setProblem(undefined)
      setState({ kind: 'loading' })
      setGeneration((count) => count + 1)
    },
    reset: (): void => void reset(),
  }
}

/** A row's tag after its pattern, the prototype's `.badge-tag`: whose it is, when not simply yours. */
function OwnerTag({ row, mode }: { row: EnsoPolicyRow; mode: EnsoPermissionModeName | undefined }): React.ReactNode {
  if (row.owner === 'catch-all') return <RuleTag title="Enso's catch-all — a mode may change this">catch-all</RuleTag>
  if (row.owner === 'mode') return <RuleTag>from {mode ?? 'the mode'}</RuleTag>
  return null
}

/** A small mono pill beside a pattern. `data-rule-tag` is what the tests read a row's owner by. */
function RuleTag({ title, children }: { title?: string; children: React.ReactNode }): React.ReactNode {
  return (
    <span
      data-rule-tag=""
      title={title}
      className="inline-flex items-center rounded-full border border-border-strong px-2 font-mono text-tag whitespace-nowrap text-muted-foreground"
    >
      {children}
    </span>
  )
}

/**
 * A row's pattern, editable in place: the rename lands on blur or Enter, or says why it cannot. It
 * reads as the table's mono text (#417) — no box until it is hovered or focused — and sizes to what
 * it holds, so the row's tag sits right after it.
 */
function PatternField({
  row,
  onRename,
  children,
}: {
  row: EnsoPolicyRow
  onRename: (to: string) => string | undefined
  children: React.ReactNode
}): React.ReactNode {
  // Only in-progress typing lives in state; an untouched field shows the row's own pattern.
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const text = typed ?? row.pattern
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const commit = (): void => {
    const to = text.trim()
    if (to === row.pattern) return
    setRefusal(onRename(to))
  }
  return (
    <>
      <Input
        aria-label={`pattern ${row.surface} ${row.pattern}`}
        aria-invalid={refusal !== undefined}
        className="field-sizing-content h-8 max-w-full min-w-16 rounded-sm border-transparent bg-transparent px-1.5 font-mono text-sm shadow-none hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 aria-invalid:border-refuse md:text-sm dark:bg-transparent"
        value={text}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') commit()
        }}
      />
      {children}
      {refusal === undefined ? null : <FieldError className="basis-full">{refusal}</FieldError>}
    </>
  )
}

interface RowEdits {
  readonly onAction: (action: EnsoPermissionAction) => void
  readonly onRename: (to: string) => string | undefined
  readonly onMove: (direction: -1 | 1) => void
  readonly onRemove: () => void
  readonly canMoveUp: boolean
  readonly canMoveDown: boolean
}

/** Each decision's segment, tinted when picked as the prototype's `.decision-group` (#417). */
const DECISION_SEGMENT: Readonly<Record<EnsoPermissionAction, string>> = {
  allow: 'data-[state=checked]:bg-ok/15 data-[state=checked]:text-ok',
  ask: 'data-[state=checked]:bg-human/15 data-[state=checked]:text-human',
  deny: 'data-[state=checked]:bg-refuse/15 data-[state=checked]:text-refuse',
}

/** A rule's decision as the prototype's segmented Allow | Ask | Deny: one radiogroup, named as the rule's action. */
function DecisionSegments({
  label,
  value,
  onChange,
}: {
  label: string
  value: EnsoPermissionAction
  onChange: (action: EnsoPermissionAction) => void
}): React.ReactNode {
  return (
    <RadioGroupPrimitive.Root
      aria-label={label}
      orientation="horizontal"
      value={value}
      onValueChange={(picked: string) => {
        const action = ACTIONS.find(([known]) => known === picked)?.[0]
        if (action !== undefined) onChange(action)
      }}
      className="inline-flex overflow-hidden rounded-sm border border-border-strong"
    >
      {ACTIONS.map(([action, word]) => (
        <RadioGroupPrimitive.Item
          key={action}
          value={action}
          className={`min-h-8 border-border-strong px-3 text-xs font-semibold text-muted-foreground transition-colors outline-none not-first:border-l hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${DECISION_SEGMENT[action]}`}
        >
          {word}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}

/** A table cell, as the prototype's `.data-table td`: hairlines between the rows. */
const BODY_CELL = 'border-t px-3 py-2 align-middle'

/** What an icon button in a row looks like: 32px, quiet until hovered. */
const ROW_ICON_BUTTON = 'size-8 rounded-sm text-muted-foreground hover:text-foreground'

/** The order cell's content: Enso's `**` is always first; a rule of yours moves up and down; a preview moves nothing. */
function OrderControls({ row, edits }: { row: EnsoPolicyRow; edits: RowEdits | undefined }): React.ReactNode {
  if (edits === undefined) return null
  if (row.pattern === ENSO_CATCH_ALL) {
    return <span className="text-xs whitespace-nowrap text-muted-foreground">always first</span>
  }
  const name = `${row.surface} ${row.pattern}`
  return (
    <span className="inline-flex gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className={ROW_ICON_BUTTON}
        aria-label={`move ${name} up`}
        disabled={!edits.canMoveUp}
        onClick={() => edits.onMove(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={ROW_ICON_BUTTON}
        aria-label={`move ${name} down`}
        disabled={!edits.canMoveDown}
        onClick={() => edits.onMove(1)}
      >
        <ChevronDownIcon />
      </Button>
    </span>
  )
}

/** The pattern cell: the pattern (editable unless it is Enso's `**`), its tag, and what an allow on it lets through. */
function PatternCell({
  row,
  mode,
  edits,
}: {
  row: EnsoPolicyRow
  mode: EnsoPermissionModeName | undefined
  edits: RowEdits | undefined
}): React.ReactNode {
  const reason = typeof row.decision === 'object' ? row.decision.reason : undefined
  const tag = <OwnerTag row={row} mode={mode} />
  return (
    <td className={`${BODY_CELL} min-w-48`}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {edits !== undefined && row.pattern !== ENSO_CATCH_ALL ? (
          <PatternField row={row} onRename={edits.onRename}>
            {tag}
          </PatternField>
        ) : (
          <>
            <code className="px-1.5 font-mono text-sm break-all">{row.pattern}</code>
            {tag}
          </>
        )}
      </span>
      {reason === undefined ? null : <span className="block px-1.5 text-xs">told the agent: {reason}</span>}
      {row.runsCode === undefined ? null : (
        <span className="flex items-center gap-1 px-1.5 text-xs text-refuse">
          <TriangleAlertIcon className="size-3" aria-hidden="true" /> runs code unasked: {row.runsCode}
        </span>
      )}
    </td>
  )
}

/**
 * One rule as a row of the prototype's table (#417): its number, its surface, its pattern and tag,
 * its decision, its order, and its remove. ⚠ Enso's `**` takes a decision change only: a mode needs
 * it where it is (#499).
 */
function RuleRow({
  row,
  number,
  mode,
  edits,
}: {
  row: EnsoPolicyRow
  number: number
  mode: EnsoPermissionModeName | undefined
  edits: RowEdits | undefined
}): React.ReactNode {
  const name = `${row.surface} ${row.pattern}`
  const action = decisionAction(row.decision)
  const removable = edits !== undefined && row.pattern !== ENSO_CATCH_ALL
  return (
    <tr aria-label={name} className={row.owner === 'mode' ? 'text-muted-foreground' : undefined}>
      <td className={`${BODY_CELL} text-right font-mono text-xs text-muted-foreground tabular-nums`}>{number}</td>
      <td className={`${BODY_CELL} whitespace-nowrap`}>{row.surface}</td>
      <PatternCell row={row} mode={mode} edits={edits} />
      <td className={BODY_CELL}>
        {edits === undefined ? (
          // Where it cannot change: the word in its colour, the prototype's `.decision-text`.
          <span data-decision={action} className={`font-mono text-xs font-semibold ${DECISION_TEXT[action]}`}>
            {action}
          </span>
        ) : (
          <DecisionSegments label={`action ${name}`} value={action} onChange={edits.onAction} />
        )}
      </td>
      <td className={BODY_CELL}>
        <OrderControls row={row} edits={edits} />
      </td>
      <td className={`${BODY_CELL} text-right`}>
        {removable ? (
          <Button
            variant="ghost"
            size="icon"
            className={ROW_ICON_BUTTON}
            aria-label={`remove ${name}`}
            onClick={edits.onRemove}
          >
            <XIcon />
          </Button>
        ) : null}
      </td>
    </tr>
  )
}

/** The edits a written row can make on the draft; the surface's rows decide where it may move. */
function rowEdits(
  row: EnsoPolicyRow,
  siblings: readonly EnsoPolicyRow[],
  position: number,
  editing: RuleEditing,
): RowEdits {
  const { surface, pattern } = row
  const { permission, onEdit } = editing
  const previous = siblings[position - 1]
  return {
    onAction: (action) => onEdit((current) => withAction(current, surface, pattern, action)),
    onRename: (to) => {
      const renamed = withPatternRenamed(permission, surface, pattern, to)
      if ('refusal' in renamed) return renamed.refusal
      onEdit(() => renamed.permission)
      return undefined
    },
    onMove: (direction) => onEdit((current) => withRuleMoved(current, surface, pattern, direction)),
    onRemove: () => onEdit((current) => withoutRule(current, surface, pattern)),
    canMoveUp: previous !== undefined && previous.pattern !== ENSO_CATCH_ALL,
    canMoveDown: position < siblings.length - 1,
  }
}

/** The draft the rows edit, as shown, and how to change it. */
interface RuleEditing {
  readonly permission: EnsoPermissionMap
  readonly onEdit: PolicyEditor['edit']
}

/** A column head of the rule table, as the prototype's `.data-table th`. */
const HEAD_CELL = `px-3 py-2 text-left whitespace-nowrap ${TABLE_HEAD}`

/**
 * The rules in the engine's order, one table (#417): a row per rule, numbered down the table, each
 * surface's rows together in a group of their own. Editable when `editing` is given.
 */
function RuleList({
  rows,
  mode,
  editing,
}: {
  rows: readonly EnsoPolicyRow[]
  mode: EnsoPermissionModeName | undefined
  editing: RuleEditing | undefined
}): React.ReactNode {
  const groups = rowsBySurface(rows)
  const firsts = groups.map((_, index) => groups.slice(0, index).reduce((count, group) => count + group.rows.length, 1))
  return (
    <div className="overflow-x-auto rounded-sm border bg-card">
      <table aria-labelledby="permissions-rules-label" className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={`${HEAD_CELL} w-10 text-right`}>
              #
            </th>
            <th scope="col" className={HEAD_CELL}>
              Tool
            </th>
            <th scope="col" className={HEAD_CELL}>
              Pattern
            </th>
            <th scope="col" className={HEAD_CELL}>
              Decision
            </th>
            <th scope="col" className={HEAD_CELL}>
              Order
            </th>
            <th scope="col" className={HEAD_CELL}>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        {groups.map((group, index) => (
          <tbody key={group.surface} aria-label={`surface ${group.surface}`}>
            {group.rows.map((row, position) => (
              <RuleRow
                key={row.pattern}
                row={row}
                number={(firsts[index] ?? 1) + position}
                mode={mode}
                edits={editing === undefined ? undefined : rowEdits(row, group.rows, position, editing)}
              />
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

/** A surface the mode writes as one action, which replaces every rule you wrote on it (`plan`'s `edit`). */
function ReplacedSurfaces({
  permission,
  mode,
}: {
  permission: EnsoPermissionMap
  mode: EnsoPermissionModeName
}): React.ReactNode {
  const replaced = Object.entries(ENSO_MODE_PRESETS[mode].permission).flatMap(([surface, value]) =>
    typeof value === 'string' && permission[surface] !== undefined ? [`${surface} → ${value}`] : [],
  )
  if (replaced.length === 0) return null
  return (
    <p className={PAGE_NOTE}>
      In {mode}, the mode replaces these surfaces whole — your rules on them do not apply: {replaced.join(', ')}
    </p>
  )
}

/**
 * Under the lede, in one quiet line: where every decision is logged, and when a saved change is in
 * force. ⚠ A running thread reads the knobs when a prompt starts (the engine's `before_agent_start`
 * refresh), but the rules at every call: a saved `yoloMode` is in force from the thread's NEXT
 * prompt, and "Try a command" answers before it as the engine does. Found in #474's browser smoke.
 *
 * ⚠ While yoloMode is on, a callout comes first: every Ask in the table below is silently an Allow,
 * and its Behaviour row sits at the foot of a long section, where nobody reading the rules sees it.
 */
function HeadFacts({
  file,
  reviewLogDirectory,
}: {
  file: Record<string, unknown>
  reviewLogDirectory: string
}): React.ReactNode {
  const knobs = policyKnobs(file)
  const showYolo = (): void => {
    const row = document.getElementById(YOLO_ROW_ID)
    row?.scrollIntoView({ block: 'center' })
    row?.focus()
  }
  return (
    <>
      {knobs.yoloMode ? (
        <p
          aria-label="yolo mode is on"
          className="flex max-w-reading flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border border-refuse px-3 py-2 text-sm text-refuse"
        >
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="font-semibold">Yolo mode is on: every Ask below is an Allow.</span>
          <button type="button" className="underline underline-offset-3" onClick={showYolo}>
            See Behaviour
          </button>
        </p>
      ) : null}
      <p className="max-w-reading text-xs text-muted-foreground">
        {knobs.reviewLog ? (
          <>
            Every decision is logged, in <code className="font-mono">{reviewLogDirectory}</code>.{' '}
          </>
        ) : null}
        A saved rule is in force at a running thread's next call; the settings beside the rules, at its next prompt.
      </p>
    </>
  )
}

/** A new rule: last on its surface, after `**`, so it is yours and holds in every mode. */
function AddRule({
  permission,
  onEdit,
}: {
  permission: EnsoPermissionMap
  onEdit: PolicyEditor['edit']
}): React.ReactNode {
  const surfaces = surfaceChoices(permission)
  const [surface, setSurface] = useState(surfaces[0] ?? 'bash')
  const [pattern, setPattern] = useState('')
  const [action, setAction] = useState<EnsoPermissionAction>('ask')
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const add = (): void => {
    const typed = pattern.trim()
    const refused = newRuleRefusal(permission, surface, typed)
    setRefusal(refused)
    if (refused !== undefined) return
    onEdit((current) => withRule(current, surface, typed, action))
    setPattern('')
  }
  return (
    <fieldset aria-label="add a rule" className="grid gap-2">
      <span className="grid items-start gap-2 md:grid-cols-add-rule">
        <OptionSelect
          label="new rule surface"
          value={surface}
          options={surfaces.map((choice) => [choice, choice] as const)}
          onChange={setSurface}
          className={PAGE_INPUT}
        />
        <Input
          aria-label="new rule pattern"
          className={`${PAGE_INPUT} font-mono`}
          placeholder="git push *"
          value={pattern}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPattern(event.target.value)}
        />
        <OptionSelect
          label="new rule action"
          value={action}
          options={ACTIONS}
          onChange={setAction}
          className={PAGE_INPUT}
        />
        <Button variant="outline" className={PAGE_OUTLINE_BUTTON} onClick={add}>
          <PlusIcon aria-hidden="true" />
          Add rule
        </Button>
      </span>
      {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
      <p className={PAGE_NOTE}>
        Patterns: <code>*</code> matches anything, <code>/</code> included; a trailing <code> *</code> also matches the
        bare command (<code>git *</code> matches <code>git</code>). Last match wins on a surface.
      </p>
    </fieldset>
  )
}

/** Why a group's switch, once on, does not turn off. */
const GROUP_ON_WORDS =
  "On: its rules are in your table. Remove them there — Enso can't tell a group's rule from your own identical one."

/**
 * A rule group's switch, the prototype's `.switch` (#417). Off, turning it on adds the group's rules
 * not already in force; on, it stays on: a group's rules leave from the table, one by one.
 */
function GroupSwitch({
  on,
  labelledBy,
  onTurnOn,
}: {
  on: boolean
  labelledBy: string
  onTurnOn: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={on}
      title={on ? GROUP_ON_WORDS : undefined}
      onClick={onTurnOn}
      className="group relative mt-0.5 h-6 w-10 shrink-0 rounded-full bg-border-strong transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed aria-checked:bg-primary"
    >
      <span
        aria-hidden="true"
        className="absolute top-0.75 left-0.75 size-4.5 rounded-full bg-foreground transition-transform group-aria-checked:translate-x-4 group-aria-checked:bg-primary-foreground"
      />
    </button>
  )
}

/**
 * One rule group, the prototype's `.group-card` (#417): what it stops or allows, its rules as chips
 * (`bash · npm publish* · deny`, a tick on one already in force), and its switch.
 */
function RuleGroup({
  group,
  permission,
  onEdit,
}: {
  group: EnsoDraftedRuleGroup
  permission: EnsoPermissionMap
  onEdit: PolicyEditor['edit']
}): React.ReactNode {
  const present = group.rules.map((rule) => hasRule(permission, rule.surface, rule.pattern, rule.decision))
  const titleId = `rule-group-${group.id}`
  return (
    <section
      aria-label={`rule group ${group.title}`}
      className="flex items-start gap-3 rounded-sm border bg-card px-4 py-3"
    >
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span id={titleId} className="font-semibold">
          {group.title}
        </span>
        <p className={PAGE_NOTE}>{group.note}</p>
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {group.rules.map((rule, position) => (
            <li
              key={`${rule.surface} ${rule.pattern}`}
              title={present[position] === true ? 'already in force' : undefined}
              className="inline-flex items-center gap-1 rounded-sm border px-2 py-px font-mono text-meta whitespace-nowrap text-muted-foreground"
            >
              {rule.surface} · {rule.pattern} ·{' '}
              <span className={`font-semibold ${DECISION_TEXT[rule.decision]}`}>{rule.decision}</span>
              {present[position] === true ? (
                <>
                  <CheckIcon aria-hidden="true" className="size-3 text-ok" />
                  <span className="sr-only">already in force</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <GroupSwitch
        on={present.every(Boolean)}
        labelledBy={titleId}
        onTurnOn={() => onEdit((current) => withGroup(current, group))}
      />
    </section>
  )
}

function RuleGroups({
  permission,
  onEdit,
}: {
  permission: EnsoPermissionMap
  onEdit: PolicyEditor['edit']
}): React.ReactNode {
  return (
    <div className="grid gap-3">
      <h3 className={SUB_TITLE}>Rule groups</h3>
      <p className={PAGE_NOTE}>Ready-made rules Enso suggests. Turning a group on adds its rules to yours.</p>
      <div className="grid gap-2">
        {ENSO_DRAFTED_RULE_GROUPS.map((group) => (
          <RuleGroup key={group.id} group={group} permission={permission} onEdit={onEdit} />
        ))}
      </div>
      <p className={PAGE_NOTE}>
        Git safety — no <code>--no-verify</code>, no <code>push --delete</code> — is already in Enso's policy.
      </p>
    </div>
  )
}

/**
 * Save and Discard, and whether there is anything to save: the prototype's `.save-bar` (#417),
 * pinned to the bottom of what scrolls only while there is something unsaved.
 */
function SaveBar({ editor, path }: { editor: PolicyEditor; path: string }): React.ReactNode {
  const { dirty } = editor
  return (
    <div className={dirty ? SAVE_BAR : 'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3'}>
      <span className="min-w-50 flex-1 text-sm">
        <strong className="block">{dirty ? 'unsaved changes' : 'saved'}</strong>
        <span className="font-mono text-meta text-muted-foreground">Saves to {path}</span>
      </span>
      <Button
        variant="outline"
        className={PAGE_OUTLINE_BUTTON}
        disabled={!dirty || editor.working}
        onClick={editor.discard}
      >
        Discard
      </Button>
      <Button className={PAGE_BUTTON} disabled={!dirty || editor.working} onClick={() => editor.save(false)}>
        Save
      </Button>
    </div>
  )
}

/** Why the last save or reset did not land, and the way on. Nothing was written in any of them. */
function ProblemNotice({ editor }: { editor: PolicyEditor }): React.ReactNode {
  const { problem } = editor
  if (problem === undefined) return null
  if (problem.kind === 'unavailable') return <FieldError>Not saved: {problem.detail}</FieldError>
  if (problem.kind === 'refused') {
    return (
      <div
        role="alert"
        aria-label="refused"
        className="grid gap-2 rounded-sm border border-refuse bg-card p-4 text-sm text-refuse"
      >
        <p>Not saved — the engine's schema refused it: {problem.refusal.reason}</p>
        <ul className="list-disc pl-5 text-xs">
          {problem.refusal.problems.map((schemaProblem) => (
            <li key={`${schemaProblem.at} ${schemaProblem.message}`}>
              <code>{schemaProblem.at}</code>: {schemaProblem.message}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div
      role="alert"
      aria-label="changed on disk"
      className="grid gap-3 rounded-sm border border-chart-3 bg-card p-4 text-sm"
    >
      <p>
        permissions.json changed on disk since it was read ({problem.detail}). Nothing was written; your changes are
        still here. Overwrite with mine puts your changes over the file as it is on disk now, and keeps every setting
        you did not change as it is there.
      </p>
      <span className="flex flex-wrap gap-2">
        <Button variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={editor.working} onClick={editor.reload}>
          Reload from disk
        </Button>
        {problem.during === 'save' ? (
          <Button
            variant="destructive"
            className={PAGE_BUTTON}
            disabled={editor.working}
            onClick={() => editor.save(true)}
          >
            Overwrite with mine
          </Button>
        ) : null}
      </span>
    </div>
  )
}

const CHANGE_MARKS: Readonly<Record<PolicyChange['kind'], string>> = { added: '+', removed: '−', changed: '~' }

/** A reset's changes, per surface (and the file's other settings), each rule added, removed or changed. */
function ResetDiff({ changes }: { changes: readonly PolicyChange[] }): React.ReactNode {
  if (changes.length === 0) return <p className={PAGE_NOTE}>The file is already Enso's policy.</p>
  const sections = [...new Set(changes.map((change) => change.section))]
  return (
    <div
      aria-label="reset diff"
      className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-sm border bg-background px-3 py-2 text-xs"
    >
      {sections.map((section) => (
        <section key={section}>
          <h4 className={TABLE_HEAD}>{section}</h4>
          <ul>
            {changes
              .filter((change) => change.section === section)
              .map((change) => (
                <li key={change.subject} className="font-mono">
                  {CHANGE_MARKS[change.kind]} {change.subject}: {change.kind}{' '}
                  {change.kind === 'changed' ? `${change.before} → ${change.after}` : (change.after ?? change.before)}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Reset to Enso's policy: the diff first, then the reset on confirm; the file replaced is kept. */
function ResetPanel({ policy, editor }: { policy: EnsoPermissionPolicyRead; editor: PolicyEditor }): React.ReactNode {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <Button variant="outline" className={`${PAGE_OUTLINE_BUTTON} self-start`} onClick={() => setConfirming(true)}>
        Reset to Enso's policy…
      </Button>
    )
  }
  const changes = policyDiff(policy.kind === 'ok' ? policy.file : undefined, policy.ensoDefault)
  return (
    <div className="grid gap-3 rounded-sm border border-chart-3 bg-card p-4">
      <p className="text-sm">
        Resetting replaces permissions.json with Enso's policy; the current file is kept as a backup.
        {editor.dirty ? ' Your unsaved changes go too.' : ''}
      </p>
      <ResetDiff changes={changes} />
      <span className="flex flex-wrap gap-2">
        <Button
          variant="destructive"
          className={PAGE_BUTTON}
          disabled={editor.working}
          onClick={() => {
            setConfirming(false)
            editor.reset()
          }}
        >
          Reset
        </Button>
        <Button variant="ghost" className={PAGE_BUTTON} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    </div>
  )
}

const ORIGIN_WORDS: Readonly<Record<string, string>> = {
  global: 'your file',
  agent: "the mode's preset",
  project: "the project's policy",
  yolo: 'yoloMode approved this ask',
}

/**
 * What the guards said of the value (#881). They decide before the engine, in every mode: a refusal
 * is the answer, and the engine's verdict after it is moot; a check they were not asked says so.
 */
function GuardAnswer({ guard }: { guard: EnsoGuardCheck }): React.ReactNode {
  if (guard.kind === 'refused') {
    return (
      <div aria-label="guard" className="grid gap-1 rounded-sm border border-refuse/50 bg-card px-3 py-2">
        <p>
          <span className="font-semibold text-refuse">Refused by a guard: {guard.rule}</span> — {guard.cause}
        </p>
        <p>
          Asked as a <code>{guard.tool}</code> call; a guard refuses it in every mode.
        </p>
        <details aria-label="what pi is told" className="text-muted-foreground">
          <summary>What pi is told</summary>
          <p className="whitespace-pre-line">{guard.reason}</p>
        </details>
        <p>The engine's verdict below is moot: the guard refuses the call before the engine is asked.</p>
      </div>
    )
  }
  return (
    <p aria-label="guard">
      {guard.kind === 'passed' ? (
        <>
          No guard refuses it (asked as{' '}
          {guard.tools.map((tool, index) => (
            <span key={tool}>
              {index === 0 ? '' : ' and as '}a <code>{tool}</code> call
            </span>
          ))}
          ): the engine decides.
        </>
      ) : (
        `The guards were not asked: ${guard.reason}. The engine's verdict alone is below, and a guard may still refuse the call.`
      )}
    </p>
  )
}

/**
 * The thread's answer, layer by layer as a call meets them: the guards, then the engine — in the
 * prototype's `.check-result` box (#417), the engine's verdict in its decision's colour.
 */
function CheckAnswer({ answer }: { answer: PermissionCheck | 'no-thread' | undefined }): React.ReactNode {
  if (answer === undefined) return null
  if (answer === 'no-thread' || answer.kind === 'not-live') {
    return (
      <p role="status" className={PAGE_NOTE}>
        {answer === 'no-thread'
          ? 'Open a thread to check against its guards and engine.'
          : "This thread's permission engine has not loaded, so nothing there decides a call."}
        {answer === 'no-thread' ? '' : ` (${answer.detail})`}
      </p>
    )
  }
  if (answer.kind === 'unavailable') return <FieldError>{answer.detail}</FieldError>
  const { verdict } = answer
  const moot = verdict.guard.kind === 'refused'
  return (
    <div className="grid gap-2 rounded-sm border border-border-strong bg-background px-4 py-3 text-sm">
      <GuardAnswer guard={verdict.guard} />
      <dl aria-label="verdict" className={moot ? 'grid gap-1 opacity-60' : 'grid gap-1'}>
        <VerdictLine term="mode">{verdict.mode}</VerdictLine>
        <VerdictLine term={moot ? 'engine (moot)' : 'engine'}>
          <span className={`font-mono font-semibold ${DECISION_TEXT[verdict.state]}`}>{verdict.state}</span>
        </VerdictLine>
        <VerdictLine term="matched">
          {verdict.matchedPattern === undefined ? 'no pattern' : <code>{verdict.matchedPattern}</code>}
        </VerdictLine>
        <VerdictLine term="from">
          {verdict.origin}
          {ORIGIN_WORDS[verdict.origin] === undefined ? '' : ` — ${ORIGIN_WORDS[verdict.origin]}`}
        </VerdictLine>
        {verdict.reason === undefined ? null : <VerdictLine term="reason">{verdict.reason}</VerdictLine>}
      </dl>
    </div>
  )
}

/** One term of the verdict and its value, on one line. */
function VerdictLine({ term, children }: { term: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * Try a command: the open thread's verdict in its current mode, from its own guards and engine.
 * ⚠ The file as SAVED is what the engine runs under — an unsaved draft is not asked about.
 */
function TryCommand({
  threadId,
  surfaces,
  unsaved,
  fetch: fetchImpl,
}: {
  threadId: string | undefined
  surfaces: readonly string[]
  /** An unsaved draft is not in force: the engine answers for the file as saved. */
  unsaved: boolean
  fetch: FetchLike | undefined
}): React.ReactNode {
  const [surface, setSurface] = useState('bash')
  const [value, setValue] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<PermissionCheck | undefined>(undefined)
  const ask = async (): Promise<void> => {
    if (threadId === undefined) return
    setAsking(true)
    setAnswer(await checkPermission(threadId, { surface, value }, fetchImpl))
    setAsking(false)
  }
  return (
    <fieldset aria-label="try a command" className="grid gap-3">
      <h3 className={SUB_TITLE}>Try a command</h3>
      <p className={PAGE_NOTE}>See what would happen before pi tries it.</p>
      <span className="grid items-start gap-2 md:grid-cols-check-form">
        <OptionSelect
          label="check surface"
          value={surface}
          options={surfaces.map((choice) => [choice, choice] as const)}
          onChange={(next) => {
            setSurface(next)
            setAnswer(undefined)
          }}
          className={PAGE_INPUT}
        />
        <Input
          aria-label="check value"
          className={`${PAGE_INPUT} font-mono`}
          placeholder="git push origin main"
          value={value}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setValue(event.target.value)
            setAnswer(undefined)
          }}
        />
        <Button
          variant="outline"
          className={PAGE_OUTLINE_BUTTON}
          disabled={threadId === undefined || asking}
          onClick={() => void ask()}
        >
          Check
        </Button>
      </span>
      {unsaved ? (
        <p className={PAGE_NOTE}>
          The engine answers for the policy as saved; your unsaved changes are not in force yet.
        </p>
      ) : null}
      <CheckAnswer answer={threadId === undefined ? 'no-thread' : answer} />
    </fieldset>
  )
}

type ViewMode = 'written' | EnsoPermissionModeName

/** A card of the view's radiogroup: what it shows, and whether that view is the one you edit. */
interface ViewCard {
  readonly view: ViewMode
  readonly name: string
  readonly summary: string
  /** Said to assistive tech only: the prototype's cards carry no tag (#417), the table's state says it. */
  readonly tag: string
}

/** Your rules as written — the one view you edit — then each mode's preview, in the composer's order. */
const VIEW_CARDS: readonly ViewCard[] = [
  { view: 'written', name: 'as written', summary: 'Your rules in permissions.json.', tag: 'edit here' },
  ...ENSO_PERMISSION_MODES.map((mode) => ({
    view: mode,
    name: mode,
    summary: ENSO_MODE_PRESETS[mode].summary,
    tag: 'preview, read-only',
  })),
]

/**
 * The views as one radiogroup of cards (#874): as written, then the five modes. Radix's radio group
 * gives it the radiogroup's keys — Tab to the checked card, arrows to move and choose. Drawn as the
 * prototype's `.mode-grid` (#417): as many cards of their least width as fit.
 */
function ViewCards({ view, onView }: { view: ViewMode; onView: (view: ViewMode) => void }): React.ReactNode {
  return (
    <RadioGroupPrimitive.Root
      aria-labelledby="permissions-view-label"
      value={view}
      onValueChange={(value: string) => {
        const picked = VIEW_CARDS.find((card) => card.view === value)?.view
        if (picked !== undefined) onView(picked)
      }}
      className="grid grid-cols-mode-cards gap-2"
    >
      {VIEW_CARDS.map((card) => (
        <RadioGroupPrimitive.Item
          key={card.view}
          value={card.view}
          aria-label={card.name}
          aria-describedby={`permissions-view-${card.view}-tag permissions-view-${card.view}`}
          className="grid content-start gap-1 rounded-sm border bg-card p-3 text-left transition-colors outline-none hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 data-[state=checked]:border-primary data-[state=checked]:bg-accent"
        >
          <span className="font-mono text-sm font-semibold">{card.name}</span>
          <span id={`permissions-view-${card.view}-tag`} className="sr-only">
            {card.tag}
          </span>
          <span id={`permissions-view-${card.view}`} className="text-sm leading-normal text-muted-foreground">
            {card.summary}
          </span>
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}

/**
 * The prototype's order (#417): the modes, the rule groups, then the rules — as written (editable),
 * or as the picked mode runs them (read-only: the mode's rules are not yours) — and Add rule.
 */
function RulesView({ permission, editor }: { permission: EnsoPermissionMap; editor: PolicyEditor }): React.ReactNode {
  const [view, setView] = useState<ViewMode>('written')
  const mode = view === 'written' ? undefined : view
  return (
    <>
      <div className="grid gap-3">
        <h3 id="permissions-view-label" className={SUB_TITLE}>
          Modes
        </h3>
        <p className={PAGE_NOTE}>
          Each thread picks its mode from the composer. Pick one here to preview the rules it puts in effect below; you
          edit your rules as written.
        </p>
        <ViewCards view={view} onView={setView} />
      </div>
      <RuleGroups permission={permission} onEdit={editor.edit} />
      <div className="grid gap-3">
        <h3 id="permissions-rules-label" className={SUB_TITLE}>
          Rules, in order
        </h3>
        <p role="status" className={`${PAGE_NOTE} empty:hidden`}>
          {mode === undefined
            ? null
            : `Preview of ${mode}, read-only: the rules in effect under it, its own tagged "from ${mode}". Choose "as written" to edit.`}
        </p>
        {mode === undefined ? (
          <>
            <RuleList rows={policyRows(permission)} mode={undefined} editing={{ permission, onEdit: editor.edit }} />
            <AddRule permission={permission} onEdit={editor.edit} />
          </>
        ) : (
          <>
            <ReplacedSurfaces permission={permission} mode={mode} />
            <RuleList rows={effectiveRows(permission, mode)} mode={mode} editing={undefined} />
          </>
        )}
      </div>
    </>
  )
}

/** The file could not be read: the engine runs under an EMPTY policy until it is fixed or reset. */
function UnreadableWarning({ reason }: { reason: string }): React.ReactNode {
  return (
    <Alert variant="destructive" aria-label="unreadable policy">
      <TriangleAlertIcon />
      <AlertTitle>permissions.json cannot be read</AlertTitle>
      <AlertDescription>
        The engine reads it as an EMPTY policy: every call asks, and every deny is gone. {reason}. Reset to Enso's
        policy below, or fix the file by hand.
      </AlertDescription>
    </Alert>
  )
}

/**
 * Settings' Permissions section. `editor` is the page's (`usePermissionPolicy`); `threadId` is the
 * thread behind the page, the one "Try a command" asks. Laid out as the prototype's (#417): the
 * lede, the modes, the rule groups, the rules and the way to add one, the check, the settings
 * beside the rules, then the reset and the save bar last, pinned to the bottom of what scrolls
 * while there is something to save.
 */
export function PermissionsSection({
  editor,
  threadId,
  fetch: fetchImpl,
}: {
  editor: PolicyEditor
  threadId: string | undefined
  fetch: FetchLike | undefined
}): React.ReactNode {
  const { state } = editor
  if (state.kind === 'loading') return <p className={PAGE_NOTE}>reading permissions.json…</p>
  if (state.kind === 'unavailable') {
    return (
      <div className="flex flex-col gap-3">
        <FieldError>permissions: {state.detail}</FieldError>
        <Button variant="outline" className={`${PAGE_OUTLINE_BUTTON} self-start`} onClick={editor.reload}>
          Try again
        </Button>
      </div>
    )
  }
  const { policy } = state
  const permission = editor.draft ?? (policy.kind === 'ok' ? permissionOf(policy.file) : {})
  const tryCommand = (
    <TryCommand threadId={threadId} surfaces={checkSurfaces(permission)} unsaved={editor.dirty} fetch={fetchImpl} />
  )
  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-1.5">
        <p className="max-w-reading text-muted-foreground">
          What pi may do without asking. Rules are checked in order on each surface, and the last one that matches wins.
        </p>
        {policy.kind === 'unreadable' ? null : (
          <HeadFacts file={policy.file} reviewLogDirectory={policy.reviewLogDirectory} />
        )}
        {editor.backup === undefined ? null : (
          <p role="status" className="text-sm">
            Enso's policy is in force; the file it replaced is kept at <code>{editor.backup}</code>.
          </p>
        )}
      </div>
      {policy.kind === 'unreadable' ? (
        <>
          <UnreadableWarning reason={policy.reason} />
          <ResetPanel policy={policy} editor={editor} />
          <ProblemNotice editor={editor} />
          {tryCommand}
        </>
      ) : (
        <>
          <RulesView permission={permission} editor={editor} />
          {tryCommand}
          <BehaviourPart
            file={withSettings(policy.file, editor.settings ?? {})}
            path={policy.path}
            onSet={editor.setSetting}
          />
          <ResetPanel policy={policy} editor={editor} />
          <ProblemNotice editor={editor} />
          <SaveBar editor={editor} path={policy.path} />
        </>
      )}
    </div>
  )
}
