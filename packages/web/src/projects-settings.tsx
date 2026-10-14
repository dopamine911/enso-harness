import type {
  EnsoDefaultProjectTrust,
  EnsoProject,
  EnsoProjectsSettingsRead,
  EnsoProjectsSettingsWrite,
  EnsoThreadTreeMode,
} from '@enso/core'
import { TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { FieldError } from './components/ui/field.tsx'
import { Textarea } from './components/ui/textarea.tsx'
import { cn } from './lib/utils.ts'
import { OptionSelect } from './option-select.tsx'
import { PAGE_BUTTON, PAGE_INPUT, SUB_TITLE } from './page-styles.ts'
import { linesOf } from './project-worktrees.tsx'
import { fetchProjectsSettings, saveDefaultProjectTrust, saveProjectsSettings } from './projects-settings-connection.ts'
import {
  ConflictNotice,
  LooseningConfirm,
  SaveBar,
  SettingRow,
  SettingsFileSection,
  SourceLine,
  useSending,
} from './settings-rows.tsx'

/**
 * Settings › Projects & threads (#934): your defaults for every project. `config.json`'s user-only
 * `projects.roots` (the fence a project must sit under) and the user tier of `threads` — a new
 * thread's tree mode, its setup commands and files to copy, and a project's own mode — one control
 * per key, each named by its file and key and default, with one Save for the file. A project's
 * Worktrees tab shows which tier each value comes from, and can override it. The trust an undecided
 * project gets is pi's `defaultProjectTrust`, in pi's own file: set on its own.
 *
 * ⚠ SETUP COMMANDS RUN ON THIS MACHINE, in every new tree: the field says so, as the project tab does.
 */

const PAGE_NOTE = 'text-sm text-muted-foreground'

/** A mode as the select names it; `''` is "not in the file". */
type ModeChoice = EnsoThreadTreeMode | ''

const TREE_MODES: ReadonlyArray<readonly [EnsoThreadTreeMode, string]> = [
  ['worktree', 'worktree — a tree of its own'],
  ['copy', 'copy — a copy of the project folder'],
  ['off', 'off — in the project folder itself'],
]

const TRUST_CHOICES: ReadonlyArray<readonly [EnsoDefaultProjectTrust, string]> = [
  ['ask', 'Ask at its first run (the default)'],
  ['always', 'Trust it'],
  ['never', 'Don’t trust it'],
]

/** The page's form of both sections: every value as typed, `''` meaning "not in the file". */
interface Draft {
  readonly roots: string
  readonly tree: ModeChoice
  readonly setup: string
  readonly copy: string
  /** A project's own mode, by canonical path (the server answers each key so): only the paths that have one. */
  readonly projectModes: Readonly<Record<string, EnsoThreadTreeMode>>
}

type FieldName = 'roots' | 'tree' | 'setup' | 'copy' | 'projectModes'

const FIELD_LABELS: Readonly<Record<FieldName, string>> = {
  roots: 'Project roots',
  tree: 'New threads run in',
  setup: 'Setup commands',
  copy: 'Files to copy into a new tree',
  projectModes: 'A project’s own mode',
}

const ALL_FIELDS: readonly FieldName[] = ['roots', 'tree', 'setup', 'copy', 'projectModes']

const fieldId = (field: FieldName): string => `projects-settings-${field}`

function draftOf(settings: Extract<EnsoProjectsSettingsRead, { kind: 'ok' }>): Draft {
  const { threads } = settings
  return {
    roots: (settings.projects?.roots ?? []).join('\n'),
    tree: threads.tree ?? '',
    setup: (threads.setup ?? []).join('\n'),
    copy: (threads.copy ?? []).join('\n'),
    projectModes: threads.projects ?? {},
  }
}

/** Both sections as the file will hold them; the server drops what is empty. */
function writeOf(draft: Draft): EnsoProjectsSettingsWrite {
  const roots = linesOf(draft.roots)
  return {
    ...(roots.length === 0 ? {} : { projects: { roots } }),
    threads: {
      ...(draft.tree === '' ? {} : { tree: draft.tree }),
      setup: linesOf(draft.setup),
      copy: linesOf(draft.copy),
      projects: draft.projectModes,
    },
  }
}

/** A root the server would refuse at its next start: neither absolute nor `~/`. */
function rootsProblem(draft: Draft): string | undefined {
  const bad = linesOf(draft.roots).find((root) => !root.startsWith('/') && !root.startsWith('~/'))
  return bad === undefined ? undefined : `${bad} is neither an absolute path nor ~/: the server would not start with it`
}

function unsavedField(draft: Draft, saved: Draft, field: FieldName): boolean {
  if (field === 'tree') return draft.tree !== saved.tree
  // As a set of entries: a mode set and set back is moved to the end, not changed.
  if (field === 'projectModes') {
    const entries = (modes: Draft['projectModes']): string =>
      JSON.stringify(Object.entries(modes).toSorted(([one], [other]) => one.localeCompare(other)))
    return entries(draft.projectModes) !== entries(saved.projectModes)
  }
  return JSON.stringify(linesOf(draft[field])) !== JSON.stringify(linesOf(saved[field]))
}

/** A list key's row: one entry per line, where it lives, and a notice over the box when it needs one. */
function ListRow(props: {
  readonly field: 'roots' | 'setup' | 'copy'
  readonly help: string
  readonly file: string
  readonly keyPath: string
  readonly value: string
  readonly saved: string
  readonly placeholder: string
  readonly problem?: string | undefined
  readonly notice?: React.ReactNode
  readonly onChange: (value: string) => void
}): React.ReactNode {
  const id = fieldId(props.field)
  const set = linesOf(props.value).length > 0
  return (
    <SettingRow
      id={id}
      label={FIELD_LABELS[props.field]}
      stacked
      help={props.help}
      problem={props.problem}
      source={
        <SourceLine
          file={props.file}
          keyPath={props.keyPath}
          set={set}
          defaultText={props.field === 'roots' ? 'no fence' : 'none'}
          unsaved={JSON.stringify(linesOf(props.value)) !== JSON.stringify(linesOf(props.saved))}
        />
      }
    >
      {props.notice}
      <Textarea
        id={id}
        spellCheck={false}
        aria-invalid={props.problem !== undefined}
        aria-describedby={`${id}-help${props.problem === undefined ? '' : ` ${id}-error`}`}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value)}
        className={cn(PAGE_INPUT, 'min-h-24 resize-y font-mono leading-relaxed')}
      />
    </SettingRow>
  )
}

/** Said before trusting every undecided project: the one trust choice that protects less (#979 review). */
const TRUST_ALWAYS_LOOSENS = 'Every project you add will run its own extensions and setup commands without asking.'

/**
 * The trust an undecided project gets: pi's own key in pi's file, so it has its own Set. A project
 * decided on its page or in a thread keeps that decision whatever this says. Trusting them all
 * protects less, so it is confirmed first, as Security's loosenings are; a file pi cannot read is
 * said, and not set.
 */
function DefaultTrust(props: {
  readonly value: EnsoDefaultProjectTrust
  readonly trustPath: string
  readonly unreadable: string | undefined
  readonly fetchImpl: FetchLike | undefined
  readonly onSet: (value: EnsoDefaultProjectTrust) => void
}): React.ReactNode {
  const id = 'projects-settings-trust'
  // Only what the reader picked: until then (and after a Set) the choice is what pi's file holds.
  const [picked, setPicked] = useState<EnsoDefaultProjectTrust | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const choice = picked ?? props.value
  const loosens = choice === 'always' && props.value !== 'always'
  const { working, problem, send } = useSending()
  const set = (): void => {
    setConfirming(false)
    send(saveDefaultProjectTrust(choice, props.fetchImpl), (saved) => {
      setPicked(undefined)
      props.onSet(saved.defaultProjectTrust)
    })
  }
  return (
    <SettingRow
      id={id}
      label="Trust for an undecided project"
      help={
        <>
          A project nobody has trusted or refused yet. Trusted, Enso reads its own files — its <code>.pi/</code>,{' '}
          <code>.enso/config.json</code>, its prompts — including the setup commands it lists. Applies to the next
          thread or project page.
        </>
      }
      source={
        <SourceLine
          file={props.trustPath}
          keyPath="defaultProjectTrust"
          set={props.value !== 'ask'}
          defaultText="ask"
          unsaved={choice !== props.value}
        />
      }
    >
      <span className="flex flex-wrap items-center gap-2 md:justify-end">
        <OptionSelect<EnsoDefaultProjectTrust>
          id={id}
          value={choice}
          options={TRUST_CHOICES}
          onChange={(next) => {
            setPicked(next)
            setConfirming(false)
          }}
          className={PAGE_INPUT}
        />
        <Button
          type="button"
          className={PAGE_BUTTON}
          disabled={working || confirming || choice === props.value || props.unreadable !== undefined}
          onClick={loosens ? () => setConfirming(true) : set}
        >
          Set
        </Button>
      </span>
      {props.unreadable === undefined ? null : (
        <FieldError>
          {props.trustPath} could not be read, so nothing can be set here until the file is fixed: {props.unreadable}
        </FieldError>
      )}
      {confirming ? (
        <LooseningConfirm
          loosenings={[TRUST_ALWAYS_LOOSENS]}
          working={working}
          onConfirm={set}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
      {loosens && !confirming ? (
        <p role="note" className="flex items-start gap-2 rounded-sm border border-chart-3 p-3 text-sm">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-chart-3" />
          {TRUST_ALWAYS_LOOSENS}
        </p>
      ) : null}
      {problem === undefined ? null : <FieldError>{problem}</FieldError>}
    </SettingRow>
  )
}

/** Each project's own mode: the page's projects, then any path the file names that is not one of them. */
function ProjectModes({
  modes,
  projects,
  onChange,
}: {
  modes: Readonly<Record<string, EnsoThreadTreeMode>>
  projects: readonly EnsoProject[]
  onChange: (modes: Readonly<Record<string, EnsoThreadTreeMode>>) => void
}): React.ReactNode {
  const known = new Set(projects.map((project) => project.path))
  const rows = [
    ...projects.map((project) => ({ path: project.path, title: project.title })),
    ...Object.keys(modes)
      .filter((path) => !known.has(path))
      .map((path) => ({ path, title: undefined })),
  ]
  const choose = (path: string, mode: ModeChoice): void => {
    const { [path]: _was, ...others } = modes
    onChange(mode === '' ? others : { ...others, [path]: mode })
  }
  return (
    <ul id={fieldId('projectModes')} className="grid gap-2">
      {rows.map(({ path, title }) => (
        <li key={path} className="grid items-center gap-x-3 gap-y-1 md:grid-cols-setting-row">
          <span className="grid min-w-0">
            <span className="text-sm font-medium">{title ?? 'not one of your projects'}</span>
            <span className="truncate font-mono text-meta text-muted-foreground" title={path}>
              {path}
            </span>
          </span>
          <OptionSelect<ModeChoice>
            label={`${title ?? path}: new threads run in`}
            value={modes[path] ?? ''}
            options={[['', 'Your default above'], ...TREE_MODES]}
            onChange={(mode) => choose(path, mode)}
            className={PAGE_INPUT}
          />
        </li>
      ))}
    </ul>
  )
}

type SaveProblem =
  | { readonly kind: 'roots'; readonly detail: string }
  | { readonly kind: 'conflict'; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'unavailable'; readonly detail: string }

/** The form over a readable file. */
function ProjectsForm({
  settings,
  projects,
  onSaved,
  onReload,
  fetchImpl,
}: {
  settings: Extract<EnsoProjectsSettingsRead, { kind: 'ok' }>
  projects: readonly EnsoProject[]
  onSaved: (settings: EnsoProjectsSettingsRead) => void
  onReload: () => void
  fetchImpl: FetchLike | undefined
}): React.ReactNode {
  const saved = draftOf(settings)
  const [draft, setDraft] = useState<Draft>(saved)
  const [problem, setProblem] = useState<SaveProblem | undefined>(undefined)
  const [working, setWorking] = useState(false)
  const unsaved = (field: FieldName): boolean => unsavedField(draft, saved, field)
  const dirtyKeys = ALL_FIELDS.filter(unsaved)
  const save = (): void => {
    const roots = rootsProblem(draft)
    if (roots !== undefined) {
      setProblem({ kind: 'roots', detail: roots })
      document.getElementById(fieldId('roots'))?.focus()
      return
    }
    setWorking(true)
    void saveProjectsSettings(writeOf(draft), settings.etag, fetchImpl).then((outcome) => {
      setWorking(false)
      if (outcome.kind === 'saved') {
        setProblem(undefined)
        onSaved(outcome.settings)
        return
      }
      setProblem(outcome)
    })
  }
  const list = (
    field: 'roots' | 'setup' | 'copy',
  ): Pick<Parameters<typeof ListRow>[0], 'field' | 'file' | 'value' | 'saved' | 'onChange'> => ({
    field,
    file: settings.path,
    value: draft[field],
    saved: saved[field],
    onChange: (value: string) => setDraft({ ...draft, [field]: value }),
  })
  return (
    <>
      <div className="grid gap-3">
        <h3 className={SUB_TITLE}>Projects</h3>
        <p className={PAGE_NOTE}>Roots apply from the server’s next start; trust from the next thread.</p>
        <div className="rounded-lg border bg-card">
          <ListRow
            {...list('roots')}
            keyPath="projects.roots"
            help="The folders a project must sit inside, one per line — absolute, or ~/ for your home folder. Only your own file can set them: a project can’t widen them. Default: any folder that passes Enso’s standing checks (not your home folder itself, not Enso’s own, not a hidden one unless you ask)."
            placeholder="~/code"
            problem={problem?.kind === 'roots' ? problem.detail : undefined}
          />
          <DefaultTrust
            value={settings.defaultProjectTrust}
            trustPath={settings.trustPath}
            unreadable={settings.trustUnreadable}
            fetchImpl={fetchImpl}
            onSet={(defaultProjectTrust) => onSaved({ ...settings, defaultProjectTrust })}
          />
        </div>
      </div>
      <div className="grid gap-3">
        <h3 className={SUB_TITLE}>A new thread’s tree</h3>
        <p className={PAGE_NOTE}>
          Your tier: over Enso’s defaults, under a project’s own files. Read at every new tree — a thread already
          running keeps its tree.
        </p>
        <div className="rounded-lg border bg-card">
          <SettingRow
            id={fieldId('tree')}
            label={FIELD_LABELS.tree}
            help="A tree keeps a thread’s edits out of your checkout until you bring them back. Off runs the thread in the project folder: no tree, and no file restore."
            source={
              <SourceLine
                file={settings.path}
                keyPath="threads.tree"
                set={draft.tree !== ''}
                defaultText="worktree"
                unsaved={unsaved('tree')}
              />
            }
          >
            <OptionSelect<ModeChoice>
              id={fieldId('tree')}
              value={draft.tree}
              options={[['', 'Default — worktree'], ...TREE_MODES]}
              onChange={(tree) => setDraft({ ...draft, tree })}
              className={PAGE_INPUT}
            />
          </SettingRow>
          <ListRow
            {...list('setup')}
            keyPath="threads.setup"
            help="One command per line, run in order in a new tree — for example bun install --frozen-lockfile."
            placeholder="bun install --frozen-lockfile"
            notice={
              // The project tab's warning callout (#417): these commands run on this machine.
              <p role="note" className="flex items-start gap-2 rounded-sm border border-chart-3 p-3 text-sm">
                <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-chart-3" />
                These run on your machine, in the new tree, each time a thread's tree is made — in every project that
                doesn’t set its own.
              </p>
            }
          />
          <ListRow
            {...list('copy')}
            keyPath="threads.copy"
            help="One path per line, relative to the project — for gitignored files a new tree needs, such as .env."
            placeholder=".env"
          />
          <SettingRow
            id={fieldId('projectModes')}
            label={FIELD_LABELS.projectModes}
            labelled
            stacked
            help="Your own mode for one project, over your default above — for a checkout too big to copy. A trusted project’s own files still win."
            source={
              <SourceLine
                file={settings.path}
                keyPath="threads.projects"
                set={Object.keys(draft.projectModes).length > 0}
                defaultText="none"
                unsaved={unsaved('projectModes')}
              />
            }
          >
            <ProjectModes
              modes={draft.projectModes}
              projects={projects}
              onChange={(projectModes) => setDraft({ ...draft, projectModes })}
            />
          </SettingRow>
        </div>
      </div>
      {problem?.kind === 'conflict' ? (
        <ConflictNotice detail={problem.detail} working={working} onReload={onReload} />
      ) : null}
      {problem?.kind === 'refused' || problem?.kind === 'unavailable' ? (
        <FieldError>Nothing was saved: {problem.detail}</FieldError>
      ) : null}
      <SaveBar
        dirtyLabels={dirtyKeys.map((field) => FIELD_LABELS[field])}
        path={settings.path}
        disabled={working}
        onDiscard={() => {
          setDraft(saved)
          setProblem(undefined)
        }}
        onSave={save}
      />
    </>
  )
}

/** Settings' Projects & threads section. */
export function ProjectsSection({
  fetch: fetchImpl,
  projects,
}: {
  fetch: FetchLike | undefined
  /** The page's projects: each one's own mode is chosen beside its name. */
  projects: readonly EnsoProject[]
}): React.ReactNode {
  return (
    <SettingsFileSection
      fetchImpl={fetchImpl}
      read={fetchProjectsSettings}
      name="Projects & threads"
      intro="Your defaults for every project. Each project’s page shows which tier a value comes from, and can override it."
      consequence="Everything that reads it fails closed, and the server will not start again until it is fixed."
      form={(settings, replace, reload) => (
        // Setting the trust keeps the file's version, so an unsaved draft survives it.
        <ProjectsForm
          settings={settings}
          projects={projects}
          onSaved={replace}
          onReload={reload}
          fetchImpl={fetchImpl}
        />
      )}
    />
  )
}
