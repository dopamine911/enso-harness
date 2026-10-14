import type {
  EnsoGitFileChange,
  EnsoProjectConfigReview,
  EnsoProjectTierApprovalState,
  EnsoProjectTierReview,
} from '@enso/core'
import { FileWarningIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { Button } from './components/ui/button.tsx'
import { cn } from './lib/utils.ts'
import { PAGE_BANNER, PAGE_PRIMARY_BUTTON } from './page-styles.ts'
import { type ProjectRequestOutcome, requestProjectConfigReview } from './project-list.ts'
import { FileDiff } from './thread-changes.tsx'

/**
 * A project page's review of its own config files (#753), over its tabs: each of
 * `.enso/config.json` and `.enso/config.local.json` that is not the version approved, as the diff
 * from that version to the file now, with **Approve**. Until then the version approved applies — or,
 * for a file never approved, nothing in it — whoever changed it: a tool, a shell command, a commit,
 * a pull. Nothing shows while every file is the version approved.
 *
 * ⚠ AN APPROVAL NAMES WHAT WAS SHOWN: the file's hash as the review read it. A file changed after
 * the page read it is refused by the server, and the review read again, so nothing is approved unseen.
 */

/** Each state's title, what applies meanwhile, and its button. */
const STATE_WORDS: Readonly<
  Record<Exclude<EnsoProjectTierApprovalState, 'approved'>, { title: string; meanwhile: string; approve: string }>
> = {
  changed: {
    title: 'Changed since you approved it',
    meanwhile: 'New threads and trees use the version you approved until you approve this change.',
    approve: 'Approve this version',
  },
  removed: {
    title: 'Removed since you approved it',
    meanwhile: 'New threads and trees use the version you approved until you approve the removal.',
    approve: 'Approve the removal',
  },
  unapproved: {
    title: 'Not approved yet',
    meanwhile: 'Nothing in this file applies until you approve it, setup commands included.',
    approve: 'Approve this version',
  },
}

/** The diff view's status for a file against its approved version: all added when none was approved. */
const DIFF_STATUS: Readonly<Record<Exclude<EnsoProjectTierApprovalState, 'approved'>, EnsoGitFileChange['status']>> = {
  changed: 'modified',
  removed: 'deleted',
  unapproved: 'added',
}

/** A tier's review as the diff view reads a file: its patch, and the lines it adds and removes. */
function changeOf(
  tier: EnsoProjectTierReview,
  state: Exclude<EnsoProjectTierApprovalState, 'approved'>,
): EnsoGitFileChange {
  const lines = tier.patch.split('\n')
  return {
    path: tier.path,
    oldPath: null,
    status: DIFF_STATUS[state],
    added: lines.filter((line) => line.startsWith('+')).length,
    removed: lines.filter((line) => line.startsWith('-')).length,
    patch: tier.patch,
    omitted: null,
  }
}

/** One file to approve: what it is, what applies meanwhile, its diff, and its button. */
function PendingTier({
  tier,
  busy,
  onApprove,
}: {
  tier: EnsoProjectTierReview
  busy: boolean
  onApprove: (tier: EnsoProjectTierReview) => void
}): React.ReactNode {
  if (tier.state === 'approved') return null
  const words = STATE_WORDS[tier.state]
  return (
    <li className="grid gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <FileWarningIcon aria-hidden="true" className="size-4 text-chart-3" />
        {words.title}
      </h3>
      <p className="text-sm text-muted-foreground">{words.meanwhile}</p>
      {tier.problem === undefined ? null : (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <code className="font-mono text-xs break-all">{tier.path}</code> {tier.problem}, so it can’t be approved.
            Fix the file first.
          </span>
        </p>
      )}
      {tier.current === null && tier.problem !== undefined ? null : (
        <div className="-mx-4">
          <FileDiff change={changeOf(tier, tier.state)} />
        </div>
      )}
      <Button
        type="button"
        className={cn(PAGE_PRIMARY_BUTTON, 'justify-self-start')}
        disabled={busy || tier.problem !== undefined}
        onClick={() => onApprove(tier)}
      >
        {busy ? 'Approving…' : words.approve}
      </Button>
    </li>
  )
}

/**
 * The project's config review, read when it opens and whenever `revision` moves (a save on the
 * Worktrees tab writes and approves a file). `onApproved` says an approval went through: what the
 * project's settings resolve to changed.
 */
export function ProjectConfigApproval({
  projectId,
  fetch: fetchImpl,
  revision = 0,
  onApproved,
}: {
  projectId: string
  fetch?: FetchLike | undefined
  revision?: number
  onApproved: () => void
}): React.ReactNode {
  const [review, setReview] = useState<ProjectRequestOutcome<EnsoProjectConfigReview> | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  useEffect(() => {
    let current = true
    void requestProjectConfigReview(projectId, undefined, fetchImpl).then((outcome) => {
      if (current) setReview(outcome)
    })
    return () => {
      current = false
    }
  }, [projectId, fetchImpl, revision])
  const approve = async (tier: EnsoProjectTierReview): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await requestProjectConfigReview(projectId, { tier: tier.tier, sha256: tier.current }, fetchImpl)
      if (outcome.kind === 'ok') {
        setReview(outcome)
        onApproved()
        return
      }
      setFailure(`Not approved: ${outcome.reason}`)
      // The file may have changed under the page: show it as it is now.
      setReview(await requestProjectConfigReview(projectId, undefined, fetchImpl))
    } finally {
      setBusy(false)
    }
  }
  if (review === undefined) return null
  if (review.kind === 'refused') {
    return (
      <p role="alert" className="text-sm text-destructive">
        config approval not read: {review.reason}
      </p>
    )
  }
  const pending = review.value.tiers.filter((tier) => tier.state !== 'approved')
  if (pending.length === 0 && failure === undefined) return null
  return (
    <section aria-labelledby="config-approval-title" className={cn(PAGE_BANNER, 'border-chart-3')}>
      <h2 id="config-approval-title" className="flex items-center gap-2 font-semibold">
        <TriangleAlertIcon aria-hidden="true" className="size-4 text-chart-3" />
        This project’s settings files need your approval
      </h2>
      <p className="text-sm text-muted-foreground">
        Enso applies only the version of each file you approved, whoever changed it since: pi, a commit or a pull. Read
        the change, then approve it.
      </p>
      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <ul aria-label="files to approve" className="grid gap-6">
        {pending.map((tier) => (
          <PendingTier key={tier.tier} tier={tier} busy={busy} onApprove={(chosen) => void approve(chosen)} />
        ))}
      </ul>
    </section>
  )
}
