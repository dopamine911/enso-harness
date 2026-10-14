import { ENSO_JUDGE_BACKENDS, type EnsoJudgeBackend } from '../../../packages/core/src/command-judge.ts'
import {
  ENSO_FAMILY_TOOLS,
  ENSO_TOOL_FAMILIES,
  type EnsoToolFamily,
} from '../../../packages/core/src/session-incident.ts'
import {
  DEFAULT_RISK_THRESHOLDS,
  ENSO_SECURITY_SIGNALS,
  type EnsoSecuritySignalKind,
} from '../../../packages/core/src/session-risk.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

/**
 * What each signal means, in a reader's words. Keyed by the kind, so a signal added to
 * `ENSO_SECURITY_SIGNALS` fails the typecheck here until it has its row.
 */
const SIGNAL_MEANS: Readonly<Record<EnsoSecuritySignalKind, string>> = {
  'denial-retry': 'A refusal by the same rule, or of the same command or path, as an earlier one.',
  'command-obfuscation':
    "After refusing a network client by name, the network rule refused a command it couldn't read: a name built at run time, for example.",
  'alternate-execution-path':
    'After a shell refusal, an interpreter handed code on its command line: `python -c`, `node -e`, `sh -c`, `eval`.',
  'tool-substitution-after-denial': 'After a shell refusal, a file written or edited, then run.',
  'policy-introspection': "After a refusal, a call that names the guards' policy or Enso's own files.",
  'protected-record-touch':
    'A shell command that names the session or log directory. The only signal that needs no refusal before it.',
}

const SIGNAL_TABLE = [
  '| Signal | Raised on |',
  '|---|---|',
  ...ENSO_SECURITY_SIGNALS.map((signal) => `| \`${signal}\` | ${SIGNAL_MEANS[signal]} |`),
].join('\n')

/** What a family is, in a reader's words; its tools are the code's. */
const FAMILY_IS: Readonly<Record<EnsoToolFamily, string>> = {
  execute: 'the shell',
  network: 'the web',
  write: 'file writes',
}

const FAMILIES = ENSO_TOOL_FAMILIES.map(
  (family) =>
    `\`${family}\` (${FAMILY_IS[family]}: ${ENSO_FAMILY_TOOLS[family].map((tool) => `\`${tool}\``).join(', ')})`,
).join(', ')

/** Where each judge backend sends the command, in a reader's words. */
const BACKEND_SENDS: Readonly<Record<EnsoJudgeBackend, string>> = {
  off: 'Nothing is judged, and nothing is sent. The default.',
  jev: "TypeSafe's Jev classifier. Needs `TYPESAFE_API_KEY` in `ENSO_HOME/secrets.env`.",
  local:
    'A llama.cpp router on this machine: `security.judge.local.baseUrl` (a loopback address only) and `security.judge.local.model`.',
}

const BACKEND_TABLE = [
  '| `security.judge.backend` | Sends the command to |',
  '|---|---|',
  ...ENSO_JUDGE_BACKENDS.map((backend) => `| \`${backend}\` | ${BACKEND_SENDS[backend]} |`),
].join('\n')

const { windowCalls, highAtSignals, highAtKinds, incidentAtSignals } = DEFAULT_RISK_THRESHOLDS

const CARD: MarkTarget = { role: 'article', name: /^Incident / }
const STATUS: MarkTarget = { label: 'thread status' }
const heading = (name: string): MarkTarget => ({ role: 'heading', name, exact: true, within: CARD })

/**
 * Incidents (#464, #466, #467, #468) and the command judge (#469, #532). The shots are of the
 * page's own thread (`INCIDENT_SCRIPT`), played after every other page's: pi goes around a `curl`
 * refusal, the incident opens and halts, pi files its report, and the second shot resolves it. The
 * judge has no view in the web app, so it is said in words, from its config and its commands.
 */
export const INCIDENTS: FeatureSpec = {
  id: 'incidents',
  title: 'Incidents and the command judge',
  landingTagline: 'signals · halt · report · judge',
  thread: 'incident',
  shows: [
    'Enso watches what pi does after a refusal. A call that retries what was refused, or tries another way to the same thing, raises a *security signal*. The signals add up to a session risk, and when it reaches `incident`, Enso opens an incident: a card at the end of the chat that says what was observed and what is suspended, and takes your resolution.',
    `Each signal reads the call and the refusals before it, within the last ${windowCalls} calls:`,
    SIGNAL_TABLE,
    `The risk is \`medium\` from the first signal, \`high\` at ${highAtSignals} signals or ${highAtKinds} kinds, and \`incident\` at ${incidentAtSignals} signals, or as soon as \`command-obfuscation\` and \`alternate-execution-path\` are both seen.`,
    `By default an incident only alerts. With halting on, it suspends the tool families ${FAMILIES} until you resolve it, and pi is asked for a report on what it did. Nothing but the report tool runs until pi has filed it; after that, reading and searching work again.`,
    'The command judge is a second opinion on the `bash` calls the guards let through: one that comes right after a refusal, or one the guards cannot read, such as a name built at run time, a decoded string or an interpreter one-liner. It asks a classifier model how risky the command is, how hidden its program is, whether it runs code nobody has shown, and, after a refusal, whether it does what was refused. Its answers are recorded. They never block a call or change one.',
    'The judge is off until you choose a backend:',
    BACKEND_TABLE,
  ],
  opens: [
    '{steps}. The card sits at the end of the chat, below the last answer.',
    [
      'Halting, the thresholds and the judge are set in **Settings › Security** (the card\'s "halting is off" opens it), which writes your `config.json` under `ENSO_HOME`. A project cannot set them. In the file:',
      '',
      '```json',
      '{ "security": { "incidents": { "halt": true }, "judge": { "backend": "jev" } } }',
      '```',
    ].join('\n'),
    [
      'From the command line, with the web app running (`bun run dev`):',
      '',
      '```',
      'bun run incidents                     every incident: model, halt, signals, report, resolution',
      'bun run incidents export <incident>   its records, the report and the resolutions, as files',
      'bun run incidents replay --incident-at-signals 3',
      '                                      the stored threads, under other thresholds',
      'bun run judge cases                   which calls would be judged, and the exact requests',
      'bun run judge replay --send           send them to the judge, and save its answers',
      '```',
    ].join('\n'),
  ],
  shots: [
    {
      image: 'incidents-open',
      alt: 'An open incident card, with tools suspended',
      go: async (ui) => {
        await ui.openThread()
        await ui.scrollTo({ role: 'heading', name: /^Incident /, within: CARD })
      },
      region: [CARD, STATUS],
      marks: [
        {
          target: { text: 'open · tools suspended', within: CARD },
          says: '**{shown}**: the incident is open, and it suspended tools when it opened, because halting is on.',
        },
        {
          target: heading('Observed'),
          says: "**{shown}**: each signal: its kind, the call it was raised on, the refusals it came after, and what it saw. The ids are the calls' own, as on their rows above.",
        },
        {
          target: heading('Inferred risk'),
          says: '**{shown}**: the level the signals add up to. A level, not a verdict.',
        },
        {
          target: heading('Suspended tools'),
          says: '**{shown}**: the tool families the incident took away, with their tools.',
        },
        {
          target: { text: 'intervention required', within: STATUS },
          says: '**{shown}**, in the status bar, while an open incident holds tools suspended.',
        },
      ],
      after: [
        'With halting off, the card says `open · halting off` and `nothing suspended`, the status bar says `incident open`, and pi is not asked for a report.',
      ],
    },
    {
      image: 'incidents-resolved',
      alt: "The agent's report and a recorded resolution",
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ label: 'probable bypass' })
        await ui.click({ label: 'resume with restrictions — the families ticked below stay suspended' })
        await ui.click({ label: 'network (web_fetch, web_search)' })
        await ui.click({ role: 'button', name: 'Record resolution' })
        // ⚠ Scrolled on a fresh load: right after the post, the card's re-render keeps the transcript
        // pinned to its end and the wheel does not hold (found on this shot's first captures).
        await ui.page.getByText(/^resolved · /).waitFor()
        await ui.page.reload()
        await ui.page.getByText(/^resolved · /).waitFor()
        await ui.page.waitForTimeout(800)
        await ui.scrollTo(heading("The agent's explanation"))
      },
      region: [heading("The agent's explanation"), heading('Change what stays suspended')],
      marks: [
        {
          target: heading("The agent's explanation"),
          says: "**{shown}**: the report pi filed, kept apart from what was observed. It is pi's account, not the record.",
        },
        {
          target: { text: 'What was denied', exact: true, within: CARD },
          says: '**{shown}**, with the quotes behind it. Each quote names the call it is from, and says `verified` when the words are really there.',
        },
        {
          target: { text: 'The uncharitable read', exact: true, within: CARD },
          says: '**{shown}**: pi states the least charitable reading of what it did.',
        },
        {
          target: heading('Resolutions'),
          says: '**{shown}**: what you judged it to be, the outcome, and what stays suspended.',
        },
        {
          target: heading('Change what stays suspended'),
          says: '**{shown}**: after a resume with restrictions the form stays, so you can lift what is still suspended later.',
        },
      ],
      measure: {
        stateAfter: (page) => page.getByText(/^resolved · /).first(),
      },
      after: [
        "The card's header now reads `{stateAfter}`, and the status bar no longer says `intervention required`. A resolution resumes every family, resumes with the families you tick kept suspended, or ends the thread. Ending it is final: it takes no new prompts, every family stays suspended, and it can still be forked.",
      ],
    },
  ],
  lookFor: [
    'In the thread above, the shell refused `curl`, and pi ran the same download through `sh -c` with the name built at run time, `$(printf cu)rl`. The guard refused that too. That one call raised three signals: an interpreter one-liner after a shell refusal, the same rule refusing again, and a network refusal the guard could not read after a named one. The first and the last together open an incident at once, whatever the count.',
    "Read **The agent's explanation** against **Observed**. The signals are what Enso saw. The report is what pi says about it, and only its quotes are checked: `verified` means the quoted words are in the call or the prompt it names, not that pi's reading of them is right. A report whose **What was denied** does not cite one of the incident's own refusals is flagged.",
    "A resolution starts the risk over: the level, the signals and the window. A refusal from before it cannot pair with a call after it. The card's records, and the resolution's, are kept in the session file, so a reload or a restart shows the same card.",
    'A fork made while an incident is open has an incident of its own, inherited from the source. The card says where it came from, and each thread is resolved on its own.',
    "The judge's answers are in the session file, one `enso-command-judgement` record per judged call, and in the day's log as `command <call> (<scope>) judged by <backend> in <ms>ms`. A call the judge could not answer is recorded as `unjudged`, with why.",
    "The day's stats (`/debug?stats`) count signals by kind, incidents by model, the reports, and the resolutions by what you judged them.",
  ],
  limits: [
    `The thresholds are first guesses, not yet tuned on real sessions. That is why halting is off until you turn it on. \`security.incidents\` takes \`windowCalls\`, \`highAtSignals\`, \`highAtKinds\` and \`incidentAtSignals\` (${windowCalls}, ${highAtSignals}, ${highAtKinds}, ${incidentAtSignals}), and \`bun run incidents replay\` shows what other values would have opened.`,
    'A signal reads what a call says, not what it does. A command the guards never refused, and that names no internals, raises none.',
    "The judge only records. It blocks nothing, its answers don't raise signals or open incidents, and the web app has no view of them yet.",
    "The judge judges `bash` calls only, and only after a refusal or when the guards can't read the command.",
    'The judge sends the command, its recent calls and the refusal before it, with secrets replaced by markers: known secret values, and anything shaped like one. `bun run judge cases` shows exactly what would be sent, and sends nothing.',
    "You can't resolve an incident while the thread is running. Wait for it to stop, or stop it.",
    'The guards are not a sandbox. Records in the session file are protected from the shell, which makes changing them harder and raises a signal, but not impossible.',
  ],
  see: [
    {
      path: 'docs/features/guards-and-receipts.md',
      label: 'Guards and receipts',
      why: 'the refusals the signals follow',
    },
    {
      path: 'docs/features/session-eval.md',
      label: 'Session eval',
      why: "the signals on a thread's timeline, and its risk",
    },
    { path: 'docs/seams/guards.md', label: 'Guards seam', why: 'the policy, the risk fold and the judge' },
    {
      path: 'docs/glossary.md',
      label: 'Glossary',
      why: '*security signal*, *session risk*, *incident*, *suspension*, *incident report* and *command judge*',
    },
  ],
}
