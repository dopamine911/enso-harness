import { createChat, type TanStackChat } from '@shadcn/helpers/tanstack-ai'
import type { FetchLike } from './browser-logging.ts'

/**
 * The styling dev loop (#31): a scripted conversation streamed through the REAL
 * `useChat` pipeline as local AG-UI events — no server, no pi.
 *
 * Open the app with `?fixture` and every send replays the next turn below.
 *
 * ⚠ Verified against THIS repo's TanStack versions by probe before adoption: the helper's
 * peer range names @tanstack/ai 0.40 and we run 0.58, so its compatibility is an observed
 * fact, not a promise — thinking, tool-call, tool-result and text parts all materialize
 * (`__tests__/fixture-conversation.test.ts` is that probe). If a TanStack upgrade breaks the
 * fixture page while the live page still works, suspect this seam first.
 *
 * ⚠ Turn 1 is ADVERSARIAL on purpose. Model output is untrusted text entering a DOM, and
 * the text renderer's refusal to build elements from it is a load-bearing claim: this turn
 * carries an onerror image, a javascript: link and a raw script tag, so a renderer regression
 * is VISIBLE on the styling page (an alert firing, or a live link) instead of latent.
 *
 * ⚠ NOTHING LEAVES THE PAGE (#404). The transport above is only TanStack's send; the pane talks to
 * the server through its thread's own `fetch` too — a prompt sent mid-reply (pi's queue, #75),
 * Stop, the mode select, host commands, the launch panel (#877), the Context and Stats reads. So a
 * fixture page's threads are minted with `fixtureFetch` below, which answers every request with a
 * 503 naming the fixture: a control used here says it went nowhere, instead of running a real
 * model on the real agent dir's grant (which is what #404 found it doing).
 *
 * ⚠ What this fixture CANNOT produce: a #27 dialog interrupt. The helper has no writer
 * operation for an interrupt outcome, so `EnsoDialogInterrupt` styling is verified against
 * live `/mode` (or the fake-transport unit tests), not here.
 */
/**
 * The link tripwire, well-formed on purpose (#299): a destination with spaces is not a link in
 * CommonMark. `@tanstack/markdown` forgives one (it strips the whitespace), but a stricter renderer
 * would read the old tripwire as plain text — inert whether or not anything sanitised it, and so
 * healthy-looking by accident. Healthy is its text with no link: the renderer drops the
 * executable destination. Exported so a test proves it is a link to drop.
 */
export const FIXTURE_LINK_TRIPWIRE = "[this link must be inert](javascript:alert('sanitize-regression:link-fired'))"
// The explicit return type is REQUIRED, not style: without it tsc infers a type that
// references the helper's hashed internal chunk (`chat-*.js`) and fails TS2742
// ("likely not portable") under this repo's composite/declaration build.
export function createFixtureChat(): TanStackChat {
  return createChat()
    .user('show me some markdown')
    .assistant(({ writer }) => {
      writer.text(
        '# Markdown check\n\n' +
          'Regular **bold**, *italic*, `inline code`, and a [safe link](https://example.com).\n\n' +
          '- a list item\n- another item\n\n' +
          '```ts\nconst answer = 42;\n```\n\n' +
          '| col A | col B |\n| --- | --- |\n| one | two |\n\n' +
          '---\n\n' +
          // A remote image waits for a click (`markdown-image.tsx`): healthy is a button naming
          // the host and URL, and nothing fetched until it is pressed.
          '![remote image — healthy is a click-to-load button](https://img.shields.io/badge/enso-fixture-blue)\n\n' +
          '**Sanitization tripwires — if any of these is live, the renderer regressed:**\n\n' +
          'SENTINEL-BEFORE: the three tripwires sit between this sentence and SENTINEL-AFTER.\n\n' +
          // ⚠ The raw tags render as ESCAPED TEXT (`@tanstack/markdown` does not parse model HTML),
          // so the healthy page shows them as literal characters — that is the pass, not a glitch.
          '<img src="x" alt="[image tripwire — healthy is this tag shown as text, never drawn]" ' +
          'onerror="alert(\'sanitize regression: img onerror fired\')">\n\n' +
          `${FIXTURE_LINK_TRIPWIRE}\n\n` +
          "<script>alert('sanitize regression: script tag executed')</script>\n\n" +
          'SENTINEL-AFTER: healthy is the tags above as literal text and the link as plain text ' +
          'between the sentinels, and no script anywhere. The regression signal is an alert firing, ' +
          'an image drawn, or the link above being clickable — never how the residue looks.\n',
      )
    })
    .user('now think about something and run a tool')
    .assistant(({ writer }) => {
      // ⚠ FIXTURE ARTIFACT (2026-09-08): this helper opens the reasoning BEFORE the
      // message's TEXT_MESSAGE_START (`REASONING_MESSAGE_START`, role "reasoning"), so
      // TanStack parks it as a reasoning row under a generated id and RE-IDS the message
      // when the text starts — the whole row remounts, the Reasoning shell loses the
      // duration it measured, and the label drops from `Thought for 2s` to `Thought`.
      // The real wire yields TEXT_MESSAGE_START first and every delta under that one id
      // (session.ts, to-agui.ts), so live runs keep their measurement. Do not "fix" the
      // shell on the fixture's account.
      writer.reasoning(
        'The user wants to see the reasoning block. I should look at the repository ' +
          'layout first, then answer. This text streams into the collapsible Reasoning ' +
          'shell, which opens itself while streaming and closes when done.',
      )
      // ⚠ Output is a plain STRING, but the helper still wraps it in a one-element
      // content ARRAY, so the textual fallback renders it quoted — a fixture-only
      // artifact. Live results carry `content` as a bare string (receipt: the
      // 2026-09-03 live `ls` run rendered unquoted), so do not "fix" the renderer
      // to unwrap arrays on the fixture's account.
      writer
        .tool('bash', { input: { command: 'ls -la' } })
        .sleep(600)
        .output('README.md\npackages/\nscripts/\ndocs/')
      // ⚠ A tool name NOTHING registers, on purpose. pi's tool set is dynamic
      // (extensions, MCP), and TanStack's own dispatcher renders an unregistered
      // tool as NOTHING plus a console warning — which is why main.tsx dispatches
      // parts itself. This turn is the receipt that an unanticipated name still
      // renders through the textual contract; if it vanishes, that dispatch regressed.
      writer
        .tool('mcp_made_up_tool_nobody_registered', { input: { subject: 'dynamic dispatch' } })
        .sleep(300)
        .output("an unregistered tool's result — visible, not vanished")
      writer.text('Four entries at the repo root — the layout is a standard npm workspace.')
    })
    .user('what does an error look like?')
    .assistant(({ writer }) => {
      writer.sleep(400)
      writer.error("a scripted failure, so RunProblem's styling is visible on demand")
    })
}

/** What every request from a fixture page's threads is answered with — see the header (#404). */
const FIXTURE_REFUSAL = 'fixture mode: the scripted conversation (?fixture) sends nothing to the server'

/** The fetch a fixture page's threads are minted with: every request refused, by name, without a network. */
export const fixtureFetch: FetchLike = async (): Promise<Response> => new Response(FIXTURE_REFUSAL, { status: 503 })
