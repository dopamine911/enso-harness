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
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from 'lucide-react'
import { useContext, useEffect, useRef, useState } from 'react'
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
import { ModelChip, ModelChoiceDialog, ThinkingLevelSelect, useModelState, useRecordedModel } from './model-state.tsx'
import { useThreadProject } from './page-listings.ts'
import { useChatContext, PaneViewContext } from './pane-context.ts'
import { PermissionModeSelect, usePermissionMode } from './permission-mode.tsx'
import { draftWithKeptPrompt, SLASH_PROMPT_REFUSAL, StartSessionDialog } from './start-session.tsx'
import { useStore, useThreadStores } from './store.ts'
import { ThreadContextDialog } from './thread-context.tsx'

/**
 * A thread's composer (#90): the prompt form, its chrome (mode, model, thinking), the `/` palette
 * (#338), stop (#116), and pi's queue above it (#75). Application-owned, per the deprecation notice
 * on TanStack's `ChatInput`.
 */

/**
 * The composer row's permission-mode control (#84): the thread's current mode, and a
 * dropdown that switches it through the mode route (L3 step C) — a control, not a prompt.
 * Beside the composer rather than in the page header (#90 PR 3): it is per THREAD, and
 * deepseek-harness keeps the mode selector in the composer chrome for the same reason.
 *
 * ⚠ `POST …/mode`, never a prompt: the browser says a mode; how the host's extension is
 * told is the host's (its per-mode command, #496). The indicator then updates from the
 * `permission-mode` receipt the host emits once the mode is persisted — the mode actually set —
 * never from the click. Invariant 2: a route tells pi; the feed ends the story.
 *
 * ⓘ Offered while a run is in flight too (#618): a run that asks before every call is the one
 * a user most needs to change, and the change governs its next tool call (`changeThreadMode`).
 *
 * On mount it asks the server what a fresh thread starts in, so the control reads
 * `default` from the first paint rather than `unknown` until the first run. In fixture
 * mode there is no server; the fetch fails and the store honestly stays `unknown`.
 */
function PermissionModeControl(): React.ReactNode {
  const stores = useThreadStores()
  const { mode, available } = usePermissionMode()
  useEffect(() => {
    void stores.permissionMode.seed(async () => (await stores.fetch('/api/mode')).json())
  }, [stores])
  return (
    <PermissionModeSelect
      mode={mode}
      available={available}
      onSelect={(next: string) => void stores.connection.changeMode(next)}
    />
  )
}

/**
 * The composer row's model controls (#338 slice 2, the control half of #44): the `thinking`
 * select and the model chip, both reading the thread's model store, both changing it through
 * `POST …/command` — a control, not a prompt, like the mode select beside them. The chip opens
 * the model dialog the owner renders (`onOpenModelDialog`), the same one the palette's `/model`
 * row opens. ⚠ NOT disabled while a run is in flight or before the first run: pi takes a model
 * change between turns, the route answers 409 while busy and the refusal is said as a notice —
 * and choosing before the first prompt is the point (#341, `model-state.tsx`'s header).
 */
function ModelControls({ onHost, onOpenModelDialog }: HostCommandHandlers): React.ReactNode {
  const state = useModelState()
  const recorded = useRecordedModel()
  return (
    <>
      <ThinkingLevelSelect state={state} onSelect={(level: string): void => onHost('thinking', level)} />
      <ModelChip state={state} recorded={recorded} onOpen={(): void => onOpenModelDialog('model')} />
    </>
  )
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
      className="size-11"
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
 * The Start-a-session dialog (#391) on a minted thread, with what it reads: the thread's project and
 * its permission modes. Start configures the session and sends the first prompt through the
 * composer's own `send`; a dismissal hands a typed prompt back to the composer (#638). Shown only
 * from the pane on screen (#869): a fresh thread behind a page — Settings opened from a fresh home —
 * keeps its dialog for when the thread is shown, never over the page.
 */
function ComposerStartSession({
  keepPrompt,
  send,
}: {
  readonly keepPrompt: (text: string) => void
  readonly send: (text: string) => boolean
}): React.ReactNode {
  const stores = useThreadStores()
  const open = useStore(stores.startSession)
  const onScreen = useContext(PaneViewContext).shown !== undefined
  const project = useThreadProject(stores.projectId)
  const permission = usePermissionMode()
  return (
    <StartSessionDialog
      threadId={stores.threadId}
      fetch={stores.fetch}
      project={project}
      open={open && onScreen}
      onClose={(): void => stores.startSession.set(false)}
      keepPrompt={keepPrompt}
      onTyped={stores.typed.startDialog.set}
      mode={permission.mode}
      modes={permission.available}
      configure={stores.connection.configure}
      send={send}
    />
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

/** What the composer's empty box says: why it cannot send, or the invitation. */
function composerPlaceholder({
  disconnected,
  ended,
}: {
  readonly disconnected: boolean
  readonly ended: boolean
}): string {
  if (disconnected) return 'disconnected — reload and resume from the rail'
  // A resolution ended the thread (#466): the server refuses a prompt, and a fork goes on.
  if (ended) return 'this thread was ended by an incident resolution — it is read-only; fork it to go on'
  return 'ask pi something'
}

/**
 * Inside the ported form: the attachment strip, the textarea, the `/` palette, the attach /
 * stop / send buttons. A separate component because the attachments live in the form's context
 * (`usePromptInputAttachments`), and "can send" depends on them — an image with no words
 * sends (#68).
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
}): React.ReactNode {
  const stores = useThreadStores()
  const attachments = usePromptInputAttachments()
  // A resolution ended the thread (#466): read-only for good — the server refuses a prompt, so
  // the composer says why instead of offering a send that cannot land. Forking still works.
  const ended = useStore(stores.incidents).ended
  // What leaving a draft thread reads too (#875): words or an image here keep it on the rail.
  const typed = draft.trim().length > 0 || attachments.files.length > 0
  useEffect(() => stores.typed.composer.set(typed), [stores, typed])
  const canSend = typed && !disconnected && !ended
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-input bg-card p-2 transition-colors focus-within:border-ring">
      {attachments.files.length === 0 ? null : (
        <Attachments aria-label="attached images" className="px-1 pt-1">
          {attachments.files.map((file) => (
            <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
              <AttachmentPreview />
              <AttachmentRemove label={`remove ${file.filename || 'image'}`} />
            </Attachment>
          ))}
        </Attachments>
      )}
      <div className="flex items-end gap-2">
        <PromptInputTextarea
          ref={textareaRef}
          value={draft}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
          placeholder={composerPlaceholder({ disconnected, ended })}
          autoComplete="off"
          rows={1}
          className="max-h-40 min-h-11 flex-1 resize-none border-0 bg-transparent text-base shadow-none placeholder:text-muted-foreground focus-visible:ring-0 dark:bg-transparent"
        />
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
        >
          <PaperclipIcon />
        </PromptInputButton>
        <StopControl running={running} disconnected={disconnected} onStop={onStop} />
        {/* Send stays offered in flight: a prompt during a run queues through pi (#75) —
				    the form's submit takes the direct route past TanStack's own queue. */}
        <Button type="submit" size="icon" className="size-11" aria-label="send message" disabled={!canSend}>
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
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
    <QueueShell aria-label="queued prompts" className="mx-6 mb-2">
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
  )
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
  const { open } = useContext(PaneViewContext)
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
  // between. The ref is the transcript as of the latest COMMITTED render — written in an
  // effect, never during render (React's rule).
  const latestMessages = useRef(chat.messages)
  useEffect(() => {
    latestMessages.current = chat.messages
  }, [chat.messages])
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
  // The `select` host command whose dialog is open (`model`); undefined while closed. The
  // dialog is rendered ONCE here, for the chip and the palette's `/model` row alike (#338 slice 2).
  const [modelDialog, setModelDialog] = useState<string | undefined>(undefined)
  // `/context` (#361 phase 5): the one `view` this page draws. A view a newer host declares
  // and this page does not know is said, not silently dropped.
  const [contextOpen, setContextOpen] = useState(false)
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
    onOpenView: (commandName: string): void => {
      if (commandName === ENSO_CONTEXT_COMMAND) setContextOpen(true)
      else if (commandName === ENSO_FORK_COMMAND && forkAt !== undefined) forkAt(undefined)
      else
        stores.notifications.push(
          `/${commandName} opens a view this page does not have`,
          'warning',
          'run',
          ENSO_NOTICE_SOURCE,
        )
    },
  }
  // A bare `/<name>` typed and sent (#388): when the thread's command list names it as a HOST
  // row, it does what choosing that row in the palette does — `/login` opens the provider
  // picker — instead of reaching the transcript as a user message the server refuses.
  // Anything else, or a list that cannot be read, is sent as a prompt. ⚠ A thread with NO
  // session has no commands to name (#484): the lookup builds nothing, and the words go back
  // with the Start dialog's own sentence — a session starts with a prompt, and the slash
  // commands are its. The draft clears BEFORE the lookup (#389): the composer stays live
  // during it, and a second Enter on a draft still holding `/word` would route or send it
  // twice. A send the fallback refuses (disconnected) gives the words back, as a refused
  // submit keeps them.
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

  return (
    <PromptInput
      className="w-full px-6 pt-3 pb-4"
      accept={ENSO_IMAGE_MIME_TYPES.join(',')}
      multiple
      maxFiles={ENSO_PROMPT_MAX_IMAGES}
      maxFileSize={ENSO_IMAGE_MAX_BYTES}
      // A file the form would not take is said, not dropped (#68): the reason names the cap.
      onError={(error: PromptInputError): void =>
        stores.notifications.push(describeAttachmentError(error), 'warning', 'run', ENSO_NOTICE_SOURCE)
      }
      onSubmit={({ text, files }: PromptInputMessage): void => {
        const { images, notImages } = imagesOfAttachments(files)
        if (notImages > 0) {
          stores.notifications.push(
            describeAttachmentError({ code: 'accept', message: '', count: notImages }),
            'warning',
            'run',
            ENSO_NOTICE_SOURCE,
          )
        }
        // The draft WAS the text: it clears here, at the submit, not in `send` — the palette
        // sends through `send` too and must leave what the user has typed alone — and only if
        // something went: a submit `send` refuses keeps its words.
        const commandName = images.length === 0 ? typedCommandName(text) : undefined
        if (commandName !== undefined) void submitTypedCommand(commandName, text)
        else if (send(text, images)) setDraft('')
      }}
    >
      {/* The composer chrome (#90): the knobs at the point of use, deepseek's shape — the
          model chip and thinking level (#338 slice 2) beside the mode. */}
      <div className="flex items-center justify-end gap-3 px-1 pb-1">
        <ModelControls {...host} />
        <PermissionModeControl />
      </div>
      <ModelChoiceDialog
        threadId={stores.threadId}
        fetch={stores.fetch}
        command={modelDialog}
        onClose={(): void => setModelDialog(undefined)}
        returnFocus={(): void => textareaRef.current?.focus()}
        onPick={host.onHost}
      />
      <ThreadContextDialog
        open={contextOpen}
        onClose={(): void => setContextOpen(false)}
        returnFocus={(): void => textareaRef.current?.focus()}
      />
      <ComposerStartSession
        keepPrompt={(text: string): void => setDraft((current) => draftWithKeptPrompt(current, text))}
        send={(text: string): boolean => send(text, [])}
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
      />
    </PromptInput>
  )
}
