import { ENSO_CONFIG_EXAMPLE } from '../../../packages/core/src/config.ts'
import {
  WEB_FETCH_MAX_RESPONSE_BYTES,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_TOOL_NAME,
} from '../../../packages/core/src/web-fetch.ts'
import { ANSWER_ENDINGS, FEATURE_SCRIPT } from '../feature-session.ts'
import { stringsIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

/** `http:` → `` `http` ``, as the tool's policy lists them. */
const PROTOCOLS = stringsIn('packages/harness/core/web-fetch-policy.ts', 'FETCHABLE_PROTOCOLS').map(
  (protocol) => `\`${protocol.replace(/:$/, '')}\``,
)
const PROTOCOL_WORDS = `${PROTOCOLS.slice(0, -1).join(', ')} or ${PROTOCOLS.at(-1)}`

/**
 * The fix pi's second answer passes on: its last sentence, as the scripted session wrote it and
 * the chat renders it (code spans shown as plain text).
 */
function answerFix(): string {
  const ending = ANSWER_ENDINGS[1]
  if (ending === undefined) throw new Error('web-access: the demo session has no second answer')
  for (const reply of FEATURE_SCRIPT.replies)
    for (const part of reply)
      if (part.kind === 'text' && part.text.endsWith(ending)) {
        const sentence = part.text.slice(part.text.lastIndexOf('. ') + 2)
        return sentence.replaceAll('`', '').slice(0, -` ${ending}`.length)
      }
  throw new Error(`web-access: no scripted answer ends "${ending}"`)
}

const FETCH_CALL: MarkTarget = { toolCall: 'https://bun.sh/blog' }

/** Web access (#482): the demo thread's web_fetch call, answered "Not fetched" by the empty allowlist. */
export const WEB_ACCESS: FeatureSpec = {
  id: 'web-access',
  title: 'Web access',
  landingTagline: 'web_fetch · web_search',
  shows: [
    'pi reaches the web through two tools Enso adds, and through nothing else:',
    [
      `- \`${WEB_FETCH_TOOL_NAME}\` fetches one URL and returns the page as text. An HTML page comes back as the text a reader sees: headings, paragraphs, lists, links, code and tables, without its scripts, styles, navigation or hidden parts. It fetches only hosts you have allowed.`,
      "- `web_search` searches the web. It uses the current model's own search when the model has one, and can fall back to Tavily.",
    ].join('\n'),
    `\`curl\`, \`wget\` and other network clients in the shell are refused by a guard, and the refusal tells pi to use \`${WEB_FETCH_TOOL_NAME}\` instead.`,
  ],
  opens: [
    'Open **Settings**, then **Web tools**. Under **Fetching pages**, type a host and choose **Add**; **Remove** takes one off. A pasted URL is reduced to its host, after you confirm; a wildcard, a path, a port or a login is refused, saying why. **Check** asks `https://<host>/` once, from the server, and when the host only redirects, offers the host it redirects to: allowing `enso.engineer`, which redirects to `www.enso.engineer`, would fetch nothing.',
    [
      'The allowlist lives in your config, `ENSO_HOME/config.json` (`~/.enso/config.json` by default), and Settings changes only that key in it. By hand, name each host exactly:',
      '',
      '```json',
      ENSO_CONFIG_EXAMPLE,
      '```',
    ].join('\n'),
    'A project you trust can add hosts for its own threads in its `.enso/config.json`; Settings lists them under the project, read only. Either way, the list is read when a session starts, so restart the thread after you change it. Settings names the threads still running on the old list.',
    "Under **Searching**, choose the backend — the current model's own search, or DeepSeek — and the domains Tavily answers only from or leaves out. These are `webSearch` in `ENSO_HOME/config.json`, read when a session starts; Settings changes only the key you touch.",
    'For the Tavily fallback, set the key under **Searching**, or put `TAVILY_API_KEY` in `ENSO_HOME/secrets.env` yourself. It is read on every call, so no restart is needed. Settings never shows the key again: only whether one is set, with **Replace** and **Remove**.',
  ],
  shots: [
    {
      image: 'web-fetch-refusal',
      alt: 'A web_fetch call answered "Not fetched", because no host is allowed yet',
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ ...FETCH_CALL, summary: true })
        await ui.page
          .getByText(/^Not fetched/)
          .first()
          .waitFor()
        await ui.scrollTo(FETCH_CALL)
      },
      region: [FETCH_CALL],
      marks: [
        {
          target: { ...FETCH_CALL, summary: true },
          says: `The \`${WEB_FETCH_TOOL_NAME}\` call, and the URL pi asked for.`,
        },
        {
          target: { text: /^Not fetched/, within: FETCH_CALL },
          says: 'The answer pi got. It says why nothing was fetched, which file to edit, and the JSON to put in it.',
        },
      ],
    },
  ],
  lookFor: [
    `In the thread above, pi first tried \`curl https://bun.sh/blog\` and the \`network-egress\` guard refused it. pi then used \`${WEB_FETCH_TOOL_NAME}\`, which fetched nothing either, because the allowlist is empty. That is the default, not a mistake: until you add a host, nothing is fetchable. pi's answer passes the fix on to you (\`${answerFix()}\`) instead of trying another way round.`,
    `Note the difference in the chat. The \`curl\` refusal is a guard receipt. The \`${WEB_FETCH_TOOL_NAME}\` refusal is an ordinary result with a check mark: the tool worked, and its answer is "not fetched".`,
    'A host that is not on the list gets its own answer, naming the hosts that are. Matching is exact: allowing `example.com` does not allow `docs.example.com`.',
    `When \`${WEB_FETCH_TOOL_NAME}\` fetches an HTML page, the first line of the result says so and how much of the page was text, for example \`text/html → text (8.7% of 46,534 chars)\`. Other types, such as plain text, markdown and JSON, come back exactly as the server sent them. A share near zero means the page did not extract well, for example one that builds its content with JavaScript.`,
    'For `web_search`, the first line of every result names the backend that answered and, when it fell back to Tavily, why. When a model answers without searching and Tavily is not set up, the result says `no web search was performed`.',
  ],
  limits: [
    `\`${WEB_FETCH_TOOL_NAME}\` never follows a redirect. It reports where the redirect points, so you can allow that host too.`,
    `It fetches text only, at most ${WEB_FETCH_MAX_RESPONSE_BYTES / 1024} KB, within ${WEB_FETCH_TIMEOUT_MS / 1000} seconds, over ${PROTOCOL_WORDS}, and never a URL with a password in it.`,
    "pi cannot widen its own allowlist. Writes into `ENSO_HOME` and into a project's `.enso/` are refused by the guards, shell redirects included. Settings writes it through the server, which answers only Enso's own page.",
    "A page's text is marked as untrusted before pi reads it. That is a warning to the model, not a filter: a fetched page can still try to give pi instructions.",
    "Text a page hides is left out: comments, templates, and elements hidden by an attribute or an inline style. Text hidden by the page's stylesheet is not recognised as hidden, and comes through.",
    'The check that a host resolves to a public address is advisory. It is not a network boundary.',
  ],
  see: [
    {
      path: 'docs/seams/web-providers.md',
      label: 'Web providers seam',
      why: 'the backends behind `web_search`, and when each is chosen',
    },
    { path: 'docs/flows/web-search-call.md', label: 'A web_search call', why: 'step by step' },
    {
      path: 'docs/reference/env-and-config.md',
      label: 'Environment and configuration',
      why: '`webFetch` and `webSearch` in `config.json`',
    },
    { path: 'docs/features/guards-and-receipts.md', label: 'Guards and receipts', why: 'the `network-egress` rule' },
  ],
}
