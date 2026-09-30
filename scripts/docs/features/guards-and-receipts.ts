import { ENSO_GUARD_RULES, type EnsoGuardRule } from '../../../packages/core/src/guard.ts'
import { stringRecordIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

/**
 * What each rule refuses, in a reader's words. Keyed by the rule type, so a rule added to
 * `ENSO_GUARD_RULES` fails the typecheck here until it has its row.
 */
const REFUSES: Readonly<Record<EnsoGuardRule, string>> = {
  'secret-read':
    'Reading credential material: `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, `.env` files, private keys, `ENSO_HOME` itself.',
  'secret-path': 'A shell command that names a credential path.',
  'environment-dump': 'Listing the environment, or expanding a secret-shaped variable.',
  'network-egress':
    'Network clients in the shell (`curl`, `wget`, `ssh`, `nc` and others). `web_fetch` is the way to the web.',
  'cc-safety-net': 'Destructive shell commands, such as `git reset --hard` or `rm -rf` on a protected path.',
  'write-confinement': 'A write outside the workspace.',
  'protected-internals': 'A write into `.git/`.',
  'persistence-write':
    'A write to something that runs later: shell profiles, `.gitconfig`, editor and agent config folders.',
  'secret-write': 'A write to a file that looks like a credential.',
  'stale-write': 'An edit to a file that changed on disk since pi last read it.',
  'read-before-write': 'Overwriting an existing file pi never read.',
  'policy-mismatch': 'Everything, when the policy names a tool pi does not have. It fails closed.',
}

/** The words a refusal's header says for each rule: the receipt's own (`guard-refusal.tsx`). */
const VERDICT = stringRecordIn('packages/web/src/guard-refusal.tsx', 'GUARD_RULE_VERDICT')

function verdictOf(rule: EnsoGuardRule): string {
  const words = VERDICT[rule]
  if (words === undefined) throw new Error(`guards-and-receipts: guard-refusal.tsx has no verdict for ${rule}`)
  return words
}

/** Every rule the guards know, in the order the code declares them. */
const RULE_TABLE = [
  '| Rule | The receipt says | Refuses |',
  '|---|---|---|',
  ...ENSO_GUARD_RULES.map((rule) => `| \`${rule}\` | ${verdictOf(rule)} | ${REFUSES[rule]} |`),
].join('\n')

const REFUSED_READ: MarkTarget = { label: 'read, refused by Enso guard' }
const REFUSED_CURL: MarkTarget = { label: 'bash, refused by Enso guard' }
const FAILED_CAT: MarkTarget = { toolCall: 'cat docs/deploy.md' }

/** Guards and receipts (#387): the demo thread's three refusals and its one failure. */
export const GUARDS_AND_RECEIPTS: FeatureSpec = {
  id: 'guards-and-receipts',
  title: 'Guards and receipts',
  shows: [
    "Enso's guards check every tool call before it runs, and refuse the ones that break a rule. A refused call does not run at all. It shows in the chat as a receipt that names the guard and the rule, beside the reason pi was given.",
    'The guards refuse, by rule:',
    RULE_TABLE,
  ],
  opens: [
    'There is nothing to open. A refusal appears in the chat where the call would have been, and the status bar counts it as `refused`. The **Stats** tab counts refusals apart from failures.',
  ],
  shots: [
    {
      image: 'guards-receipt',
      alt: 'A refused read, as a receipt',
      go: async (ui) => {
        await ui.openThread()
        await ui.scrollTo(REFUSED_READ)
      },
      region: [REFUSED_READ],
      marks: [
        {
          target: { text: '.env', exact: true, within: REFUSED_READ },
          says: 'What pi asked for: a read of `{shown}`.',
        },
        {
          target: { text: /^Reading "\.env" via read is blocked/, within: REFUSED_READ },
          says: 'The reason, word for word as pi received it.',
        },
        {
          target: { text: 'secret-read', exact: true, within: REFUSED_READ },
          says: `The rule that refused it, \`{shown}\`. The header above says the same thing in words: **${verdictOf('secret-read')}**.`,
        },
      ],
    },
    {
      image: 'guards-refused-and-failed',
      alt: 'A failed call, then a refused one',
      go: async (ui) => {
        await ui.openThread()
        await ui.scrollTo(FAILED_CAT)
      },
      region: [FAILED_CAT, REFUSED_CURL],
      marks: [
        {
          target: { ...FAILED_CAT, summary: true },
          says: 'A failed call: `cat docs/deploy.md` ran, and the file does not exist. The row opens itself and shows **error**.',
        },
        {
          target: { text: verdictOf('network-egress'), within: REFUSED_CURL },
          says: 'A refused call: `curl` never ran. The header reads **{shown}**, and the reason names `web_fetch` as the way to the web.',
        },
        { target: { text: 'Enso guard', within: REFUSED_CURL }, says: '**{shown}**: who refused it.' },
      ],
      measure: {
        // The Stats tab's line under the failures: the same thread's refusals, counted apart.
        refusedApart: async (page) => {
          await page.getByRole('tab', { name: 'Stats', exact: true }).click()
          return page.getByText('refused by a guard — not failures').first()
        },
      },
    },
  ],
  lookFor: [
    'Three outcomes look alike to pi, and Enso keeps them apart for you:',
    [
      '- *Refused*: an Enso guard stopped the call before it ran. You get a receipt with the rule. pi sees an error result carrying the reason.',
      '- *Failed*: the call ran and did not succeed, like the `cat` above. It is a red row with **in** and **out**.',
      '- *Provider-refused*: the model provider turned the request down, for example because of a rate limit or a missing login. It shows as a line naming the model and the class, such as `rate-limited (429)`.',
    ].join('\n'),
    "pi's own record makes no difference between the first two: both are error results. Enso records every refusal next to the call, so the receipt is still there after a reload, and **Stats** says `{refusedApart}` instead of counting every one as a failure.",
    'A good refusal is one pi recovers from. In the thread above, pi reads `src/config.ts` instead of `.env`, tells you it could not confirm the value, and after the `curl` refusal it tries `web_fetch`, as the reason told it to.',
  ],
  limits: [
    'The guards are not a sandbox. They refuse known kinds of calls. They do not confine the process. `git push`, interpreters such as `python -c`, and writes made through the shell (`echo x >> ~/.bashrc`) are not checked.',
    'A refusal is not an error in Enso. pi is not stopped: it reads the reason and carries on.',
    "The guards apply to pi's tools. They do not check what you type yourself in a terminal.",
  ],
  see: [
    { path: 'docs/seams/guards.md', label: 'Guards seam', why: 'the policy and each rule' },
    {
      path: 'docs/flows/guarded-tool-call.md',
      label: 'A guarded tool call',
      why: 'step by step, from the call to the receipt',
    },
    { path: 'docs/glossary.md', label: 'Glossary', why: 'the difference between a bar and a boundary' },
    { path: 'docs/concepts/pi-immediate-needs.md', label: "pi's immediate needs", why: 'why these rules come first' },
  ],
}
