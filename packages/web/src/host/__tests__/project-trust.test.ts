import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasTrustRequiringProjectResources, ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { ENSO_PROJECT_TRUST_ENTRY, THREAD_PROJECT_TRUST } from '@enso/core'
import { realpathOrSelf } from '@enso/core/paths'
import { hasTrustGatedResources, hostedProjectTrust } from '../project-trust.ts'
import { transcriptOf } from '../transcript.ts'

/**
 * #502: the host's trust decision, against real directories and pi's real `trust.json` store. The
 * run gate and the reload are proven end to end in `agent-host.test.ts`; this is the decision.
 */

function directories(): { project: string; agentDir: string } {
  const root = realpathOrSelf(mkdtempSync(join(tmpdir(), 'enso-502-trust-')))
  const project = join(root, 'project')
  const agentDir = join(root, 'agent')
  mkdirSync(project)
  mkdirSync(agentDir)
  return { project, agentDir }
}

const threadTrusted = [{ type: 'custom', customType: ENSO_PROJECT_TRUST_ENTRY, data: THREAD_PROJECT_TRUST }]

test("the engine's .pi/agents and Enso's .enso/config.json are trust-gated, though pi's list has neither (#502)", () => {
  const agents = directories().project
  mkdirSync(join(agents, '.pi', 'agents'), { recursive: true })
  const enso = directories().project
  mkdirSync(join(enso, '.enso'))
  writeFileSync(join(enso, '.enso', 'config.json'), '{}')
  expect([hasTrustRequiringProjectResources(agents), hasTrustGatedResources(agents)]).toEqual([false, true])
  expect(hasTrustGatedResources(enso)).toBe(true)
  expect(hasTrustGatedResources(directories().project)).toBe(false)
})

test('undecided is untrusted even with nothing to load, and asked about only when there is something (#502)', () => {
  const plain = directories()
  expect(hostedProjectTrust(plain.project, plain.agentDir, [])).toMatchObject({ open: false })
  expect(hostedProjectTrust(plain.project, plain.agentDir, []).settingsManager.isProjectTrusted()).toBe(false)
  const gated = directories()
  mkdirSync(join(gated.project, '.pi', 'agents'), { recursive: true })
  expect(hostedProjectTrust(gated.project, gated.agentDir, []).open).toBe(true)
})

test("a saved answer beats the thread's record, which beats the default (#502)", () => {
  const refused = directories()
  new ProjectTrustStore(refused.agentDir).set(refused.project, false)
  const saved = hostedProjectTrust(refused.project, refused.agentDir, transcriptOf(threadTrusted))
  expect([saved.settingsManager.isProjectTrusted(), saved.open]).toEqual([false, false])

  const never = directories()
  writeFileSync(join(never.agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'never' }))
  expect(
    hostedProjectTrust(never.project, never.agentDir, transcriptOf(threadTrusted)).settingsManager.isProjectTrusted(),
  ).toBe(true)

  const always = directories()
  writeFileSync(join(always.agentDir, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }))
  expect(hostedProjectTrust(always.project, always.agentDir, transcriptOf([])).settingsManager.isProjectTrusted()).toBe(
    true,
  )
})
