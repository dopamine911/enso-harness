import { createChat, type TanStackChat } from '@shadcn/helpers/tanstack-ai'

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
 * ⚠ What this fixture CANNOT produce: a #27 dialog interrupt. The helper has no writer
 * operation for an interrupt outcome, so `EnsoDialogInterrupt` styling is verified against
 * live `/mode` (or the fake-transport unit tests), not here.
 */
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
          '**Sanitization tripwires — if any of these is live, the renderer regressed:**\n\n' +
          'SENTINEL-BEFORE: the three tripwires sit between this sentence and SENTINEL-AFTER.\n\n' +
          // ⚠ The raw tags render as ESCAPED TEXT (`@tanstack/markdown` does not parse model HTML),
          // so the healthy page shows them as literal characters — that is the pass, not a glitch.
          '<img src="x" alt="[image tripwire — healthy is this tag shown as text, never drawn]" ' +
          'onerror="alert(\'sanitize regression: img onerror fired\')">\n\n' +
          "[this link must be inert](javascript:alert('sanitize regression: javascript link fired'))\n\n" +
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
