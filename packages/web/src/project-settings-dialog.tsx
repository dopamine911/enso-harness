import type {
  EnsoConfigTier,
  EnsoProject,
  EnsoProjectSettings,
  EnsoProjectSettingsUpdate,
  EnsoProjectThreadSettings,
  EnsoProjectTier,
  EnsoThreadTreeMode,
} from '@enso/core'
import { TriangleAlertIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.tsx'
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
import { OptionSelect } from './option-select.tsx'
import { readProjectSettings, saveProjectSettings } from './project-list.ts'

/**
 * A project's page (#754), opened from its rail menu: how a new thread's tree is made in it. The
 * values are tiered (`@enso/core` `project-settings.ts`): local > shared > user > default, each
 * whole from one tier, so each field says which tier it shows and where that file is. The page
 * writes the project's own tiers only — shared (committed with the project) or local (only you) —
 * and sends just the keys the person changed; Reset removes a key from the tier that set it, so
 * the next tier's value shows through. The server decides: a refusal is shown in its words.
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

/** One path or command per line; blank lines and surrounding spaces are no entry. */
function linesOf(text: string): string[] {
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

/** Under a field: the tier its value comes from, and — when that is one of the project's own — its Reset. */
function TierLine({
  field,
  tier,
  files,
  busy,
  onReset,
}: {
  field: ThreadKey
  tier: EnsoConfigTier
  files: EnsoProjectSettings['files']
  busy: boolean
  onReset: (field: ThreadKey, tier: EnsoProjectTier) => void
}): React.ReactNode {
  return (
    <div className="flex items-center justify-between gap-2">
      <FieldDescription>from {tierWords(tier, files)}</FieldDescription>
      {tier === 'shared' || tier === 'local' ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={busy}
          aria-label={`Reset ${FIELD_LABELS[field]}`}
          title={`remove it from ${tierWords(tier, files)}, so the next tier's value shows through`}
          onClick={() => onReset(field, tier)}
        >
          Reset
        </Button>
      ) : null}
    </div>
  )
}

/** A list field: one entry per line, its tier under it. */
function ListField({
  field,
  text,
  settings,
  busy,
  onText,
  onReset,
  children,
}: {
  field: 'setup' | 'copy'
  text: string
  settings: EnsoProjectSettings
  busy: boolean
  onText: (text: string) => void
  onReset: (field: ThreadKey, tier: EnsoProjectTier) => void
  children: React.ReactNode
}): React.ReactNode {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{FIELD_LABELS[field]}</FieldLabel>
      <Textarea
        id={id}
        className="font-mono text-xs"
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
        onReset={onReset}
      />
    </Field>
  )
}

/** Shared or only me: which of the project's files a Save writes. */
function SaveTo({
  value,
  onChange,
}: {
  value: EnsoProjectTier
  onChange: (tier: EnsoProjectTier) => void
}): React.ReactNode {
  const legend = useId()
  return (
    <FieldSet>
      <FieldLegend id={legend} variant="label">
        Save to
      </FieldLegend>
      <RadioGroup
        aria-labelledby={legend}
        value={value}
        onValueChange={(picked: string) => onChange(picked === 'shared' ? 'shared' : 'local')}
      >
        <Field orientation="horizontal">
          <RadioGroupItem id={`${legend}-local`} value="local" />
          <FieldLabel htmlFor={`${legend}-local`}>Only me — this project</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem id={`${legend}-shared`} value="shared" />
          <FieldLabel htmlFor={`${legend}-shared`}>Shared — committed with the project</FieldLabel>
        </Field>
      </RadioGroup>
    </FieldSet>
  )
}

/**
 * The Worktrees section over one loaded payload. Its draft starts from the payload; the page
 * remounts it (by key) whenever the server answers new settings, so the draft never outlives them.
 */
function WorktreesForm({
  settings,
  busy,
  refusal,
  onSend,
}: {
  settings: EnsoProjectSettings
  busy: boolean
  refusal: string | undefined
  onSend: (update: EnsoProjectSettingsUpdate) => void
}): React.ReactNode {
  const { threads, files } = settings
  const [draft, setDraft] = useState<Draft>(() => ({
    tree: threads.tree.value,
    setup: threads.setup.value.join('\n'),
    copy: threads.copy.value.join('\n'),
  }))
  const [saveTo, setSaveTo] = useState<EnsoProjectTier>('local')
  const treeId = useId()
  const changes = changesOf(threads, draft)
  const reset = (field: ThreadKey, tier: EnsoProjectTier): void => {
    const cleared: EnsoProjectSettingsUpdate['threads'] = {}
    cleared[field] = null
    onSend({ tier, threads: cleared })
  }
  return (
    <FieldGroup>
      {settings.trusted ? null : (
        <p role="note" className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          This project is not trusted yet: its own files ({files.shared}, {files.local}) are not read until it is, so
          only your settings apply. Saving still writes the file.
        </p>
      )}
      {settings.unreadable.map((skipped) => (
        <p
          key={skipped.path}
          role="alert"
          className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive"
        >
          {skipped.path} could not be read ({skipped.reason}), so its settings are not applied and saving to it is
          refused. Fix the file to use it.
        </p>
      ))}
      <Field>
        <FieldLabel htmlFor={treeId}>{FIELD_LABELS.tree}</FieldLabel>
        <OptionSelect
          id={treeId}
          className="rounded-md border bg-background px-2 py-1 text-sm text-foreground"
          value={draft.tree}
          options={TREE_MODES}
          onChange={(tree: EnsoThreadTreeMode) => setDraft({ ...draft, tree })}
        />
        <FieldDescription>
          A tree keeps a thread's edits out of your checkout until you bring them back. Off runs the thread in the
          project folder: no tree, and no file restore.
        </FieldDescription>
        <TierLine field="tree" tier={threads.tree.tier} files={files} busy={busy} onReset={reset} />
      </Field>
      <ListField
        field="copy"
        text={draft.copy}
        settings={settings}
        busy={busy}
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
        onText={(setup: string) => setDraft({ ...draft, setup })}
        onReset={reset}
      >
        <FieldDescription>
          One command per line, run in order in a new tree — for example bun install --frozen-lockfile.
        </FieldDescription>
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
          These run on your machine, in the new tree, each time a thread's tree is made.
        </p>
      </ListField>
      <SaveTo value={saveTo} onChange={setSaveTo} />
      {refusal === undefined ? null : <FieldError>{refusal}</FieldError>}
      <DialogFooter>
        <Button
          type="button"
          disabled={busy || Object.keys(changes).length === 0}
          onClick={() => onSend({ tier: saveTo, threads: changes })}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </FieldGroup>
  )
}

type Loading =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly settings: EnsoProjectSettings; readonly version: number }
  | { readonly kind: 'failed'; readonly reason: string }

/** The page's body for one project: its settings read once it opens, and every write's answer shown in their place. */
function ProjectSettingsBody({
  projectId,
  fetchImpl,
}: {
  projectId: string
  fetchImpl: FetchLike | undefined
}): React.ReactNode {
  const [loading, setLoading] = useState<Loading>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  useEffect(() => {
    let current = true
    void readProjectSettings(projectId, fetchImpl).then((outcome) => {
      if (!current) return
      setLoading(
        outcome.kind === 'ok'
          ? { kind: 'loaded', settings: outcome.value, version: 0 }
          : { kind: 'failed', reason: outcome.reason },
      )
    })
    return () => {
      current = false
    }
  }, [projectId, fetchImpl])
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
    <section aria-label="Worktrees" className="grid gap-3">
      <h3 className="font-medium">Worktrees</h3>
      <WorktreesForm
        key={loading.version}
        settings={loading.settings}
        busy={busy}
        refusal={refusal}
        onSend={(update: EnsoProjectSettingsUpdate) => void send(update)}
      />
    </section>
  )
}

/**
 * The project page as a dialog, open while `project` is set. Named by the project's title; its
 * path under it. Each opening reads the settings afresh.
 */
export function ProjectSettingsDialog({
  project,
  onClose,
  fetch: fetchImpl,
}: {
  project: EnsoProject | undefined
  onClose: () => void
  /** Injected by tests; the page's global by default. */
  fetch?: FetchLike
}): React.ReactNode {
  return (
    <Dialog open={project !== undefined} onOpenChange={(next: boolean): void => (next ? undefined : onClose())}>
      <DialogContent className="flex max-h-5/6 flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{project?.title}</DialogTitle>
          <DialogDescription className="break-all">{project?.path}</DialogDescription>
        </DialogHeader>
        {project === undefined ? null : (
          <div className="min-h-0 overflow-y-auto pr-1">
            <ProjectSettingsBody key={project.projectId} projectId={project.projectId} fetchImpl={fetchImpl} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
