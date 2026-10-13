import type { EnsoTreeSetupOutcome, EnsoTreeSetupStep } from '@enso/core'
import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible.tsx'
import { tierWords } from './project-worktrees.tsx'

/**
 * What preparing a thread's tree did (#754), in the "What this thread built" panel: the files
 * copied in, the ones missing, and each setup command with its output on demand.
 *
 * ⚠ A FAILURE IS SAID WITHOUT EXPANDING ANYTHING. The thread opens even when setup failed, and a
 * tree with no `node_modules` fails later, far from the cause (a pre-commit hook that cannot run).
 * So the failing command, its exit and the tier whose list it came from — the file to fix — are on
 * the panel's face; only the output waits behind its step.
 */

/** A command's end in words: its exit code, or that it never finished (its time ran out, or it could not start). */
function exitWords(step: EnsoTreeSetupStep): string {
  return step.exitCode === null ? 'stopped, or could not start' : `exit ${step.exitCode}`
}

/** The panel's first line: what ran and whether it went well, or what failed and which file to fix. */
function SetupSummary({ setup }: { setup: EnsoTreeSetupOutcome }): React.ReactNode {
  const ran = setup.steps.length
  if (setup.ok) {
    return (
      <p>{ran === 0 ? 'Setup: no commands to run (ok)' : `Setup: ${ran} command${ran === 1 ? '' : 's'} ran (ok)`}</p>
    )
  }
  const failed = setup.steps.find((step) => step.exitCode !== 0)
  return (
    <div role="alert" className="flex items-start gap-1.5 text-destructive">
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {failed === undefined ? (
        <p>
          Setup failed: {setup.missing.length} file{setup.missing.length === 1 ? '' : 's'} to copy missing — the list is
          in {tierWords(setup.tiers.copy)}.
        </p>
      ) : (
        <p>
          Setup failed at <code className="font-mono">{failed.command}</code> ({exitWords(failed)}) — the commands are
          in {tierWords(setup.tiers.setup)}.
        </p>
      )}
    </div>
  )
}

/** One command, with its output behind a toggle: monospace, scrollable, its tail when it was long. */
function SetupStep({ step }: { step: EnsoTreeSetupStep }): React.ReactNode {
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-1 text-left hover:underline">
          <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0 group-data-[state=open]:rotate-90" />
          <span>
            output of <code className="font-mono text-xs">{step.command}</code> — {exitWords(step)},{' '}
            {(step.durationMs / 1000).toFixed(1)}s
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1 max-h-60 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
            {step.truncated ? '… (only its end is kept)\n' : ''}
            {step.output.length === 0 ? '(no output)' : step.output}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** A tree's setup as the panel shows it (#754): the summary first, then the files, then each command. */
export function TreeSetupReport({ setup }: { setup: EnsoTreeSetupOutcome }): React.ReactNode {
  return (
    <div className="grid gap-1.5">
      <SetupSummary setup={setup} />
      {setup.copied.length === 0 ? null : (
        <p className="text-muted-foreground">
          Copied in: <code className="font-mono text-xs">{setup.copied.join(', ')}</code>
        </p>
      )}
      {setup.missing.length === 0 ? null : (
        <p className="text-destructive">
          Missing, not copied: <code className="font-mono text-xs">{setup.missing.join(', ')}</code>
        </p>
      )}
      {setup.steps.length === 0 ? null : (
        <ul aria-label="setup commands" className="grid gap-1">
          {keyedSteps(setup.steps).map(({ key, step }) => (
            <SetupStep key={key} step={step} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** Each step with a stable key: its command, and which occurrence of it — a setup may run one command twice. */
function keyedSteps(steps: readonly EnsoTreeSetupStep[]): { key: string; step: EnsoTreeSetupStep }[] {
  const seen = new Map<string, number>()
  return steps.map((step) => {
    const occurrence = (seen.get(step.command) ?? 0) + 1
    seen.set(step.command, occurrence)
    return { key: `${step.command}#${occurrence}`, step }
  })
}
