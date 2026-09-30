import { ASK_USER_TOOL_NAME } from '../../packages/core/src/ask-user.ts'
import { WEB_FETCH_TOOL_NAME } from '../../packages/core/src/web-fetch.ts'
import type { FeatureModelScript } from './feature-model.ts'

/**
 * The session the Features screenshots are taken from (#437): a small project, four prompts,
 * and what the model answers to each. Everything else in the session is Enso and pi doing what
 * they do: the guards refuse, `web_fetch` answers, the questionnaire and the permission prompt
 * are asked, pi writes the session file, and the server reads it back.
 *
 * The story is small on purpose, because each page's "What to look for" is read off it:
 *   1. pi looks for the database URL, and the guard refuses its read of `.env`;
 *   2. a shell command FAILS (a missing file), `curl` is REFUSED, and `web_fetch` answers that no
 *      host is allowed — three different outcomes, side by side;
 *   3. on a second, pricier model, pi asks two questions, then asks permission to edit;
 *   4. after a compaction, a one-line summary.
 */

/** The demo project: its directory name is the project's name in the rail. */
export const DEMO_PROJECT = 'shop-api'

export const DEMO_FILES: Readonly<Record<string, string>> = {
  'README.md': '# shop-api\n\nThe order service. `bun run src/server.ts` starts it on `PORT`.\n',
  'src/config.ts': [
    'function required(name: string): string {',
    '  const value = Bun.env[name]',
    '  if (!value) throw new Error(`${name} is not set`)',
    '  return value',
    '}',
    '',
    'export const config = {',
    '  port: Number(Bun.env.PORT ?? 3000),',
    '  databaseUrl: Bun.env.DATABASE_URL,',
    '}',
    '',
  ].join('\n'),
  'src/server.ts': [
    "import { config } from './config.ts'",
    '',
    'Bun.serve({',
    '  port: config.port,',
    "  fetch: () => new Response('ok'),",
    '})',
    '',
  ].join('\n'),
  // A credential file, so the guard has something to refuse. The value is not a real password.
  '.env': 'DATABASE_URL=postgres://shop:not-a-real-password@localhost/shop\n',
}

/** The model the session starts on, and the one it switches to before the third prompt. */
export const FIRST_MODEL = 'claude-sonnet-4-5'
export const SECOND_MODEL = 'claude-opus-4-1'

/**
 * The `demo` provider, as pi's `models.json` declares a provider (#437): real prices, real
 * windows, served on loopback at `port` by the scripted model (`feature-model.ts`). The browser
 * suite's seeded home declares it too (#486), with nothing listening, so a model list has
 * entries and no request can reach a real provider.
 */
export function demoModelsJson(port: number): { readonly providers: Readonly<Record<string, unknown>> } {
  return {
    providers: {
      demo: {
        name: 'Demo',
        baseUrl: `http://127.0.0.1:${port}`,
        api: 'anthropic-messages',
        // Not a credential: the scripted model reads no key. pi offers a model only once its
        // provider has one.
        apiKey: 'demo-placeholder',
        models: [
          {
            id: FIRST_MODEL,
            name: 'Claude Sonnet 4.5',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 200_000,
            maxTokens: 64_000,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
          {
            id: SECOND_MODEL,
            name: 'Claude Opus 4.1',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 200_000,
            maxTokens: 32_000,
            cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
          },
        ],
      },
    },
  }
}

/** The prompts, in order: the first is typed into the Start dialog, the rest into the composer. */
export const PROMPTS = [
  'Where does the app read its database URL? Check .env too.',
  'Check the deploy notes, then fetch the Bun changelog.',
  'Make the app refuse to start without DATABASE_URL.',
  'Summarise the change in one line for the PR.',
] as const

/**
 * The throwaway home's prompt library (#443), in the file shape `ENSO_HOME/prompts/<id>.md` holds:
 * an append prompt for the System prompt field and the manager, and a session prompt, without which
 * the Start dialog has no Saved prompt field to show. The session itself starts on pi's default, so
 * the scripted model answers the prompt it was written for. The Prompts page quotes `reviewer.md`
 * as its example file, so the page shows the file the screenshot was taken with.
 */
export const PROMPT_LIBRARY = {
  'reviewer.md': [
    '---',
    'name: Reviewer',
    'description: Reads the change before it answers, and says what breaks',
    'category: append',
    '---',
    '# Reviewer',
    '',
    'Read the diff before you answer. Say what breaks first, then what to change.',
    '',
  ].join('\n'),
  'config-audit.md': [
    '---',
    'name: Config audit',
    'description: A first message for a project you have not read yet',
    'category: session',
    '---',
    'List every environment variable the app reads, and what happens when one is missing.',
    '',
  ].join('\n'),
} as const

/** The last words of each prompt's answer: the capture waits for them before going on. */
export const ANSWER_ENDINGS = [
  'so I cannot confirm its value.',
  'if you want me to read it.',
  'I have not added the tests yet.',
  'is missing.',
] as const

/** The questionnaire pi asks before the edit, answered in the screenshot. */
export const QUESTIONS = [
  {
    header: 'Failure',
    question: 'How should the app fail when DATABASE_URL is missing?',
    options: [
      { label: 'Throw at startup', description: 'The process stops with an error naming the variable.' },
      { label: 'Log and exit', description: 'Print a message and exit with code 1.' },
    ],
    multiSelect: false,
  },
  {
    header: 'Tests',
    question: 'Which tests should I add?',
    options: [
      { label: 'Missing variable', description: 'DATABASE_URL is not set at all.' },
      { label: 'Empty variable', description: 'DATABASE_URL is set to an empty string.' },
    ],
    multiSelect: true,
  },
] as const

export const FEATURE_SCRIPT: FeatureModelScript = {
  replies: [
    // Prompt 1.
    [
      { kind: 'thinking', thinking: 'Search the source for the variable first, then look at .env for its value.' },
      { kind: 'tool', tool: 'bash', input: { command: 'grep -rn DATABASE_URL src' } },
    ],
    [{ kind: 'tool', tool: 'read', input: { path: '.env' } }],
    [{ kind: 'tool', tool: 'read', input: { path: 'src/config.ts' } }],
    [
      {
        kind: 'text',
        text:
          'It reads `DATABASE_URL` from the environment in `src/config.ts`, and nothing checks that it is set. ' +
          'I could not read `.env`: the guard refused it as a credential file, so I cannot confirm its value.',
      },
    ],
    // Prompt 2.
    [{ kind: 'tool', tool: 'bash', input: { command: 'cat docs/deploy.md' } }],
    [{ kind: 'tool', tool: 'bash', input: { command: 'curl -s https://bun.sh/blog' } }],
    [{ kind: 'tool', tool: WEB_FETCH_TOOL_NAME, input: { url: 'https://bun.sh/blog' } }],
    [
      {
        kind: 'text',
        text:
          'There are no deploy notes: `docs/deploy.md` does not exist. I could not fetch the changelog either: ' +
          '`curl` is refused in the shell, and `web_fetch` has no allowed hosts yet. ' +
          'Add `bun.sh` to `webFetch.allowedHosts` if you want me to read it.',
      },
    ],
    // Prompt 3, on the second model.
    [
      { kind: 'thinking', thinking: 'There is a choice to make about how it fails. Ask before changing anything.' },
      { kind: 'tool', tool: ASK_USER_TOOL_NAME, input: { questions: QUESTIONS } },
    ],
    [
      {
        kind: 'tool',
        tool: 'edit',
        input: {
          path: 'src/config.ts',
          edits: [
            {
              oldText: '  databaseUrl: Bun.env.DATABASE_URL,',
              newText: "  databaseUrl: required('DATABASE_URL'),",
            },
          ],
        },
      },
    ],
    [
      {
        kind: 'text',
        text: '`config.databaseUrl` now throws at startup when `DATABASE_URL` is missing. I have not added the tests yet.',
      },
    ],
    // Prompt 4, after the compaction.
    [{ kind: 'text', text: 'config: fail at startup when `DATABASE_URL` is missing.' }],
  ],
  summary:
    'The user asked where shop-api reads DATABASE_URL (src/config.ts; .env was refused as a credential file), ' +
    'then made the app throw at startup when DATABASE_URL is missing. Tests are not written yet.',
}
