import type { DialogAnswer, EnsoDialogAnswer, EnsoDialogSpec } from '@enso/core'
import { CircleQuestionMarkIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { Input } from './components/ui/input.tsx'
import { Textarea } from './components/ui/textarea.tsx'
import type { DialogAnswerOutcome } from './follow-connection.ts'
import { QuestionnaireControls } from './questionnaire-card.tsx'
import { useStore, useThreadStores } from './store.ts'
import type { ThreadStores } from './thread-stores.ts'

/**
 * pi's blocking dialogs — `select`, `confirm`, `input`, `editor` — answered from the page (#27, #112).
 *
 * The question arrives on the follow as a blocking `extension-ui-request` (the `EnsoDialogSpec` the
 * server built, validated again by the router before it reaches the store), and the answer
 * is one `POST /api/threads/:id/dialog`. No interrupt: the run keeps going on the follow
 * while the human decides, and nothing on the server is parked.
 *
 * ⚠ The payloads handed to `answer` are EXACTLY pi's wire shapes minus the envelope
 * (`{value}` / `{confirmed}`) — the server validates them against the question
 * (`validateDialogAnswer`) and forwards them verbatim, so inventing a richer shape here
 * would be refused there. The one shape that is not pi's is the questionnaire's `{answers}`
 * (#12), which the host hands to the asking tool. Cancel is pi's `{cancelled: true}`.
 *
 * ⓘ `DialogAnswerControls`, `EnsoDialogCard` and `settleDialog` are exported for
 * `__tests__/chat-screen.test.tsx` (#49): static renders of each dialog method. `PendingDialog` is
 * the layout's, and asserted through the mounted pane (`thread-pane.test.tsx`, #118).
 */

/**
 * The per-method answer controls, one early return per dialog method, so each shape reads on its
 * own. `input` and `editor` share the form; the only difference is the field element.
 */
export function DialogAnswerControls({
  dialog,
  answer,
  disabled,
}: {
  dialog: EnsoDialogSpec
  answer: (payload: EnsoDialogAnswer) => void
  /** An answer is already in flight: every control refuses a second one — see {@link OpenQuestion} (#275). */
  disabled: boolean
}): React.ReactNode {
  if (dialog.method === 'questionnaire') {
    return <QuestionnaireControls dialog={dialog} answer={answer} disabled={disabled} />
  }
  if (dialog.method === 'confirm') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">{dialog.message}</p>
        <div className="flex gap-2">
          <Button type="button" disabled={disabled} onClick={() => answer({ confirmed: true })}>
            Yes
          </Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => answer({ confirmed: false })}>
            No
          </Button>
        </div>
      </div>
    )
  }
  if (dialog.method === 'select') {
    return (
      <div className="flex flex-col gap-3">
        {/* The detail behind the question (#73): a file preview, a diff, a command. Preformatted,
				    never markdown — model-chosen file content must not render as HTML. */}
        {dialog.message === undefined || dialog.message.length === 0 ? null : (
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/50 p-3 text-xs whitespace-pre-wrap">
            {dialog.message}
          </pre>
        )}
        <div className="flex flex-wrap gap-2">
          {dialog.options.map((option) => (
            // ⚠ An option can be a long rule — `Yes, allow write "<a thread tree's absolute path>/*" for
            // this session` — and it is what the user consents to (#625). The button's own
            // `whitespace-nowrap` and fixed height would clip it at the card's edge; here it wraps, at any
            // character since a path has no spaces, and grows to hold every line.
            <Button
              key={option}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => answer({ value: option })}
              className="h-auto min-h-8 max-w-full py-1.5 text-left wrap-anywhere whitespace-normal"
            >
              {option}
            </Button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <InputGuidance dialog={dialog} />
      {/* A SPA answer POSTs over the follow connection; a React 19 `action` would reset the field after it
          ran, and a refused (422) answer re-opens the controls with the words still there (#113). */}
      {/* react-doctor-disable-next-line no-prevent-default */}
      <form
        onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const field = event.currentTarget.elements.namedItem('answer')
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
            answer({ value: field.value })
          }
        }}
        className="flex items-start gap-2"
      >
        {dialog.method === 'editor' ? (
          <Textarea name="answer" defaultValue={dialog.prefill ?? ''} rows={6} disabled={disabled} className="flex-1" />
        ) : (
          <Input
            name="answer"
            // A credential (#338 slice 3: `/login`'s API key) is masked, and never a transcript line.
            type={dialog.method === 'input' && dialog.secret === true ? 'password' : 'text'}
            placeholder={dialog.placeholder ?? ''}
            autoComplete={dialog.method === 'input' && dialog.secret === true ? 'new-password' : 'off'}
            disabled={disabled}
            className="flex-1"
          />
        )}
        <Button type="submit" disabled={disabled}>
          Answer
        </Button>
      </form>
    </div>
  )
}

/**
 * What an `input` question carries beside its field (#388) — both set by the host, never by pi:
 * the explanation (a login's code prompt says the paste is the fallback, and what to paste; plain
 * text, never markdown) and the page to open (a login's authorization page, in a NEW TAB of this
 * browser, the one where the login has to happen). The page is a link styled as a button, not
 * `window.open`, so it is a click the browser allows. The schema admits only http(s); the check
 * here keeps a `javascript:` URL from ever becoming an href if that changes.
 */
function InputGuidance({ dialog }: { dialog: EnsoDialogSpec }): React.ReactNode {
  if (dialog.method !== 'input') return null
  const { message, link } = dialog
  return (
    <>
      {message === undefined || message.length === 0 ? null : (
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">{message}</p>
      )}
      {link === undefined || !/^https?:\/\//.test(link.url) ? null : (
        <Button asChild variant="outline" className="self-start">
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon />
            {link.label}
          </a>
        </Button>
      )}
    </>
  )
}

/**
 * The question as a card — the one surface that parks pi on a human, so it is a NAMED GROUP
 * (#276): `role="group"` whose accessible name is the question, with the title carrying a
 * heading role so a screen reader can jump straight to it.
 *
 * NOT `role="dialog"`/`aria-modal`: the run keeps going behind it and the rest of the page
 * stays usable, so claiming modality would be a lie a screen reader acts on. {@link
 * OpenQuestion} moves focus into the group on arrival, and that focus move is what announces it
 * — which is why there is no live region here: a polite region wrapping the card would read the
 * whole question a second time.
 */
export function EnsoDialogCard({
  dialogId,
  dialog,
  answer,
  cancel,
  disabled,
  ref,
}: {
  /** The open question's id — unique per question, so the `aria-labelledby` target is too. */
  dialogId: string
  dialog: EnsoDialogSpec
  answer: (payload: EnsoDialogAnswer) => void
  cancel: () => void
  disabled: boolean
  ref?: React.Ref<HTMLDivElement>
}): React.ReactNode {
  const titleId = `enso-dialog-title-${dialogId}`
  return (
    <div
      ref={ref}
      role="group"
      aria-labelledby={titleId}
      className="my-2 grid max-w-3xl overflow-hidden rounded-lg border border-human bg-card signal:ring-1 signal:ring-human/30 ledger:my-3 ledger:rounded-xs ledger:border-dashed ink:border-2"
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wider text-human uppercase">
          <CircleQuestionMarkIcon aria-hidden="true" className="size-4" />
          pi is asking
        </span>
        <span className="font-mono text-xs text-muted-foreground">{dialog.method}</span>
      </div>
      <div className="grid gap-3 p-3">
        <h2 id={titleId} className="font-heading text-base font-semibold">
          {dialog.title}
        </h2>
        <DialogAnswerControls dialog={dialog} answer={answer} disabled={disabled} />
      </div>
      <div className="flex justify-end px-3 pb-3">
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={cancel}>
          Cancel — decline the question
        </Button>
      </div>
    </div>
  )
}

/**
 * Answer the thread's open question through its connection.
 *
 * The slot clears once the question is SPENT — taken by the server (`answered`), or already
 * settled from another tab or expired (`gone`). A `refused` answer (an unoffered value, 422)
 * leaves the question open on the server, so it stays on screen with the reason as a notice:
 * nothing would re-show it otherwise, and the thread would sit busy behind a card that vanished
 * (#113). `unreachable` (the request never arrived) leaves it open the same way. The outcome is
 * handed back so the caller can tell a spent question from one still standing (#275).
 */
export async function settleDialog(
  stores: Pick<ThreadStores, 'connection' | 'dialog'>,
  response: DialogAnswer,
): Promise<DialogAnswerOutcome> {
  const outcome = await stores.connection.answerDialog(response)
  if (outcome === 'answered' || outcome === 'gone') stores.dialog.set(undefined)
  return outcome
}

/** The thread's open question, if any — see {@link OpenQuestion}. */
export function PendingDialog(): React.ReactNode {
  const stores = useThreadStores()
  const pending = useStore(stores.dialog)
  if (pending === undefined) return null
  // ⚠ Keyed by the question's id: the in-flight flag and the focus move are per-QUESTION
  // state, so the next question arrives on a fresh mount instead of inheriting either.
  return <OpenQuestion key={pending.id} id={pending.id} dialog={pending.dialog} />
}

/**
 * One open question: answered ONCE (#275), and announced on arrival (#276).
 *
 * The card stays mounted for the whole round trip — `settleDialog` clears the slot only once
 * the server has taken the answer — so nothing but this flag stops a second click from
 * sending a second `POST …/dialog`. The server 404s the spent question, the adapter reports
 * `gone`, and the user reads a red `dialog <id> gone: 404 …` line for an answer that in fact
 * landed. ⚠ The flag is a REF as well as state: two clicks in one task (a double-click on
 * `Yes`, a second option on a `select`) both read the state from before the first re-render,
 * so the state is what disables the controls and the ref is what closes that race. A
 * `refused` (422) or `unreachable` answer leaves the question standing, so those re-open the
 * controls; anything else spends it and this unmounts.
 */
function OpenQuestion({ id, dialog }: { id: string; dialog: EnsoDialogSpec }): React.ReactNode {
  const stores = useThreadStores()
  const [settling, setSettling] = useState(false)
  const inFlight = useRef(false)
  const card = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // The run is parked on a human, so the question takes focus: it announces the group (whose
    // name IS the question) and spares a keyboard user the whole transcript to find it.
    card.current?.querySelector<HTMLElement>('button, input, textarea')?.focus()
  }, [])
  const settle = (response: DialogAnswer): void => {
    if (inFlight.current) return
    inFlight.current = true
    setSettling(true)
    void settleDialog(stores, response).then((outcome) => {
      if (outcome !== 'refused' && outcome !== 'unreachable') return
      inFlight.current = false
      setSettling(false)
    })
  }
  return (
    <EnsoDialogCard
      ref={card}
      dialogId={id}
      dialog={dialog}
      disabled={settling}
      answer={(payload: EnsoDialogAnswer) => settle({ id, ...payload })}
      cancel={() => settle({ id, cancelled: true })}
    />
  )
}
