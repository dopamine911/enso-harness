# Reference

Generated facts for the refactor (#170, under #167). These pages answer questions whose answers move
with code. Each starts with `<!-- generated: … -->`; `test/docs-gate.test.ts` runs its generator and
fails when the checked-in page differs. Regenerate with `bun <generator> > <page>` and review the diff.

| Page | Question answered | Generator |
|---|---|---|
| [HTTP routes](./routes.md) | What routes exist; what crosses each; what can build, mutate or log? | `scripts/docs/routes.ts` |
| [Observations](./observations.md) | What produces every observation kind; what the browser derives; who consumes it? | `scripts/docs/observations.ts` |
| [Core exports](./core-exports.md) | What `@zen/core` exposes; is it wire, host contract, policy or node-only; who imports it? | `scripts/docs/core-exports.ts` |
| [Environment and configuration](./env-and-config.md) | What enters by environment, committed config, `.zen/` path or harness manifest; when is it read? | `scripts/docs/env-and-config.ts` |
| [Code-local decisions](./decisions.md) | Which leading source headers record a decision, which issues own it, and what sentence opens it? | `scripts/docs/decisions.ts` |
| [Verification inventory](./verification-inventory.md) | What every gate enforces; what ratchets; which reusable test double drives which seam? | `scripts/docs/verification-inventory.ts` |

Generated does not mean inferred. Where behavior cannot be derived safely, a generator carries an
explicit checked metadata record and fails when detection and metadata stop agreeing. `UNCLASSIFIED`
is a failure, never an omitted row. Generators are deterministic: sorted rows, no timestamp, machine
path, Git state, network or GitHub call.

Read the reference after the relevant [seam page](../seams/README.md): a seam explains the boundary
and pivot cost; the reference lists the current facts at that boundary.
