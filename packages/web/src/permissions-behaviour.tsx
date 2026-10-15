import { ENSO_AUTO_AUTHORIZER } from '@enso/core'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { PAGE_BUTTON, PAGE_INPUT, PAGE_OUTLINE_BUTTON, SUB_TITLE } from './page-styles.ts'

/**
 * Settings › Permissions' Behaviour part (#935): every key of `permissions.json` beside the rules,
 * one control each, edited on the section's draft and saved with the rules — one Save for the file,
 * under the same ETag. The engine's schema (`@gotgenes/pi-permission-system`) names the keys, their
 * defaults and their bounds; a value it refuses is refused on save, with nothing written.
 *
 * ⚠ YOLO MODE ON IS CONFIRMED FIRST: it turns every Ask into an Allow, in every thread and every
 * subagent. And a run already going keeps auto-approving until its next prompt after it is turned
 * off (#514): the engine reads the knobs when a prompt starts, so the toggle says so.
 *
 * `shellTools` stays in the file (its shape is the engine's); the terminal-only and deprecated keys
 * are shown, read-only, in closed disclosures.
 */

/** A page's quiet line under a title: the prototype's `.page-note`. */
const PAGE_NOTE = 'text-sm text-muted-foreground'

/** Where the yoloMode row is, for the callout under the lede to take the reader to. */
export const YOLO_ROW_ID = 'permissions-behaviour-yoloMode'

const YOLO_ON_WORDS = 'Every Ask becomes Allow — in every thread and every subagent.'
const YOLO_RUNNING_WORDS =
  'Turned off, a run already going keeps auto-approving until its next prompt: the engine reads this when a prompt starts.'

interface ToggleKey {
  readonly key: string
  readonly label: string
  readonly words: string
  readonly fallback: boolean
}

const TOGGLES: readonly ToggleKey[] = [
  {
    key: 'permissionReviewLog',
    label: 'review log',
    words: 'Write every permission request and decision to the review log.',
    fallback: true,
  },
  {
    key: 'debugLog',
    label: 'debug log',
    words: "Write the permission system's verbose diagnostics to its logs.",
    fallback: false,
  },
]

interface NumberKey {
  readonly key: string
  readonly label: string
  readonly words: string
  readonly unit: string
  readonly fallback: number
}

const NUMBERS: readonly NumberKey[] = [
  {
    key: 'forwardingTimeoutMs',
    label: 'forwarding timeout',
    words: "How long a subagent waits for the parent thread's answer to a forwarded ask.",
    unit: 'ms',
    fallback: 600_000,
  },
  {
    key: 'promptMaxRows',
    label: 'prompt rows',
    words: 'The most rows a permission prompt shows before eliding its evidence.',
    unit: 'rows',
    fallback: 24,
  },
  {
    key: 'promptFieldMaxWidth',
    label: 'prompt field width',
    words: 'The most characters of any one field a permission prompt shows.',
    unit: 'characters',
    fallback: 400,
  },
  {
    key: 'reviewLogFieldMaxWidth',
    label: 'review log field width',
    words: 'The most characters of any one value written to the review log.',
    unit: 'characters',
    fallback: 1000,
  },
]

/** Keys only a terminal (TUI) session reads: shown, never edited here. */
const TERMINAL_ONLY: readonly string[] = ['doublePressToConfirm', 'promptNotifications', 'permissionDialogKeys']

/** Keys the engine accepts and ignores: shown, never edited here. */
const DEPRECATED: readonly string[] = ['toolInputPreviewMaxLength', 'toolTextSummaryMaxLength']

/** A key's value as the file holds it, in its words; `not set` when the engine's default is in force. */
function valueWords(file: Readonly<Record<string, unknown>>, key: string): string {
  return Object.hasOwn(file, key) ? JSON.stringify(file[key]) : 'not set'
}

function Switch({
  on,
  labelledBy,
  onChange,
}: {
  on: boolean
  labelledBy: string
  onChange: (on: boolean) => void
}): React.ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!on)}
      className="group relative mt-0.5 h-6 w-10 shrink-0 rounded-full bg-border-strong transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-checked:bg-primary"
    >
      <span
        aria-hidden="true"
        className="absolute top-0.75 left-0.75 size-4.5 rounded-full bg-foreground transition-transform group-aria-checked:translate-x-4 group-aria-checked:bg-primary-foreground"
      />
    </button>
  )
}

/** "Remove from the file — use the default", while the file names the key. */
function UseDefault({
  file,
  name,
  label,
  onSet,
}: {
  file: Readonly<Record<string, unknown>>
  name: string
  label: string
  onSet: (key: string, value: unknown) => void
}): React.ReactNode {
  if (!Object.hasOwn(file, name)) return null
  return (
    <button
      type="button"
      aria-label={`use the default ${label}`}
      className="justify-self-start text-xs text-muted-foreground underline underline-offset-3 hover:text-foreground"
      onClick={() => onSet(name, undefined)}
    >
      Remove from the file — use the default
    </button>
  )
}

/** One row: its title and words on the left, its control on the right, the key under them. */
function Row({
  name,
  label,
  title,
  words,
  control,
  children,
  rowId,
}: {
  name: string
  label: string
  title: React.ReactNode
  words: React.ReactNode
  control?: React.ReactNode
  children?: React.ReactNode
  rowId?: string
}): React.ReactNode {
  return (
    <div
      id={rowId}
      tabIndex={rowId === undefined ? undefined : -1}
      aria-label={label}
      className="grid gap-2 p-4 outline-none not-first:border-t focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="flex items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span id={`behaviour-${name}`} className="font-semibold first-letter:uppercase">
            {title}
          </span>
          <p className={PAGE_NOTE}>{words}</p>
          <code className="font-mono text-meta text-muted-foreground">{name}</code>
        </div>
        {control}
      </div>
      {children}
    </div>
  )
}

function YoloRow({
  file,
  onSet,
}: {
  file: Readonly<Record<string, unknown>>
  onSet: (key: string, value: unknown) => void
}): React.ReactNode {
  const [confirming, setConfirming] = useState(false)
  const on = file.yoloMode === true
  return (
    <Row
      name="yoloMode"
      label="yolo mode"
      rowId={YOLO_ROW_ID}
      title={<span className={on ? 'text-refuse' : undefined}>{on ? 'Yolo mode is on' : 'Yolo mode'}</span>}
      words={
        <>
          {YOLO_ON_WORDS} {YOLO_RUNNING_WORDS}
        </>
      }
      control={
        <Switch
          on={on}
          labelledBy="behaviour-yoloMode"
          onChange={(next) => (next ? setConfirming(true) : onSet('yoloMode', false))}
        />
      }
    >
      {confirming && !on ? (
        <div
          role="group"
          aria-label="confirm yolo mode"
          className="grid gap-3 rounded-sm border border-refuse bg-card p-3"
        >
          <p className="text-sm text-refuse">
            Turn yolo mode on? {YOLO_ON_WORDS} Nothing in the rules above that asks will ask.
          </p>
          <span className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              className={PAGE_BUTTON}
              onClick={() => {
                setConfirming(false)
                onSet('yoloMode', true)
              }}
            >
              Turn yolo mode on
            </Button>
            <Button variant="ghost" className={PAGE_BUTTON} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        </div>
      ) : null}
      <UseDefault file={file} name="yoloMode" label="yolo mode" onSet={onSet} />
    </Row>
  )
}

function NumberRow({
  spec,
  file,
  onSet,
}: {
  spec: NumberKey
  file: Readonly<Record<string, unknown>>
  onSet: (key: string, value: unknown) => void
}): React.ReactNode {
  const value = file[spec.key]
  // A value the engine refuses (0, 1.5) is sent as typed: the save is refused, nothing written.
  const change = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const typed = event.target.value.trim()
    if (typed === '') return onSet(spec.key, undefined)
    const parsed = Number(typed)
    onSet(spec.key, Number.isFinite(parsed) ? parsed : typed)
  }
  const field = (
    <Input
      type="number"
      min={1}
      inputMode="numeric"
      aria-label={spec.label}
      placeholder={String(spec.fallback)}
      className={`${PAGE_INPUT} w-32 font-mono`}
      value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
      onChange={change}
    />
  )
  const words = `${spec.words} Empty: the default, ${spec.fallback.toLocaleString('en')} ${spec.unit}.`
  const control = (
    <span className="flex shrink-0 items-center gap-2">
      {field}
      <span className="text-sm text-muted-foreground">{spec.unit}</span>
    </span>
  )
  return <Row name={spec.key} label={spec.label} title={spec.label} words={words} control={control} />
}

interface ListEditorProps {
  readonly name: string
  readonly label: string
  readonly values: readonly string[]
  readonly ordered: boolean
  readonly placeholder: string
  readonly onChange: (next: string[]) => void
}

/** A list of strings: each removable, movable when `ordered`, and a field to add one more. */
function ListEditor(props: ListEditorProps): React.ReactNode {
  const { name, label, values, ordered, placeholder, onChange } = props
  const [typed, setTyped] = useState('')
  const add = (): void => {
    const entry = typed.trim()
    if (entry === '' || values.includes(entry)) return
    onChange([...values, entry])
    setTyped('')
  }
  const move = (from: number, to: number): void => {
    const next = [...values]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    onChange(next)
  }
  return (
    <div className="grid gap-2">
      {values.length === 0 ? (
        <p className={PAGE_NOTE}>None.</p>
      ) : (
        <ol aria-label={label} className="grid gap-1">
          {values.map((listed, itemIndex) => (
            <li key={listed} className="flex items-center gap-1 rounded-sm border bg-background px-2 py-1">
              {ordered ? <span className="w-5 font-mono text-meta text-muted-foreground">{itemIndex + 1}</span> : null}
              <code className="min-w-0 flex-1 font-mono text-sm break-all">{listed}</code>
              {ordered ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`move ${listed} up`}
                    disabled={itemIndex === 0}
                    onClick={() => move(itemIndex, itemIndex - 1)}
                  >
                    <ChevronUpIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`move ${listed} down`}
                    disabled={itemIndex === values.length - 1}
                    onClick={() => move(itemIndex, itemIndex + 1)}
                  >
                    <ChevronDownIcon />
                  </Button>
                </>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`remove ${listed}`}
                onClick={() => onChange(values.filter((_, at) => at !== itemIndex))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <span className="flex flex-wrap gap-2">
        <Input
          aria-label={`add to ${name}`}
          placeholder={placeholder}
          className={`${PAGE_INPUT} min-w-48 flex-1 font-mono`}
          value={typed}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTyped(event.target.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') add()
          }}
        />
        <Button variant="outline" className={PAGE_OUTLINE_BUTTON} disabled={typed.trim() === ''} onClick={add}>
          Add
        </Button>
      </span>
    </div>
  )
}

/** A row whose key is a list of strings: its editor, and the way back to the engine's default. */
function ListRow(props: {
  readonly name: string
  readonly label: string
  readonly words: string
  readonly ordered: boolean
  readonly placeholder: string
  readonly file: Readonly<Record<string, unknown>>
  readonly onSet: (key: string, value: unknown) => void
}): React.ReactNode {
  const { name, label, file, onSet } = props
  return (
    <Row name={name} label={label} title={label} words={props.words}>
      <ListEditor
        name={name}
        label={`${label} list`}
        values={stringsOf(file[name])}
        ordered={props.ordered}
        placeholder={props.placeholder}
        onChange={(next) => onSet(name, next)}
      />
      <UseDefault file={file} name={name} label={label} onSet={onSet} />
    </Row>
  )
}

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((listed): listed is string => typeof listed === 'string') : []

/** The read-only keys of one kind, in a closed disclosure. */
function ReadOnlyKeys({
  title,
  words,
  keys,
  file,
}: {
  title: string
  words: string
  keys: readonly string[]
  file: Readonly<Record<string, unknown>>
}): React.ReactNode {
  return (
    <details className="group rounded-lg border bg-card">
      <summary className="cursor-pointer px-4 py-3 font-semibold">{title}</summary>
      <div className="grid gap-2 border-t px-4 py-3">
        <p className={PAGE_NOTE}>{words}</p>
        <dl className="grid gap-y-1 text-sm">
          {keys.map((key) => (
            <div key={key} className="flex flex-wrap gap-x-4">
              <dt className="font-mono text-meta">{key}</dt>
              <dd className="font-mono text-meta break-all text-muted-foreground">{valueWords(file, key)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  )
}

/**
 * The Behaviour part. `file` is the file as the draft makes it (`withSettings` over the read);
 * `onSet` sets a key, or takes it off with `undefined`.
 */
export function BehaviourPart({
  file,
  path,
  onSet,
}: {
  file: Readonly<Record<string, unknown>>
  path: string
  onSet: (key: string, value: unknown) => void
}): React.ReactNode {
  const chain = stringsOf(file.authorizerChain)
  return (
    <div className="grid gap-3">
      <h3 className={SUB_TITLE}>Behaviour</h3>
      <p className={PAGE_NOTE}>
        Everything else in <code className="font-mono">{path}</code>. Saved together with the rules.
      </p>
      <div className="rounded-lg border bg-card">
        <YoloRow file={file} onSet={onSet} />
        <ListRow
          name="authorizerChain"
          label="authorizer chain"
          words={
            chain.includes(ENSO_AUTO_AUTHORIZER)
              ? 'The links an ask passes through, in order, before it reaches you. Enso’s classifier is what auto mode decides with.'
              : "The links an ask passes through, in order, before it reaches you. It does not name Enso's classifier, so auto mode asks you."
          }
          ordered={true}
          placeholder="a link's name"
          file={file}
          onSet={onSet}
        />
        {TOGGLES.map((toggle) => (
          <Row
            key={toggle.key}
            name={toggle.key}
            label={toggle.label}
            title={toggle.label}
            words={`${toggle.words} Default: ${toggle.fallback ? 'on' : 'off'}.`}
            control={
              <Switch
                on={typeof file[toggle.key] === 'boolean' ? file[toggle.key] === true : toggle.fallback}
                labelledBy={`behaviour-${toggle.key}`}
                onChange={(next) => onSet(toggle.key, next)}
              />
            }
          >
            <UseDefault file={file} name={toggle.key} label={toggle.label} onSet={onSet} />
          </Row>
        ))}
        <ListRow
          name="piInfrastructureReadPaths"
          label="infrastructure read paths"
          words="More directories pi may read as its own infrastructure, past the outside-the-project gate. ~ and wildcards (* ?) work."
          ordered={false}
          placeholder="~/tools/pi-extras"
          file={file}
          onSet={onSet}
        />
        {NUMBERS.map((spec) => (
          <NumberRow key={spec.key} spec={spec} file={file} onSet={onSet} />
        ))}
        <Row
          name="shellTools"
          label="shell tools"
          title="Shell tools"
          words="Tools other than bash that run shell commands. Edited in the file: its shape is the engine's."
        >
          <code className="font-mono text-meta break-all text-muted-foreground">{valueWords(file, 'shellTools')}</code>
        </Row>
      </div>
      <ReadOnlyKeys
        title="Terminal only"
        words="Read by pi's terminal prompt, never by Enso's page. Change them in the file."
        keys={TERMINAL_ONLY}
        file={file}
      />
      <ReadOnlyKeys
        title="Deprecated"
        words="Accepted and ignored by the engine; remove them from the file."
        keys={DEPRECATED}
        file={file}
      />
    </div>
  )
}
