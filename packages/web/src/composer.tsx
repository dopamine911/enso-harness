import {
  ENSO_CONTEXT_COMMAND,
  ENSO_FORK_COMMAND,
  ENSO_IMAGE_MAX_BYTES,
  ENSO_IMAGE_MIME_TYPES,
  ENSO_NOTICE_SOURCE,
  ENSO_PROMPT_MAX_IMAGES,
  type EnsoPromptImage,
  isEnsoImageMimeType,
  type RuntimeCommand,
} from '@enso/core'
import type { ContentPart } from '@tanstack/ai'
import { ArrowUpIcon, PaperclipIcon, SquareIcon, TriangleAlertIcon } from 'lucide-react'
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRereadAfterCompaction } from './branch-reread.ts'
import { type ChoiceHandlers, CommandPalette, runTypedHostCommand, typedCommandName } from './command-palette.tsx'
import { fetchThreadCommands } from './commands-connection.ts'
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from './components/ai-elements/attachments.tsx'
import {
  PromptInput,
  PromptInputButton,
  type PromptInputError,
  type PromptInputMessage,
  PromptInputTextarea,
  usePromptInputAttachments,
} from './components/ai-elements/prompt-input.tsx'
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
  Queue as QueueShell,
} from './components/ai-elements/queue.tsx'
import { Button } from './components/ui/button.tsx'
import { ForkContext } from './fork-thread.ts'
import { useLaunchProject } from './launch-panel.tsx'
import {
  isSlashPrompt,
  LaunchChips,
  type LaunchForm,
  LaunchNotes,
  SLASH_PROMPT_REFUSAL,
  useLaunchForm,
  useLaunching,
} from './launch-settings.tsx'
import { cn } from './lib/utils.ts'
import {
  EffortChip,
  ModelChip,
  ModelChoiceDialog,
  type ModelChoiceDialogProps,
  useModelState,
  useRecordedModel,
} from './model-state.tsx'
import type { NotificationsStore } from './notifications.tsx'
import { useRecentModels } from './page-listings.ts'
import { useChatContext, PaneViewContext } from './pane-context.ts'
import { ModeChip, usePermissionMode } from './permission-mode.tsx'
import { COMPOSER_ICON_BUTTON, LockedChip } from './setting-chip.tsx'
import { useStore, useThreadStores } from './store.ts'
import { systemPromptName } from './thread-context-analysis.ts'
import { ThreadContextDialog } from './thread-context.tsx'

/**
 * A thread's composer (#90): the prompt form, its chips (model, effort, mode, the locked system
 * prompt — #878), the `/` palette (#338), stop (#116), and pi's queue above it (#75) — and, before
 * its session starts, the launch panel's form (#877): the settings chips, the prompt, and Start
 * session. Application-owned, per the deprecation notice on TanStack's `ChatInput`.
 */

/**
 * The composer's Mode chip (#84, #878): the thread's current mode, and the list that switches it
 * through the mode route (L3 step C) — a control, not a prompt. In the composer rather than in the
 * page header (#90 PR 3): it is per THREAD, and deepseek-harness keeps the mode selector in the
 * composer chrome for the same reason.
 *
 * ⚠ `POST …/mode`, never a prompt: the browser says a mode; how the host's extension is
 * told is the host's (its per-mode command, #496). The chip then updates from the
 * `permission-mode` receipt the host emits once the mode is persisted — the mode actually set —
 * never from the click, and that receipt is what writes the thread's "Mode: …" line
 * (`mode-lines.ts`), whichever mode was chosen. Invariant 2: a route tells pi; the feed ends the story.
 *
 * ⓘ Offered while a run is in flight too (#618): a run that asks before every call is the one
 * a user most needs to change, and the change governs its next tool call (`changeThreadMode`).
 */
function PermissionModeControl(): React.ReactNode {
  const stores = useThreadStores()
  const { mode, available } = usePermissionMode()
  return (
    <ModeChip mode={mode} available={available} onSelect={(next: string) => void stores.connection.changeMode(next)} />
  )
}

/** What the locked System prompt chip says when pressed (#878). */
const SYSTEM_PROMPT_FIXED =
  'Fixed for this session: pi was given this system prompt when the session started. Start a new thread to use another.'

/**
 * The session's system prompt, locked (#878): pi takes one only before its first request (#443),
 * so once the session started the chip names it and says why it cannot be chosen. It names what
 * the thread reports (`ThreadStores.systemPrompt`: the branch's record), so a reload says it too.
 */
function SessionSystemPromptChip(): React.ReactNode {
  const prompt = useStore(useThreadStores().systemPrompt)
  return (
    <LockedChip
      label="System prompt"
      display={prompt === undefined ? 'not known yet' : systemPromptName(prompt)}
      explanation={SYSTEM_PROMPT_FIXED}
    />
  )
}

/**
 * Ask the server what a fresh thread starts in, so the mode — the docked composer's control, the
 * launch panel's Mode chip (#877) — reads `default` from the first paint rather than `unknown` until
 * the first run. In fixture mode there is no server; the fetch fails and the store honestly stays
 * `unknown`.
 */
function useFreshThreadMode(): void {
  const stores = useThreadStores()
  useEffect(() => {
    void stores.permissionMode.seed(async () => (await stores.fetch('/api/mode')).json())
  }, [stores])
}

/**
 * The composer's model controls (#338 slice 2, the control half of #44): the model chip and the
 * Effort chip (#878), both reading the thread's model store, both changing it through
 * `POST …/command` — a control, not a prompt, like the Mode chip beside them. The model chip opens
 * the model dialog the owner renders (`onOpenModelDialog`), the same one the palette's `/model`
 * row opens. ⚠ NOT disabled while a run is in flight or before the first run: pi takes a model
 * change between turns, the route answers 409 while busy and the refusal is said as a notice —
 * and choosing before the first prompt is the point (#341, `model-state.tsx`'s header).
 */
function ModelControls({
  host: { onHost, onOpenModelDialog },
  pickerOpen,
  chipRef,
}: {
  readonly host: HostCommandHandlers
  /** The model picker is open: its chip is drawn open. */
  readonly pickerOpen: boolean
  /** The Model chip, which the picker hangs from (#417). */
  readonly chipRef: React.RefObject<HTMLButtonElement | null>
}): React.ReactNode {
  const state = useModelState()
  const recorded = useRecordedModel()
  return (
    <>
      <ModelChip
        ref={chipRef}
        state={state}
        recorded={recorded}
        onOpen={(): void => onOpenModelDialog('model')}
        open={pickerOpen}
      />
      <EffortChip state={state} onSelect={(level: string): void => onHost('thinking', level)} />
    </>
  )
}

/** The composer's host-command dialog (#338), its model picker's Recent group read from the stored sessions (#880). */
function ComposerModelDialog(props: Omit<ModelChoiceDialogProps, 'recent'>): React.ReactNode {
  return <ModelChoiceDialog {...props} recent={useRecentModels()} />
}

/** How a `host` command is run and how the model dialog is opened — the composer's, handed to its chrome and palette. */
interface HostCommandHandlers {
  readonly onHost: (commandName: string, optionId?: string) => void
  /** Open the dialog for a `select` host command, by name. */
  readonly onOpenModelDialog: (commandName: string) => void
  /** Open the view a `view` host command names (`/context`, #361), by name. */
  readonly onOpenView: (commandName: string) => void
}

/**
 * The palette's handlers, built from the composer's — ONE object, so a row chosen in the palette
 * and the same command typed bare (#388) are routed by the same code.
 */
function paletteHandlers(
  host: HostCommandHandlers,
  onRun: (commandName: string) => void,
  onInsert: (commandName: string) => void,
): ChoiceHandlers {
  return {
    onRun,
    onInsert,
    onHost: host.onHost,
    onOpenModelDialog: (command: RuntimeCommand): void => host.onOpenModelDialog(command.name),
    onOpenView: (command: RuntimeCommand): void => host.onOpenView(command.name),
  }
}

/** The composer's draft with more text appended — restored prompts after what was already typed, one blank line between. */
function joinDrafts(current: string, ...more: readonly string[]): string {
  return [current, ...more].filter((part) => part.trim().length > 0).join('\n\n')
}

/** What the form would not take, as the notice says it (#68): how many, and the cap by name — never a silent drop. */
export function describeAttachmentError(error: PromptInputError): string {
  const files = error.count === 1 ? '1 file was' : `${error.count} files were`
  switch (error.code) {
    case 'accept':
      return `${files} not attached: only images are attached here (${ENSO_IMAGE_MIME_TYPES.map((mimeType) => mimeType.slice('image/'.length)).join(', ')})`
    case 'max_file_size':
      return `${files} not attached: an image is at most ${(ENSO_IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB`
    case 'max_files':
      return `${files} not attached: at most ${ENSO_PROMPT_MAX_IMAGES} images on one prompt`
  }
}

/**
 * Stop, while there is something to stop (#116): a run in flight, or a login waiting on its
 * provider (#348). Through the thread's connection — `POST …/abort`. ⚠ NOT `chat.stop()`: that
 * aborts this client's POST, which returned at admission, and touches nothing on the server. What
 * it stopped ends on the follow (`settled` and `status` for a run; `login` and the cancel's line
 * for a login), so this button changes nothing itself; the feed does. The run flag is
 * `sessionGenerating`, the shared one — `isLoading` never rises here (#103). A login holds
 * no run lease, so it has its own flag, `stores.login`. Not offered once the follow has ended
 * (#119): the flags are then as of that moment, and a stop that may stop nothing is issue #4's
 * shape — `docs/architecture.md`, The control plane, invariant 5.
 */
function StopControl({
  running,
  disconnected,
  onStop,
}: {
  running: boolean
  disconnected: boolean
  onStop: () => void
}): React.ReactNode {
  const login = useStore(useThreadStores().login)
  if (disconnected || !(running || login !== undefined)) return null
  const stopsLogin = !running && login !== undefined
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className={STOP_BUTTON}
      aria-label={stopsLogin ? `cancel the login to ${login.provider}` : 'stop the run'}
      title={
        stopsLogin
          ? `cancel the login to ${login.provider} — nothing is stored`
          : 'stop the run in flight — pi is told; the run ends on the feed'
      }
      onClick={onStop}
    >
      <SquareIcon />
    </Button>
  )
}

/**
 * What the composer's body needs while it is the launch panel's form (#877): whether Start may go
 * — the settings read, a project to start in, no Start already out — and whether one is out.
 */
interface LaunchSubmit {
  readonly ready: boolean
  readonly applying: boolean
}

/** The prompt box's invitation on the launch panel (#877). */
const LAUNCH_PLACEHOLDER = "Describe the task — what to change, where, and how you'll know it worked"
/** What the launch panel says under the prompt, until a `/` makes it say why Start waits (#484). */
const LAUNCH_HINT = 'Settings apply together when you start. The system prompt is fixed after that.'
/** The started composer's words while pi runs (#878): a prompt sent now queues (#75). */
const RUNNING_PLACEHOLDER = 'Type the next prompt — it queues until this run ends'
const RUNNING_HINT = 'pi is running · Enter queues · Shift+Enter for a new line'
/** …and while it is idle. */
const IDLE_PLACEHOLDER = 'Ask pi something'
const IDLE_HINT = 'Enter to send · Shift+Enter for a new line'

/** The composer's state as its words read it (#877, #878). */
interface ComposerState {
  readonly launching: boolean
  readonly running: boolean
  /** Nothing can be sent: the page is disconnected, or a resolution ended the thread (#466). */
  readonly closed: boolean
}

/** The hint under the prompt: the launch panel's, or what Enter does now; none while nothing can be sent. */
function hintOf({ launching, running, closed }: ComposerState): string | undefined {
  if (launching) return LAUNCH_HINT
  if (closed) return undefined
  return running ? RUNNING_HINT : IDLE_HINT
}

/**
 * Under the prompt, on the launch panel (#484): why a prompt beginning with `/` cannot start a
 * session — the prototype's `#prompt-error` (#417), in the refusal's colour, above the footer.
 */
function SlashRefusal({ draft, state }: { readonly draft: string; readonly state: ComposerState }): React.ReactNode {
  if (!(state.launching && isSlashPrompt(draft))) return null
  return (
    <p role="alert" className="flex items-center gap-2 px-1 text-detail text-refuse">
      <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {SLASH_PROMPT_REFUSAL}
    </p>
  )
}

/** The footer's left: what Enter does — an empty line when nothing can be sent, still holding the buttons to the right. */
function ComposerHint({ state }: { readonly state: ComposerState }): React.ReactNode {
  return <p className="min-w-0 flex-1 px-1 text-xs text-muted-foreground">{hintOf(state)}</p>
}

/**
 * The submit's face, the prototype's `.button-primary` (#417): the primary, brighter under the
 * pointer; held, the accent with muted words rather than a faded primary.
 */
const SUBMIT_BUTTON =
  'rounded-sm text-sm hover:bg-primary hover:brightness-110 disabled:bg-accent disabled:text-muted-foreground disabled:opacity-100'

/** Stop, the prototype's `.stop-button` (#417): the send button's square, ringed and drawn in the refusal's colour. */
const STOP_BUTTON =
  'size-10 rounded-sm border-refuse bg-transparent text-refuse hover:bg-refuse/10 hover:text-refuse dark:border-refuse dark:bg-transparent dark:hover:bg-refuse/10'

/**
 * The form's submit: Start session on the launch panel — held until the prompt has words that are
 * no `/` command and the settings can go — else Stop while something runs, and Send.
 */
function ComposerSubmit({
  launch,
  draft,
  canSend,
  running,
  disconnected,
  onStop,
}: {
  readonly launch: LaunchSubmit | undefined
  readonly draft: string
  readonly canSend: boolean
  readonly running: boolean
  readonly disconnected: boolean
  readonly onStop: () => void
}): React.ReactNode {
  if (launch !== undefined) {
    const startable = launch.ready && !disconnected && draft.trim().length > 0 && !isSlashPrompt(draft)
    return (
      <Button type="submit" className={cn(SUBMIT_BUTTON, 'h-10 gap-2 px-4 font-semibold')} disabled={!startable}>
        {launch.applying ? 'Starting session…' : 'Start session'}
        <ArrowUpIcon aria-hidden="true" />
      </Button>
    )
  }
  return (
    <>
      <StopControl running={running} disconnected={disconnected} onStop={onStop} />
      {/* Send stays offered in flight: a prompt during a run queues through pi (#75) —
          the form's submit takes the direct route past TanStack's own queue. */}
      <Button
        type="submit"
        size="icon"
        className={cn(SUBMIT_BUTTON, 'size-10')}
        aria-label="send message"
        disabled={!canSend}
      >
        <ArrowUpIcon />
      </Button>
    </>
  )
}

/**
 * The card's top row: the launch panel's settings chips and what they say (#877), or — once the
 * session runs — the same chips (#878): the knobs at the point of use, deepseek's shape — the
 * model, the effort, the mode, and the system prompt, locked. Inside the card, over the prompt, as
 * the prototype draws them (#417).
 */
function ComposerSettings({
  launch,
  host,
  pickerOpen,
  modelChip,
  onSavedPrompt,
}: {
  readonly launch: LaunchForm | undefined
  readonly host: HostCommandHandlers
  /** The started composer's model picker is open. */
  readonly pickerOpen: boolean
  /** The started composer's Model chip, which its picker hangs from. */
  readonly modelChip: React.RefObject<HTMLButtonElement | null>
  readonly onSavedPrompt: (text: string) => void
}): React.ReactNode {
  if (launch !== undefined) {
    return (
      <>
        <LaunchChips form={launch} onSavedPrompt={onSavedPrompt} />
        <LaunchNotes form={launch} />
      </>
    )
  }
  return (
    <div role="group" aria-label="Session settings" className="flex flex-wrap items-center gap-2">
      <ModelControls host={host} pickerOpen={pickerOpen} chipRef={modelChip} />
      <PermissionModeControl />
      <SessionSystemPromptChip />
    </div>
  )
}

/**
 * The composer's attachments as the wire takes them: the form hands back `data:` URLs (blob →
 * FileReader), the wire takes bytes + kind. The form's `accept` already filtered by `File.type`;
 * this is the same set, as a guard rather than a cast, and a miss is counted for the composer to
 * say the same way the form says one.
 */
function imagesOfAttachments(files: PromptInputMessage['files']): { images: EnsoPromptImage[]; notImages: number } {
  const images: EnsoPromptImage[] = []
  let notImages = 0
  for (const file of files) {
    const inline = /^data:([^;,]+);base64,(.*)$/.exec(file.url)
    const mimeType = inline?.[1]
    const data = inline?.[2]
    if (mimeType === undefined || data === undefined || !isEnsoImageMimeType(mimeType)) {
      notImages += 1
      continue
    }
    images.push({ mimeType, data })
  }
  return { images, notImages }
}

/** What the composer's empty box says: why it cannot send, or the invitation — the launch panel's own before a session (#877), then by whether pi runs (#878). */
function composerPlaceholder({
  disconnected,
  ended,
  launching,
  running,
}: {
  readonly disconnected: boolean
  readonly ended: boolean
  readonly launching: boolean
  readonly running: boolean
}): string {
  if (disconnected) return 'disconnected — reload and resume from the rail'
  // A resolution ended the thread (#466): the server refuses a prompt, and a fork goes on.
  if (ended) return 'this thread was ended by an incident resolution — it is read-only; fork it to go on'
  if (launching) return LAUNCH_PLACEHOLDER
  return running ? RUNNING_PLACEHOLDER : IDLE_PLACEHOLDER
}

/** The images attached to the prompt, each with its remove button; nothing when none is. */
function AttachedImages(): React.ReactNode {
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null
  return (
    <Attachments aria-label="attached images" className="px-1 pt-1">
      {attachments.files.map((file) => (
        <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentRemove label={`remove ${file.filename || 'image'}`} />
        </Attachment>
      ))}
    </Attachments>
  )
}

/** The prompt box: a short box in a running thread, a taller one on the launch panel (#877), in the prototype's prompt type (#417). */
function ComposerTextarea({
  draft,
  setDraft,
  textareaRef,
  placeholder,
  launching,
}: {
  draft: string
  setDraft: (next: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  placeholder: string
  launching: boolean
}): React.ReactNode {
  return (
    <PromptInputTextarea
      ref={textareaRef}
      value={draft}
      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
      placeholder={placeholder}
      autoComplete="off"
      rows={launching ? 4 : 2}
      className={cn(
        'max-h-60 min-h-16 resize-none rounded-none border-0 bg-transparent px-1 py-2 text-message shadow-none placeholder:text-muted-foreground focus-visible:ring-0 md:text-message dark:bg-transparent',
        launching && 'min-h-28 text-base md:text-base',
      )}
    />
  )
}

/**
 * Whether the card has just docked — Start went through and the launch panel gave way — so it rises
 * into the dock once, the prototype's `dock-in` (#417); a thread opened already started does not. A
 * layout effect, so the first docked paint already carries the animation.
 */
function useDocking(launching: boolean): boolean {
  const wasLaunching = useRef(launching)
  const [docking, setDocking] = useState(false)
  useLayoutEffect(() => {
    if (wasLaunching.current && !launching) setDocking(true)
    wasLaunching.current = launching
  }, [launching])
  return docking
}

/**
 * The composer's card, the prototype's `.composer` (#417): docked, in the transcript's column with
 * the strong border, the ring's colour while focused; on the launch panel it asks for the first
 * prompt — the primary's border and faint ring (`.composer.is-launch`) — and once Start docks it,
 * it rises into the dock (`useDocking`).
 */
function ComposerCard({
  launching,
  children,
}: {
  readonly launching: boolean
  readonly children: React.ReactNode
}): React.ReactNode {
  const docking = useDocking(launching)
  return (
    <div
      className={cn(
        'mx-auto grid w-full gap-2 rounded-lg border bg-card transition-colors',
        launching
          ? 'border-primary p-4 shadow-launch'
          : 'max-w-transcript border-border-strong p-3 focus-within:border-ring',
        docking && 'animate-in duration-200 ease-out fade-in-0 slide-in-from-bottom-3 motion-reduce:animate-none',
      )}
    >
      {children}
    </div>
  )
}

/**
 * Inside the ported form, the composer's card (the prototype's `.composer`, #417): the settings
 * chips on top, the attachment strip, the textarea, then a footer — the hint that says what Enter
 * does (#878) on the left; the `/` palette, attach and stop / send — or, on the launch panel (#877),
 * Start session — on the right. A separate component because the attachments live in the form's
 * context (`usePromptInputAttachments`), and "can send" depends on them — an image with no words
 * sends (#68). ⚠ The textarea keeps its place in both shapes, so Start never remounts it.
 */
function ComposerBody({
  draft,
  setDraft,
  textareaRef,
  disconnected,
  running,
  onStop,
  onRunCommand,
  onInsertCommand,
  host,
  launch,
  settings,
}: {
  draft: string
  setDraft: (next: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  disconnected: boolean
  running: boolean
  onStop: () => void
  onRunCommand: (commandName: string) => void
  onInsertCommand: (commandName: string) => void
  host: HostCommandHandlers
  launch: LaunchSubmit | undefined
  /** The chips row (`ComposerSettings`), the card's first. */
  settings: React.ReactNode
}): React.ReactNode {
  const stores = useThreadStores()
  const attachments = usePromptInputAttachments()
  // A resolution ended the thread (#466): read-only for good — the server refuses a prompt, so
  // the composer says why instead of offering a send that cannot land. Forking still works.
  const ended = useStore(stores.incidents).ended
  // What leaving a draft thread reads too (#875): words or an image here keep it on the rail.
  const typed = draft.trim().length > 0 || attachments.files.length > 0
  useEffect(() => stores.typed.set(typed), [stores, typed])
  const launching = launch !== undefined
  const closed = disconnected || ended
  return (
    <ComposerCard launching={launching}>
      {settings}
      <AttachedImages />
      {/* ⚠ The same element in both shapes (#877): Start never remounts it. */}
      <ComposerTextarea
        draft={draft}
        setDraft={setDraft}
        textareaRef={textareaRef}
        placeholder={composerPlaceholder({ disconnected, ended, launching, running })}
        launching={launching}
      />
      <SlashRefusal draft={draft} state={{ launching, running, closed }} />
      <div className="flex items-center gap-2">
        <ComposerHint state={{ launching, running, closed }} />
        {/* The `/` palette (#338): the session's slash commands, grouped; an extension command
            runs through `send`, a prompt template or skill lands in the draft with focus, a host
            command POSTs (slice 2) and `/model` opens the dialog the composer renders. */}
        <CommandPalette
          threadId={stores.threadId}
          fetch={stores.fetch}
          disabled={disconnected}
          {...paletteHandlers(host, onRunCommand, onInsertCommand)}
        />
        {/* Attach (#68): the same file dialog a paste or a drop bypasses. */}
        <PromptInputButton
          aria-label="attach an image"
          title="attach an image — or paste one, or drop it here"
          disabled={disconnected}
          onClick={attachments.openFileDialog}
          className={COMPOSER_ICON_BUTTON}
        >
          <PaperclipIcon />
        </PromptInputButton>
        <ComposerSubmit
          launch={launch}
          draft={draft}
          canSend={typed && !closed}
          running={running}
          disconnected={disconnected}
          onStop={onStop}
        />
      </div>
    </ComposerCard>
  )
}

/**
 * What waits behind the run, as pi holds it (#75) — the `queue` list, rendered above the
 * composer with ai-elements' Queue shell (#121). Every follower sees the same list; a stop
 * hands the texts back to the composer of the tab that stopped. Nothing when nothing waits.
 */
export function PendingQueue(): React.ReactNode {
  const stores = useThreadStores()
  const queued = useStore(stores.queue)
  if (queued.length === 0) return null
  // pi's queue is texts without ids; the same text may wait twice. Key by text and its
  // occurrence so a duplicate keeps its own row and a removal from the head does not remount.
  const seen = new Map<string, number>()
  const keyed = queued.map((queuedPrompt) => {
    const occurrence = seen.get(queuedPrompt) ?? 0
    seen.set(queuedPrompt, occurrence + 1)
    return { text: queuedPrompt, key: `${queuedPrompt}\u0000${occurrence}` }
  })
  return (
    // The docked card's gutters and column (#417), so the queue lines up over the composer it feeds.
    <div className="px-6 max-md:px-3">
      <QueueShell aria-label="queued prompts" className="mx-auto mb-2 max-w-transcript">
        <QueueSection>
          <QueueSectionTrigger>
            <QueueSectionLabel count={queued.length} label={queued.length === 1 ? 'prompt queued' : 'prompts queued'} />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList>
              {keyed.map(({ text, key }) => (
                <QueueItem key={key}>
                  <span className="flex items-start gap-2">
                    <QueueItemIndicator />
                    <QueueItemContent title={text}>{text}</QueueItemContent>
                  </span>
                </QueueItem>
              ))}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      </QueueShell>
    </div>
  )
}

/**
 * The composer as the launch panel's form (#877), while its thread is not started: the form, and
 * what Start needs — the settings read, a project to start in, no Start already out. Both
 * undefined once the session runs. `onScreen`: the models and libraries are read only for the
 * pane on screen (#883).
 */
function useComposerLaunch(onScreen: boolean): {
  readonly form: LaunchForm | undefined
  readonly submit: LaunchSubmit | undefined
} {
  const launching = useLaunching()
  const form = useLaunchForm(launching && onScreen)
  const { blocked } = useLaunchProject()
  if (!launching) return { form: undefined, submit: undefined }
  return {
    form,
    submit: {
      ready: form.catalogue.kind === 'loaded' && blocked === undefined && !form.applying,
      applying: form.applying,
    },
  }
}

/**
 * A value as of the latest COMMITTED render, for a closure an older render made to read after it
 * changed — written in an effect, never during render (React's rule).
 */
function useLatestCommitted<T>(value: T): React.RefObject<T> {
  const latest = useRef(value)
  useEffect(() => {
    latest.current = value
  }, [value])
  return latest
}

/**
 * The composer's dialogs, each rendered ONCE in it: the `select` host command whose dialog is open
 * (`model`; undefined while closed) — for the chip and the palette's `/model` row alike (#338
 * slice 2) — with the Model chip its picker hangs from (#417); and `/context` (#361 phase 5), the
 * one `view` this page draws.
 */
function useComposerDialogs(): {
  readonly modelDialog: string | undefined
  readonly setModelDialog: (command: string | undefined) => void
  readonly modelChip: React.RefObject<HTMLButtonElement | null>
  readonly contextOpen: boolean
  readonly setContextOpen: (open: boolean) => void
} {
  const [modelDialog, setModelDialog] = useState<string | undefined>(undefined)
  const modelChip = useRef<HTMLButtonElement | null>(null)
  const [contextOpen, setContextOpen] = useState(false)
  return { modelDialog, setModelDialog, modelChip, contextOpen, setContextOpen }
}

/**
 * A `view` host command, opened by name: `/context`'s dialog (#361), `/fork` at the last prompt
 * where the pane offers a fork (#433). A view a newer host declares and this page does not draw is
 * said, not silently dropped.
 */
function openHostView(
  commandName: string,
  {
    openContext,
    forkAt,
    notifications,
  }: {
    readonly openContext: () => void
    /** The pane's fork; absent where no page opens one. */
    readonly forkAt: ((messageId: string | undefined) => void) | undefined
    readonly notifications: NotificationsStore
  },
): void {
  if (commandName === ENSO_CONTEXT_COMMAND) openContext()
  else if (commandName === ENSO_FORK_COMMAND && forkAt !== undefined) forkAt(undefined)
  else notifications.push(`/${commandName} opens a view this page does not have`, 'warning', 'run', ENSO_NOTICE_SOURCE)
}

/**
 * The input slot of the widget map: the thread's composer. `useChatContext` is the pane's
 * (`pane-context.ts`), so this reads the chat of the pane it is mounted in.
 */
export function ChatPromptInput(): React.ReactNode {
  const chat = useChatContext()
  const stores = useThreadStores()
  const disconnected = useStore(stores.disconnected)
  // The page's view (#361): `send` brings the chat back (#707), whichever way the prompt went.
  const { open, shown } = useContext(PaneViewContext)
  const launch = useComposerLaunch(shown !== undefined)
  useFreshThreadMode()
  // Controlled, so the send button can disable on empty and a take-back can write it —
  // the ai-elements chatbot example's PromptInput does the same. A fork opens holding the
  // forked prompt's words (#433), as pi's `/fork` fills its editor.
  const [draft, setDraft] = useState(stores.initialDraft)
  // The textarea, so a palette choice can put focus back where typing continues (#338).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // The user messages this composer put in the transcript for prompts pi is still
  // HOLDING (#75): a stop hands those texts back, and the bubble that was never asked
  // leaves with them — pi's TUI does the same. A claimed prompt's bubble stays.
  const heldLocally = useRef<Array<{ id: string; text: string }>>([])
  // The pane's fork (#433): `/fork` forks at the last prompt; absent where no page opens a fork.
  const forkAt = useContext(ForkContext)
  // ⚠ `takeBack` runs after a network round trip, from a closure made by an older render.
  // `chat.messages` there is that render's snapshot; filtering it would replace the
  // transcript with the snapshot minus one, reverting every delta that streamed in
  // between. The ref is the transcript as of the latest COMMITTED render.
  const latestMessages = useLatestCommitted(chat.messages)
  // A compaction rewrote the branch (#348): the transcript is re-read once the thread is idle.
  useRereadAfterCompaction(stores, chat)
  /**
   * Send what the form holds: the text, and the pasted or dropped images as inline bytes.
   * Nothing sends while disconnected (#119): the prompt would reach a server that rebuilds
   * the thread, but this page's follow is gone, so the reply would land nowhere this page
   * can see. An image with no words is a prompt (pi-ai keeps the image and drops the empty
   * text block); nothing at all is not. Says whether it sent, so the submit clears the
   * draft on that answer and nothing else.
   *
   * ⚠ A SENT PROMPT SHOWS THE CHAT (#707), here and not at a caller: the composer is under
   * every view, and the run, its questions, its error and its reply are in the chat. The
   * submit, a typed `/command` pi runs as a prompt, and the palette all send here, so none
   * of them can start a run behind Context, Stats or Diff.
   */
  const send = (text: string, images: readonly EnsoPromptImage[]): boolean => {
    if (disconnected || stores.incidents.get().ended) return false
    if (text.trim().length === 0 && images.length === 0) return false
    open('chat')
    const parts: ContentPart[] = [
      ...(text.length === 0 ? [] : [{ type: 'text' as const, content: text }]),
      ...images.map((image) => ({
        type: 'image' as const,
        source: { type: 'data' as const, value: image.data, mimeType: image.mimeType },
      })),
    ]
    if (!chat.sessionGenerating) {
      void chat.sendMessage({ content: parts })
      return true
    }
    // A prompt DURING a run queues through pi (#75). ⚠ Not `chat.sendMessage`: TanStack
    // holds a send in its own queue while the run it started is open and delivers it at
    // settle — the browser's queue, invisible to other tabs, lost on reload. So the user
    // message goes into the transcript here, and the text goes to pi now: pi lists it on
    // the follow for every follower (`queue`, the list above this composer) and claims
    // it when the run's turn ends. Refused or unreachable, the words come back to the
    // draft. ⚠ The images do not: pi's queue hands back texts (`EnsoAbortReceipt.restored`),
    // and the composer's attachments are the form's, not this component's — re-attach.
    const id = crypto.randomUUID()
    heldLocally.current.push({ id, text })
    chat.setMessages([...chat.messages, { id, role: 'user', parts, createdAt: new Date() }])
    void stores.connection.prompt(text, images).then((outcome) => {
      if (outcome === 'refused' || outcome === 'unreachable') takeBack([text])
    })
    return true
  }
  /**
   * Texts pi never took come back to the draft, and their never-asked bubbles leave the transcript.
   *
   * @invariant abort-clear-restore/composer-takes-back The stopping tab's composer gets the texts back; the bubbles that were never asked leave.
   * A stop's `restored` is appended to the draft after anything already typed, and the user
   * bubbles this composer put in the transcript for prompts the runtime still held are removed;
   * a claimed prompt's bubble stays, and deltas that streamed meanwhile are kept (the filter
   * reads the latest committed transcript, not this render's). Only texts come back: images
   * attached to a queued prompt are not restored, a limit the composer states, not a gap.
   */
  const takeBack = (texts: readonly string[]): void => {
    const leaving = new Set<string>()
    for (const takenBackText of texts) {
      const position = heldLocally.current.findIndex((held) => held.text === takenBackText)
      if (position === -1) continue
      leaving.add(heldLocally.current[position]?.id ?? '')
      heldLocally.current.splice(position, 1)
    }
    if (leaving.size > 0) chat.setMessages(latestMessages.current.filter((message) => !leaving.has(message.id)))
    setDraft((current) => joinDrafts(current, ...texts))
  }
  // Stop (#116) hands back what was queued behind the run (#75, clear-and-restore): the
  // abort receipt's texts become the draft, in order, after anything already typed.
  const stopRun = (): void => {
    void stores.connection.abort().then(({ restored }) => {
      if (restored.length > 0) takeBack(restored)
    })
  }
  // The `/` palette's two outcomes (#338; the rule is in `command-palette.tsx`'s header).
  // ⚠ NEITHER TOUCHES WHAT THE USER HAS TYPED. An extension command is a prompt like any
  // other — the same `send` the button uses, so it queues through pi mid-run (#75) and is
  // refused while disconnected, exactly as typed `/mode` is — and the draft stays, because
  // it was not what got sent. A prompt template or a skill takes arguments, and pi reads a
  // template only at the START of the message, so `/<name> ` goes in front and the words
  // already typed become its argument. Focus lands after them BY CONSTRUCTION: the caret is
  // placed at the end once React has committed the new value (a frame later), not left to
  // the browser's default after a programmatic change.
  const runCommand = (commandName: string): void => {
    send(`/${commandName}`, [])
    textareaRef.current?.focus()
  }
  const insertCommand = (commandName: string): void => {
    setDraft((current) => `/${commandName} ${current.trimStart()}`)
    requestAnimationFrame(() => {
      const field = textareaRef.current
      if (field === null) return
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    })
  }
  const { modelDialog, setModelDialog, modelChip, contextOpen, setContextOpen } = useComposerDialogs()
  // A `host` command runs through its own route, never as a prompt: `POST …/command`, a
  // control like the mode select's — on the SAME connection, so a 409 (running) or a 422
  // (the host's reason) is recorded and said the one way a refused mode change is. Nothing
  // here moves the chip — the `model` observation on the follow does (invariant 2).
  const host: HostCommandHandlers = {
    onHost: (commandName: string, optionId?: string): void => {
      void stores.connection.runHostCommand({
        name: commandName,
        ...(optionId === undefined ? {} : { value: optionId }),
      })
    },
    onOpenModelDialog: setModelDialog,
    onOpenView: (commandName: string): void =>
      openHostView(commandName, {
        openContext: () => setContextOpen(true),
        forkAt,
        notifications: stores.notifications,
      }),
  }
  // A bare `/<name>` typed and sent (#388): when the thread's command list names it as a HOST
  // row, it does what choosing that row in the palette does — `/login` opens the provider
  // picker — instead of reaching the transcript as a user message the server refuses.
  // Anything else, or a list that cannot be read, is sent as a prompt. ⚠ A thread with NO
  // session — a stored one not opened since a restart — has no commands to name (#484): the
  // lookup builds nothing, and the words go back with the launch panel's own sentence — a
  // session starts with a prompt, and the slash commands are its. The draft clears BEFORE the
  // lookup (#389): the composer stays live during it, and a second Enter on a draft still holding
  // `/word` would route or send it twice. A send the fallback refuses (disconnected) gives the
  // words back, as a refused submit keeps them.
  const submitTypedCommand = async (commandName: string, text: string): Promise<void> => {
    setDraft('')
    const listed = await fetchThreadCommands(stores.threadId, stores.fetch).catch((): undefined => undefined)
    if (listed !== undefined && listed.source !== 'live') {
      setDraft(text)
      stores.notifications.push(SLASH_PROMPT_REFUSAL, 'info', 'run', ENSO_NOTICE_SOURCE)
      return
    }
    const row = listed?.commands.find((command) => command.source === 'host' && command.name === commandName)
    if (row === undefined) {
      if (!send(text, [])) setDraft(text)
      return
    }
    const opened = runTypedHostCommand(row, paletteHandlers(host, runCommand, insertCommand))
    if (!opened)
      stores.notifications.push(
        `/${row.name} is a setting: choose a value from the / palette`,
        'info',
        'run',
        ENSO_NOTICE_SOURCE,
      )
  }

  /**
   * Start (#877): the launch panel's settings, then the prompt through `send` — the composer's own,
   * so the bubble and the run are exactly a sent prompt's. The draft clears only once it went; a
   * Start that did not go through rejects, and the form keeps the draft AND the attachments.
   */
  const startSession = async (form: LaunchForm, text: string, images: readonly EnsoPromptImage[]): Promise<void> => {
    await form.start(() => send(text, images))
    setDraft('')
  }
  const submit = ({ text, files }: PromptInputMessage): Promise<void> | undefined => {
    const { images, notImages } = imagesOfAttachments(files)
    if (notImages > 0) {
      stores.notifications.push(
        describeAttachmentError({ code: 'accept', message: '', count: notImages }),
        'warning',
        'run',
        ENSO_NOTICE_SOURCE,
      )
    }
    if (launch.form !== undefined) return startSession(launch.form, text, images)
    // The draft WAS the text: it clears here, at the submit, not in `send` — the palette
    // sends through `send` too and must leave what the user has typed alone — and only if
    // something went: a submit `send` refuses keeps its words.
    const commandName = images.length === 0 ? typedCommandName(text) : undefined
    if (commandName !== undefined) void submitTypedCommand(commandName, text)
    else if (send(text, images)) setDraft('')
    return undefined
  }

  return (
    <PromptInput
      // Docked: the prototype's `.dock` gutters (#417); on the launch panel its column pads it.
      className={launch.form === undefined ? 'w-full px-6 pb-4 max-md:px-3 max-md:pb-3' : 'w-full'}
      accept={ENSO_IMAGE_MIME_TYPES.join(',')}
      multiple
      maxFiles={ENSO_PROMPT_MAX_IMAGES}
      maxFileSize={ENSO_IMAGE_MAX_BYTES}
      // A file the form would not take is said, not dropped (#68): the reason names the cap.
      onError={(error: PromptInputError): void =>
        stores.notifications.push(describeAttachmentError(error), 'warning', 'run', ENSO_NOTICE_SOURCE)
      }
      onSubmit={submit}
    >
      <ComposerModelDialog
        threadId={stores.threadId}
        fetch={stores.fetch}
        command={modelDialog}
        anchor={modelChip}
        onClose={(): void => setModelDialog(undefined)}
        returnFocus={(): void => textareaRef.current?.focus()}
        onPick={host.onHost}
      />
      <ThreadContextDialog
        open={contextOpen}
        onClose={(): void => setContextOpen(false)}
        returnFocus={(): void => textareaRef.current?.focus()}
      />
      <ComposerBody
        draft={draft}
        setDraft={setDraft}
        textareaRef={textareaRef}
        disconnected={disconnected}
        running={chat.sessionGenerating}
        onStop={stopRun}
        onRunCommand={runCommand}
        onInsertCommand={insertCommand}
        host={host}
        launch={launch.submit}
        settings={
          <ComposerSettings
            launch={launch.form}
            host={host}
            pickerOpen={modelDialog === 'model'}
            modelChip={modelChip}
            onSavedPrompt={setDraft}
          />
        }
      />
    </PromptInput>
  )
}
