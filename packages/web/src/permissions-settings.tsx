import {
  ENSO_CATCH_ALL,
  ENSO_DRAFTED_RULE_GROUPS,
  ENSO_MODE_PRESETS,
  ENSO_PERMISSION_MODES,
  type EnsoDraftedRuleGroup,
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
import { ArrowDownIcon, ArrowUpIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert.tsx'
import { Button } from './components/ui/button.tsx'
import { FieldError } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { OptionSelect } from './option-select.tsx'
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
  withPatternRenamed,
} from './permissions-draft.ts'

/**
 * Settings' Permissions section (#474): the rules pi runs under, from `ENSO_HOME/permissions.json`
 * in the engine's own format — shown in the engine's order, per mode, edited on a draft and saved
 * whole under the ETag read, reset to Enso's with the diff shown first, and checked against the
 * open thread's live engine. Only the user's file: project policy is #502's, not this section's.
 *
 * ⚠ THE PAGE NEVER GUESSES A VERDICT. What a mode does to the rules is `effectiveRows` (pinned to
 * the engine by `agent-host.test.ts`); what a given command gets is only ever the engine's answer,
 * through the open thread (built on ask). When its engine has not loaded, the section says so
 * rather than match patterns itself.
 */

const ACTIONS: ReadonlyArray<readonly [EnsoPermissionAction, string]> = [
  ['allow', 'allow'],
  ['ask', 'ask'],
  ['deny', 'deny'],
]

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
  /** The edited `permission` block; `undefined` while nothing is edited. */
  readonly draft: EnsoPermissionMap | undefined
  readonly working: boolean
  readonly problem: PolicyProblem | undefined
  /** Where a reset kept the file it replaced. */
  readonly backup: string | undefined
  readonly edit: (change: (permission: EnsoPermissionMap) => EnsoPermissionMap) => void
  readonly discard: () => void
  readonly save: (overwrite: boolean) => void
  readonly reload: () => void
  readonly reset: () => void
}

/**
 * The policy as read and the draft over it, read each time the dialog opens.
 *
 * ⚠ HELD BY THE DIALOG, NOT THE SECTION: closing Settings or switching tab keeps an unsaved draft.
 * An open with a draft pending does not re-read — the draft was made on the version read, and a
 * newer read would let its save overwrite a change it never saw; the save's 412 says so instead.
 */
export function usePermissionPolicy(open: boolean, fetchImpl: FetchLike | undefined): PolicyEditor {
  const [state, setState] = useState<PolicyState>({ kind: 'loading' })
  const [draft, setDraft] = useState<EnsoPermissionMap | undefined>(undefined)
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<PolicyProblem | undefined>(undefined)
  const [backup, setBackup] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  // Refs beside the state: a save's answer compares against the draft as it is THEN, and a
  // double-click on Save must not send twice.
  const draftNow = useRef<EnsoPermissionMap | undefined>(undefined)
  const inFlight = useRef(false)
  const changeDraft = useCallback((next: EnsoPermissionMap | undefined): void => {
    draftNow.current = next
    setDraft(next)
  }, [])

  useEffect(() => {
    if (!open || draftNow.current !== undefined) return
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

  /**
   * What a save writes over, and under which version (#519). A plain save: the file as read, under its
   * ETag. An overwrite after a 412: the file as it is on disk NOW, re-read, under ITS ETag, so only the
   * draft's `permission` replaces anything and a setting edited by hand in the meantime
   * (`permissionReviewLog: false`) stays. It used to send the file as first read with `If-Match: *`,
   * reverting such a setting silently. A file that cannot be read now is overwritten as before.
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
    if (loaded?.kind !== 'ok' || sent === undefined || inFlight.current) return
    inFlight.current = true
    setWorking(true)
    let outcome: PolicySave
    try {
      const base = await saveBase(loaded.file, loaded.etag, overwrite)
      outcome = await savePermissionPolicy({ file: { ...base.file, permission: sent } }, base.etag, fetchImpl)
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
  }

  return {
    state,
    draft,
    working,
    problem,
    backup,
    edit,
    discard: (): void => {
      changeDraft(undefined)
      setProblem(undefined)
    },
    save: (overwrite: boolean): void => void save(overwrite),
    reload: (): void => {
      changeDraft(undefined)
      setProblem(undefined)
      setState({ kind: 'loading' })
      setGeneration((count) => count + 1)
    },
    reset: (): void => void reset(),
  }
}

/** Who a row is, in words: what a mode may do to it. */
function ownerWords(row: EnsoPolicyRow, mode: EnsoPermissionModeName | undefined): string {
  if (row.owner === 'catch-all') return "Enso's catch-all — a mode may change this"
  if (row.owner === 'mode') return `from ${mode ?? 'the mode'}`
  return 'yours — holds in every mode'
}

/** A row's pattern, editable in place: the rename lands on blur or Enter, or says why it cannot. */
function PatternField({
  row,
  onRename,
}: {
  row: EnsoPolicyRow
  onRename: (to: string) => string | undefined
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
    <span className="flex min-w-0 flex-1 flex-col">
      <Input
        aria-label={`pattern ${row.surface} ${row.pattern}`}
        aria-invalid={refusal !== undefined}
        className="h-7 font-mono text-xs"
        value={text}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTyped(event.target.value)}
        onBlur={commit}
        onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') commit()
        }}
      />
      {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
    </span>
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

/** A rule's controls. ⚠ Enso's `**` takes an action change only: a mode needs it where it is (#499). */
function RuleControls({ row, edits }: { row: EnsoPolicyRow; edits: RowEdits }): React.ReactNode {
  const name = `${row.surface} ${row.pattern}`
  const catchAll = row.pattern === ENSO_CATCH_ALL
  return (
    <>
      <OptionSelect
        label={`action ${name}`}
        value={decisionAction(row.decision)}
        options={ACTIONS}
        onChange={edits.onAction}
      />
      {catchAll ? null : (
        <span className="flex gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`move ${name} up`}
            disabled={!edits.canMoveUp}
            onClick={() => edits.onMove(-1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`move ${name} down`}
            disabled={!edits.canMoveDown}
            onClick={() => edits.onMove(1)}
          >
            <ArrowDownIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label={`remove ${name}`} onClick={edits.onRemove}>
            <XIcon />
          </Button>
        </span>
      )}
    </>
  )
}

/** One rule: its pattern, its action, whose it is, and what an allow on it lets through. */
function RuleRow({
  row,
  mode,
  edits,
}: {
  row: EnsoPolicyRow
  mode: EnsoPermissionModeName | undefined
  edits: RowEdits | undefined
}): React.ReactNode {
  const renamable = edits !== undefined && row.pattern !== ENSO_CATCH_ALL
  const reason = typeof row.decision === 'object' ? row.decision.reason : undefined
  return (
    <li aria-label={`${row.surface} ${row.pattern}`} className="flex flex-col gap-0.5 border-b py-1.5 last:border-b-0">
      <span className="flex items-center gap-2">
        {renamable ? (
          <PatternField row={row} onRename={edits.onRename} />
        ) : (
          <code className="min-w-0 flex-1 truncate text-xs">{row.pattern}</code>
        )}
        {edits === undefined ? (
          <span className="text-xs font-semibold">{decisionAction(row.decision)}</span>
        ) : (
          <RuleControls row={row} edits={edits} />
        )}
      </span>
      <span className="text-xs text-muted-foreground">{ownerWords(row, mode)}</span>
      {reason === undefined ? null : <span className="text-xs">told the agent: {reason}</span>}
      {row.runsCode === undefined ? null : (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <TriangleAlertIcon className="size-3" aria-hidden="true" /> runs code unasked: {row.runsCode}
        </span>
      )}
    </li>
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

/** The rules per surface, in the engine's order; editable when `editing` is given. */
function RuleList({
  rows,
  mode,
  editing,
}: {
  rows: readonly EnsoPolicyRow[]
  mode: EnsoPermissionModeName | undefined
  editing: RuleEditing | undefined
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-3">
      {rowsBySurface(rows).map((group) => (
        <section key={group.surface} aria-label={`surface ${group.surface}`}>
          <h4 className="font-mono text-xs font-semibold">{group.surface}</h4>
          <ul className="rounded-md border px-2">
            {group.rows.map((row, position) => (
              <RuleRow
                key={row.pattern}
                row={row}
                mode={mode}
                edits={editing === undefined ? undefined : rowEdits(row, group.rows, position, editing)}
              />
            ))}
          </ul>
        </section>
      ))}
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
    <p className="text-xs text-muted-foreground">
      In {mode}, the mode replaces these surfaces whole — your rules on them do not apply: {replaced.join(', ')}
    </p>
  )
}

/**
 * The file's knobs, said where they change behaviour. ⚠ A running thread reads the knobs when a
 * prompt starts (the engine's `before_agent_start` refresh), but the rules at every call: a saved
 * `yoloMode` is in force from the thread's NEXT prompt, and "Try a command" answers before it
 * as the engine does. Found in #474's browser smoke.
 */
function KnobNotes({
  file,
  reviewLogDirectory,
}: {
  file: Record<string, unknown>
  reviewLogDirectory: string
}): React.ReactNode {
  const knobs = policyKnobs(file)
  return (
    <>
      {knobs.yoloMode ? (
        <Alert variant="destructive" aria-label="yolo mode">
          <TriangleAlertIcon />
          <AlertTitle>yoloMode is on</AlertTitle>
          <AlertDescription>
            Every ask becomes allow, in every mode: nothing below that asks will ask. A running thread takes this up at
            its next prompt.
          </AlertDescription>
        </Alert>
      ) : null}
      {knobs.reviewLog ? (
        <p className="text-xs text-muted-foreground">
          Every decision is logged, in <code>{reviewLogDirectory}</code>.
        </p>
      ) : null}
      {knobs.autoClassifier ? null : (
        <p className="text-xs text-muted-foreground">
          auto asks instead of classifying: the file's authorizerChain does not name Enso's classifier.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
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
    <fieldset aria-label="add a rule" className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <OptionSelect
          label="new rule surface"
          value={surface}
          options={surfaces.map((choice) => [choice, choice] as const)}
          onChange={setSurface}
        />
        <Input
          aria-label="new rule pattern"
          className="h-7 min-w-40 flex-1 font-mono text-xs"
          placeholder="git push *"
          value={pattern}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPattern(event.target.value)}
        />
        <OptionSelect label="new rule action" value={action} options={ACTIONS} onChange={setAction} />
        <Button variant="outline" size="sm" onClick={add}>
          Add rule
        </Button>
      </span>
      {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
      <p className="text-xs text-muted-foreground">
        Patterns: <code>*</code> matches anything, <code>/</code> included; a trailing <code> *</code> also matches the
        bare command (<code>git *</code> matches <code>git</code>). Last match wins on a surface.
      </p>
    </fieldset>
  )
}

/** One drafted group: what it stops or allows, its rules marked when already in force, and an Add. */
function DraftedGroup({
  group,
  permission,
  onEdit,
}: {
  group: EnsoDraftedRuleGroup
  permission: EnsoPermissionMap
  onEdit: PolicyEditor['edit']
}): React.ReactNode {
  const present = group.rules.map((rule) => hasRule(permission, rule.surface, rule.pattern, rule.decision))
  return (
    <section aria-label={`drafted ${group.title}`} className="flex flex-col gap-1 rounded-md border p-2">
      <span className="flex items-center justify-between gap-2">
        <span className="font-semibold">{group.title}</span>
        <Button
          variant="outline"
          size="xs"
          aria-label={`add ${group.title}`}
          disabled={present.every(Boolean)}
          onClick={() => onEdit((current) => withGroup(current, group))}
        >
          Add
        </Button>
      </span>
      <p className="text-xs text-muted-foreground">{group.note}</p>
      <ul className="text-xs">
        {group.rules.map((rule, position) => (
          <li key={`${rule.surface} ${rule.pattern}`}>
            <code>
              {rule.surface} {rule.pattern}
            </code>{' '}
            → {rule.decision}
            {present[position] === true ? <span className="text-muted-foreground"> · already in force</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function DraftedGroups({
  permission,
  onEdit,
}: {
  permission: EnsoPermissionMap
  onEdit: PolicyEditor['edit']
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">Drafted rules</h3>
      {ENSO_DRAFTED_RULE_GROUPS.map((group) => (
        <DraftedGroup key={group.id} group={group} permission={permission} onEdit={onEdit} />
      ))}
      <p className="text-xs text-muted-foreground">
        Git safety — no <code>--no-verify</code>, no <code>push --delete</code> — is already in Enso's policy.
      </p>
    </div>
  )
}

/** Save and Discard, and whether there is anything to save. */
function SaveBar({ editor }: { editor: PolicyEditor }): React.ReactNode {
  const dirty = editor.draft !== undefined
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" disabled={!dirty || editor.working} onClick={() => editor.save(false)}>
        Save
      </Button>
      <Button variant="ghost" size="sm" disabled={!dirty || editor.working} onClick={editor.discard}>
        Discard
      </Button>
      <span className="text-xs text-muted-foreground">{dirty ? 'unsaved changes' : 'saved'}</span>
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
      <div role="alert" aria-label="refused" className="text-sm text-destructive">
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
    <div role="alert" aria-label="changed on disk" className="flex flex-col gap-2 text-sm">
      <p>
        permissions.json changed on disk since it was read ({problem.detail}). Nothing was written; your changes are
        still here. Overwrite with mine puts your rules over the file as it is on disk now, and keeps its other settings
        as they are there.
      </p>
      <span className="flex gap-2">
        <Button variant="outline" size="sm" disabled={editor.working} onClick={editor.reload}>
          Reload from disk
        </Button>
        {problem.during === 'save' ? (
          <Button variant="destructive" size="sm" disabled={editor.working} onClick={() => editor.save(true)}>
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
  if (changes.length === 0) return <p className="text-xs">The file is already Enso's policy.</p>
  const sections = [...new Set(changes.map((change) => change.section))]
  return (
    <div aria-label="reset diff" className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border p-2 text-xs">
      {sections.map((section) => (
        <section key={section}>
          <h4 className="font-mono font-semibold">{section}</h4>
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
      <Button variant="outline" size="sm" className="self-start" onClick={() => setConfirming(true)}>
        Reset to Enso's policy…
      </Button>
    )
  }
  const changes = policyDiff(policy.kind === 'ok' ? policy.file : undefined, policy.ensoDefault)
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <p className="text-sm">
        Resetting replaces permissions.json with Enso's policy; the current file is kept as a backup.
        {editor.draft === undefined ? '' : ' Your unsaved changes go too.'}
      </p>
      <ResetDiff changes={changes} />
      <span className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={editor.working}
          onClick={() => {
            setConfirming(false)
            editor.reset()
          }}
        >
          Reset
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
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

/** The engine's answer, as it gave it. */
function CheckAnswer({ answer }: { answer: PermissionCheck | 'no-thread' | undefined }): React.ReactNode {
  if (answer === undefined) return null
  if (answer === 'no-thread' || answer.kind === 'not-live') {
    return (
      <p role="status" className="text-xs">
        {answer === 'no-thread'
          ? 'Open a thread to ask its engine.'
          : "This thread's permission engine has not loaded, so nothing there decides a call."}
        {answer === 'no-thread' ? '' : ` (${answer.detail})`}
      </p>
    )
  }
  if (answer.kind === 'unavailable') return <FieldError>{answer.detail}</FieldError>
  const { verdict } = answer
  return (
    <dl aria-label="verdict" className="flex flex-col text-xs">
      <VerdictLine term="mode">{verdict.mode}</VerdictLine>
      <VerdictLine term="decision">
        <span className="font-semibold">{verdict.state}</span>
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
  )
}

/** One term of the verdict and its value, on one line. */
function VerdictLine({ term, children }: { term: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-muted-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * Try a command: the engine's own verdict for the open thread, in its current mode.
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
    <fieldset aria-label="try a command" className="flex flex-col gap-1">
      <h3 className="font-semibold">Try a command</h3>
      <span className="flex flex-wrap items-center gap-2">
        <OptionSelect
          label="check surface"
          value={surface}
          options={surfaces.map((choice) => [choice, choice] as const)}
          onChange={(next) => {
            setSurface(next)
            setAnswer(undefined)
          }}
        />
        <Input
          aria-label="check value"
          className="h-7 min-w-40 flex-1 font-mono text-xs"
          placeholder="git push origin main"
          value={value}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setValue(event.target.value)
            setAnswer(undefined)
          }}
        />
        <Button variant="outline" size="sm" disabled={threadId === undefined || asking} onClick={() => void ask()}>
          Ask the engine
        </Button>
      </span>
      {unsaved ? (
        <p className="text-xs text-muted-foreground">
          The engine answers for the policy as saved; your unsaved changes are not in force yet.
        </p>
      ) : null}
      <CheckAnswer answer={threadId === undefined ? 'no-thread' : answer} />
    </fieldset>
  )
}

type ViewMode = 'written' | EnsoPermissionModeName

const VIEW_OPTIONS: ReadonlyArray<readonly [ViewMode, string]> = [
  ['written', 'as written (edit here)'],
  ...ENSO_PERMISSION_MODES.map((mode) => [mode, `${mode} — ${ENSO_MODE_PRESETS[mode].summary}`] as const),
]

/** The rules as written (editable), or as a mode runs them (read-only: the mode's rules are not yours). */
function RulesView({ permission, editor }: { permission: EnsoPermissionMap; editor: PolicyEditor }): React.ReactNode {
  const [view, setView] = useState<ViewMode>('written')
  const mode = view === 'written' ? undefined : view
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2">
        <label htmlFor="permissions-view" className="text-xs font-semibold">
          Show
        </label>
        <OptionSelect id="permissions-view" value={view} options={VIEW_OPTIONS} onChange={setView} />
      </span>
      {mode === undefined ? (
        <RuleList rows={policyRows(permission)} mode={undefined} editing={{ permission, onEdit: editor.edit }} />
      ) : (
        <>
          <ReplacedSurfaces permission={permission} mode={mode} />
          <RuleList rows={effectiveRows(permission, mode)} mode={mode} editing={undefined} />
        </>
      )}
    </div>
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
 * The Permissions tab. `editor` is the dialog's (`usePermissionPolicy`); `threadId` is the open
 * thread "Try a command" asks.
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
  if (state.kind === 'loading') return <p className="text-sm text-muted-foreground">reading permissions.json…</p>
  if (state.kind === 'unavailable') {
    return (
      <div className="flex flex-col gap-2">
        <FieldError>permissions: {state.detail}</FieldError>
        <Button variant="outline" size="sm" className="self-start" onClick={editor.reload}>
          Try again
        </Button>
      </div>
    )
  }
  const { policy } = state
  const permission = editor.draft ?? (policy.kind === 'ok' ? permissionOf(policy.file) : {})
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        This section is saved on the server, in <code>{policy.path}</code>; the rest of Settings is kept in this
        browser.
      </p>
      {editor.backup === undefined ? null : (
        <p role="status" className="text-xs">
          Enso's policy is in force; the file it replaced is kept at <code>{editor.backup}</code>.
        </p>
      )}
      <ProblemNotice editor={editor} />
      {policy.kind === 'unreadable' ? (
        <>
          <UnreadableWarning reason={policy.reason} />
          <ResetPanel policy={policy} editor={editor} />
        </>
      ) : (
        <>
          <KnobNotes file={policy.file} reviewLogDirectory={policy.reviewLogDirectory} />
          <SaveBar editor={editor} />
          <RulesView permission={permission} editor={editor} />
          <AddRule permission={permission} onEdit={editor.edit} />
          <DraftedGroups permission={permission} onEdit={editor.edit} />
          <ResetPanel policy={policy} editor={editor} />
        </>
      )}
      <TryCommand
        threadId={threadId}
        surfaces={checkSurfaces(permission)}
        unsaved={editor.draft !== undefined}
        fetch={fetchImpl}
      />
    </div>
  )
}
