import type {
  EnsoConfigTier,
  EnsoProjectSettings,
  EnsoProjectSettingsUpdate,
  EnsoProjectThreadSettings,
  EnsoProjectTier,
  EnsoThreadTreeMode,
} from '@enso/core'
import { TriangleAlertIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from './components/ui/field.tsx'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.tsx'
import { Textarea } from './components/ui/textarea.tsx'
import { cn } from './lib/utils.ts'
import { OptionSelect } from './option-select.tsx'
import { PAGE_CARD, PAGE_INPUT, PAGE_OUTLINE_BUTTON, PAGE_PRIMARY_BUTTON, SAVE_BAR } from './page-styles.ts'
import { readProjectSettings, saveProjectSettings } from './project-list.ts'

/**
 * A project page's Worktrees tab (#754, a page since #871): how a new thread's tree is made in it.
 * The values are tiered (`@enso/core` `project-settings.ts`): local > shared > user > default, each
 * whole from one tier, so each field says which tier it shows and where that file is. The page
 * writes the project's own tiers only — and says which one a Save writes, by its file, before it
 * does: "Only me" (`.enso/config.local.json`) or "Shared" (`.enso/config.json`). It sends just the
 * keys the person changed; Reset removes a key from the tier that set it, so the next tier's value
 * shows through. The server decides: a refusal is shown in its words.
 *
 * ⚠ SETUP COMMANDS RUN ON THIS MACHINE. Whatever a tier lists runs in each new tree; the page says
 * so beside the field, and says when the project's own files are not read (an untrusted project).
 */

/** The files behind the tiers, as a page names them when it has no payload to read their paths from. */
const TIER_FILES: EnsoProjectSettings['files'] = {
  user: '~/.enso/config.json',
  shared: '.enso/config.json',
  local: '.enso/config.local.json',
}

/** Where a value comes from, in words a person can act on: the tier and the file to edit. */
export function tierWords(tier: EnsoConfigTier, files: EnsoProjectSettings['files'] = TIER_FILES): string {
  switch (tier) {
    case 'default':
      return 'default'
    case 'user':
      return `your settings (${files.user})`
    case 'shared':
      return `shared with the project (${files.shared})`
    case 'local':
      return `only you, this project (${files.local})`
  }
}

/**
 * Open Settings › Projects & threads (#934), where the user tier is edited: a value from your
 * settings links there. Absent (tests), it is plain words.
 */
const OpenUserSettings = createContext<(() => void) | undefined>(undefined)

/** One path or command per line; blank lines and surrounding spaces are no entry. */
export function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

type ThreadKey = keyof EnsoProjectThreadSettings

/** What the form holds while it is edited: the mode, and each list as the text in its box. */
interface Draft {
  readonly tree: EnsoThreadTreeMode
  readonly setup: string
  readonly copy: string
}

/** The draft a payload starts: its values, as the boxes show them. */
function draftOf(threads: EnsoProjectThreadSettings): Draft {
  return { tree: threads.tree.value, setup: threads.setup.value.join('\n'), copy: threads.copy.value.join('\n') }
}

/** The keys the person changed, and only those — a key left alone stays in whichever tier holds it. */
function changesOf(threads: EnsoProjectThreadSettings, draft: Draft): EnsoProjectSettingsUpdate['threads'] {
  const changes: EnsoProjectSettingsUpdate['threads'] = {}
  if (draft.tree !== threads.tree.value) changes.tree = draft.tree
  const setup = linesOf(draft.setup)
  if (JSON.stringify(setup) !== JSON.stringify(threads.setup.value)) changes.setup = setup
  const copy = linesOf(draft.copy)
  if (JSON.stringify(copy) !== JSON.stringify(threads.copy.value)) changes.copy = copy
  return changes
}

const TREE_MODES: ReadonlyArray<readonly [EnsoThreadTreeMode, string]> = [
  ['worktree', 'worktree — a tree of its own (the default)'],
  ['copy', 'copy — a copy of the project folder'],
  ['off', 'off — in the project folder itself'],
]

const FIELD_LABELS: Readonly<Record<ThreadKey, string>> = {
  tree: 'New threads run in',
  copy: 'Files to copy into a new tree',
  setup: 'Setup commands',
}

/** A tier file as the save choice names it: relative to the project when it is in it, else whole. */
function fileInProject(file: string, projectPath: string): string {
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

/**
 * Under a field: the tier its value comes from, its Reset when that is one of the project's own, and
 * whether it is edited. A Reset answers with new settings, which the form starts over from, so it
 * waits while any field holds an unsaved change rather than drop that change.
 */
function TierLine({
  field,
  tier,
  files,
  busy,
  edited,
  unsaved,
  onReset,
}: {
  field: ThreadKey
  tier: EnsoConfigTier
  files: EnsoProjectSettings['files']
  busy: boolean
  edited: boolean
  unsaved: boolean
  onReset: (field: ThreadKey, tier: EnsoProjectTier) => void
}): React.ReactNode {
  const openUserSettings = useContext(OpenUserSettings)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <p>
        from{' '}
        {tier === 'user' && openUserSettings !== undefined ? (
          <button
            type="button"
            className="text-xs text-primary underline underline-offset-3"
            title="Change it in Settings › Projects & threads"
            onClick={openUserSettings}
          >
            {tierWords(tier, files)}
          </button>
        ) : (
          tierWords(tier, files)
        )}
      </p>
      {tier === 'shared' || tier === 'local' ? (
        <button
          type="button"
          className="min-h-7 text-xs text-primary underline underline-offset-3 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || unsaved}
          aria-label={`Reset ${FIELD_LABELS[field]}`}
          title={
            unsaved
              ? 'save or discard the unsaved changes first'
              : `remove it from ${tierWords(tier, files)}, so the next tier's value shows through`
          }
          onClick={() => onReset(field, tier)}
        >
          Reset
        </button>
      ) : null}
      {edited ? <span className="font-mono text-meta text-chart-3">edited</span> : null}
    </div>
  )
}

/** A list field: one entry per line, a notice over its box when it needs one, its tier under it. */
function ListField({
  field,
  text,
  settings,
  busy,
  edited,
  unsaved,
  onText,
  onReset,
  notice,
  children,
}: {
  field: 'setup' | 'copy'
  text: string
  settings: EnsoProjectSettings
  busy: boolean
  edited: boolean
  unsaved: boolean
  onText: (text: string) => void
  onReset: (field: ThreadKey, tier: EnsoProjectTier) => void
  notice?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id} className="font-semibold">
        {FIELD_LABELS[field]}
      </FieldLabel>
      {notice}
      <Textarea
        id={id}
        className={cn(PAGE_INPUT, 'min-h-24 resize-y font-mono leading-relaxed')}
        spellCheck={false}
        value={text}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onText(event.target.value)}
      />
      {children}
      <TierLine
        field={field}
        tier={settings.threads[field].tier}
        files={settings.files}
        busy={busy}
        edited={edited}
        unsaved={unsaved}
        onReset={onReset}
      />
    </Field>
  )
}

/** The save choice's words for each of the project's tiers: who it is for, and the file it writes. */
const SAVE_TARGETS: ReadonlyArray<readonly [EnsoProjectTier, string]> = [
  ['local', 'Only me — this project'],
  ['shared', 'Shared — committed with the project'],
]

/** Only me or Shared, each named by the file a Save writes: chosen before anything is saved. */
function SaveTo({
  value,
  settings,
  onChange,
}: {
  value: EnsoProjectTier
  settings: EnsoProjectSettings
  onChange: (tier: EnsoProjectTier) => void
}): React.ReactNode {
  const legend = useId()
  return (
    <FieldSet>
      <FieldLegend id={legend} variant="label" className="mb-2 font-semibold">
        Save changes to
      </FieldLegend>
      {/* The prototype's radio cards (#417): the picked one wears the primary border on the accent. */}
      <RadioGroup
        aria-labelledby={legend}
        className="gap-2 md:grid-cols-2"
        value={value}
        onValueChange={(picked: string) => onChange(picked === 'shared' ? 'shared' : 'local')}
      >
        {SAVE_TARGETS.map(([tier, label]) => (
          <label
            key={tier}
            htmlFor={`${legend}-${tier}`}
            className="flex cursor-pointer items-start gap-2 rounded-sm border border-border-strong p-3 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-data-checked:border-primary has-data-checked:bg-accent"
          >
            <RadioGroupItem id={`${legend}-${tier}`} value={tier} className="mt-0.5" />
            <span className="grid min-w-0 gap-0.5">
              <strong className="text-sm font-semibold">{label}</strong>
              <span className="font-mono text-meta break-all text-muted-foreground">
                {fileInProject(settings.files[tier], settings.path)}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </FieldSet>
  )
}

/** The edits not saved yet: how many, the file a Save writes, and Discard and Save. Only while there are some. */
function UnsavedBar({
  count,
  file,
  busy,
  onDiscard,
  onSave,
}: {
  count: number
  file: string
  busy: boolean
  onDiscard: () => void
  onSave: () => void
}): React.ReactNode {
  if (count === 0) return null
  return (
    <div role="region" aria-label="Unsaved worktree settings" className={SAVE_BAR}>
      <span className="grid min-w-50 flex-1 text-sm">
        <strong>
          {count} unsaved {count === 1 ? 'change' : 'changes'}
        </strong>
        <span className="truncate font-mono text-meta text-muted-foreground">Saves to {file}</span>
      </span>
      <Button type="button" variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={busy} onClick={onDiscard}>
        Discard
      </Button>
      <Button type="button" className={PAGE_PRIMARY_BUTTON} disabled={busy} onClick={onSave}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
    </div>
  )
}

/** What the form says above its fields: an untrusted project's, and each of its files that could not be read. */
function FormNotes({ settings }: { settings: EnsoProjectSettings }): React.ReactNode {
  return (
    <>
      {settings.trusted ? null : (
        <p
          role="note"
          className="rounded-sm border border-dashed border-border-strong px-3 py-2 text-sm text-muted-foreground"
        >
          This project is not trusted yet, so its own files are not read: only your settings apply. Saving still writes
          the file.
        </p>
      )}
      {settings.unreadable.map((skipped) => (
        <p key={skipped.path} role="alert" className="rounded-sm border border-refuse px-3 py-2 text-sm text-refuse">
          {skipped.path} could not be read ({skipped.reason}), so its settings are not applied and saving to it is
          refused. Fix the file to use it.
        </p>
      ))}
    </>
  )
}

/**
 * The tab's form over one loaded payload. Its draft starts from the payload; the tab remounts it
 * (by key) whenever the server answers new settings, so the draft never outlives them. The save
 * choice is the tab's, so a save doesn't put it back to Only me.
 */
function WorktreesForm({
  settings,
  busy,
  refusal,
  saveTo,
  onSaveTo,
  onSend,
}: {
  settings: EnsoProjectSettings
  busy: boolean
  refusal: string | undefined
  saveTo: EnsoProjectTier
  onSaveTo: (tier: EnsoProjectTier) => void
  onSend: (update: EnsoProjectSettingsUpdate) => void
}): React.ReactNode {
  const { threads, files } = settings
  const [draft, setDraft] = useState<Draft>(() => draftOf(threads))
  const treeId = useId()
  const changes = changesOf(threads, draft)
  const unsaved = Object.keys(changes).length > 0
  const reset = (field: ThreadKey, tier: EnsoProjectTier): void => {
    const cleared: EnsoProjectSettingsUpdate['threads'] = {}
    cleared[field] = null
    onSend({ tier, threads: cleared })
  }
  return (
    <FieldGroup className={PAGE_CARD}>
      <p className="max-w-prose text-muted-foreground">
        How a new thread’s tree is made in this project. Each value comes from one place: this project only for you, the
        project’s shared file, your settings, or Enso’s default — the first one set wins.
      </p>
      <FormNotes settings={settings} />
      <SaveTo value={saveTo} settings={settings} onChange={onSaveTo} />
      <Field>
        <FieldLabel htmlFor={treeId} className="font-semibold">
          {FIELD_LABELS.tree}
        </FieldLabel>
        <OptionSelect
          id={treeId}
          className={PAGE_INPUT}
          value={draft.tree}
          options={TREE_MODES}
          onChange={(tree: EnsoThreadTreeMode) => setDraft({ ...draft, tree })}
        />
        <FieldDescription>
          A tree keeps a thread's edits out of your checkout until you bring them back. Off runs the thread in the
          project folder: no tree, and no file restore.
        </FieldDescription>
        <TierLine
          field="tree"
          tier={threads.tree.tier}
          files={files}
          busy={busy}
          edited={changes.tree !== undefined}
          unsaved={unsaved}
          onReset={reset}
        />
      </Field>
      <ListField
        field="copy"
        text={draft.copy}
        settings={settings}
        busy={busy}
        edited={changes.copy !== undefined}
        unsaved={unsaved}
        onText={(copy: string) => setDraft({ ...draft, copy })}
        onReset={reset}
      >
        <FieldDescription>
          One path per line, relative to the project — for gitignored files a new tree needs, such as .env.
        </FieldDescription>
      </ListField>
      <ListField
        field="setup"
        text={draft.setup}
        settings={settings}
        busy={busy}
        edited={changes.setup !== undefined}
        unsaved={unsaved}
        onText={(setup: string) => setDraft({ ...draft, setup })}
        onReset={reset}
        notice={
          // The prototype's warning callout (#417): these commands run on this machine, so the warning sits over the box.
          <p role="note" className="flex items-start gap-2 rounded-sm border border-chart-3 p-3 text-sm">
            <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-chart-3" />
            These run on your machine, in the new tree, each time a thread's tree is made.
          </p>
        }
      >
        <FieldDescription>
          One command per line, run in order in a new tree — for example bun install --frozen-lockfile.
        </FieldDescription>
      </ListField>
      {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
      <UnsavedBar
        count={Object.keys(changes).length}
        file={fileInProject(files[saveTo], settings.path)}
        busy={busy}
        onDiscard={() => setDraft(draftOf(threads))}
        onSave={() => onSend({ tier: saveTo, threads: changes })}
      />
    </FieldGroup>
  )
}

type Loading =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly settings: EnsoProjectSettings; readonly version: number }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * The tab for one project: its settings read when it opens, and every write's answer shown in their
 * place. Read again when `revision` moves — the page's trust or an approval changed (#873, #753), and
 * with it what the settings resolve to; the form is remounted on the new answer, as after a save.
 * `onSaved` says a save went through: it wrote a file and approved it as written (#753).
 */
export function ProjectWorktrees({
  projectId,
  fetch: fetchImpl,
  revision = 0,
  onOpenSettings,
  onSaved,
}: {
  projectId: string
  /** Injected by tests; the page's global by default. */
  fetch?: FetchLike | undefined
  revision?: number
  /** Open Settings › Projects & threads: a value from your settings links there. */
  onOpenSettings?: () => void
  onSaved?: (() => void) | undefined
}): React.ReactNode {
  const [loading, setLoading] = useState<Loading>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  const [saveTo, setSaveTo] = useState<EnsoProjectTier>('local')
  useEffect(() => {
    let current = true
    void readProjectSettings(projectId, fetchImpl).then((outcome) => {
      if (!current) return
      setLoading((was) =>
        outcome.kind === 'ok'
          ? { kind: 'loaded', settings: outcome.value, version: was.kind === 'loaded' ? was.version + 1 : 0 }
          : { kind: 'failed', reason: outcome.reason },
      )
    })
    return () => {
      current = false
    }
  }, [projectId, fetchImpl, revision])
  const send = async (update: EnsoProjectSettingsUpdate): Promise<void> => {
    setBusy(true)
    setRefusal(undefined)
    try {
      const outcome = await saveProjectSettings(projectId, update, fetchImpl)
      if (outcome.kind === 'refused') {
        setRefusal(outcome.reason)
        return
      }
      setLoading((was) => ({
        kind: 'loaded',
        settings: outcome.value,
        version: was.kind === 'loaded' ? was.version + 1 : 0,
      }))
      onSaved?.()
    } catch (error) {
      // A request that never reached the server: said, and the form answerable again.
      setRefusal(`the settings could not be sent: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }
  if (loading.kind === 'loading') return <p className="text-sm text-muted-foreground">reading its settings…</p>
  if (loading.kind === 'failed') return <FieldError>could not read its settings: {loading.reason}</FieldError>
  return (
    <OpenUserSettings.Provider value={onOpenSettings}>
      <WorktreesForm
        key={loading.version}
        settings={loading.settings}
        busy={busy}
        refusal={refusal}
        saveTo={saveTo}
        onSaveTo={setSaveTo}
        onSend={(update: EnsoProjectSettingsUpdate) => void send(update)}
      />
    </OpenUserSettings.Provider>
  )
}
