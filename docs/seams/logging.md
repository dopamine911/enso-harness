# Seam: logging

The contract every record of ours crosses: one logger factory, four layers, the properties a record
carries when it knows them, one line shape on disk, and one batch shape the browser ships. Glossary
domain: **Record** (record, level, layer, process, redaction, redaction manifest, bundle, sink, ring).
The substrate behind it is vendored by decision (#132); the gate below keeps it behind `ensoLogger`.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/logging.md`.

## The contract

The region of our code a record came from — a logger category, not the operating-system process:

<!-- source: packages/core/src/log.ts#EnsoLogLayer -->
```ts
/**
 * The region of our code a record came from — the logger category, not the OS process
 * (`process` on every line is that, `log-process.ts`).
 *
 * `extension` is our code inside the runtime's process. `docs/glossary.md` → Record.
 */
export type EnsoLogLayer = 'server' | 'host' | 'extension' | 'browser'
```

<!-- source: packages/core/src/log.ts#EnsoLogProperties -->
```ts
/**
 * What every record carries when it knows it.
 *
 * These are the identities the wire already has (`EnsoObservation`, #112) — a line that names
 * them can be joined to the transcript, the event tail (#97), and the other layers' lines about
 * the same moment.
 */
export interface EnsoLogProperties {
  readonly threadId?: string
  /** The acquisition the record belongs to (the `status` frame's `generation`, #109). */
  readonly generation?: number
  /** The observation's sequence on the follow, where the record is about one (#112). */
  readonly seq?: number
  readonly toolCallId?: string
  readonly [key: string]: unknown
}
```

<!-- source: packages/core/src/log.ts#EnsoLogger -->
```ts
/**
 * The typed surface.
 *
 * Five levels; `fatal` is not vocabulary here. The tiers (#132): `info` is the spine — what
 * happened; `debug` is every observation, one compact line; `trace` is the same with the
 * payload. `ENSO_LOG_LEVEL` picks the tier (`log-process.ts`).
 */
export interface EnsoLogger {
  trace(message: string, properties?: EnsoLogPayload): void
  debug(message: string, properties?: EnsoLogPayload): void
  info(message: string, properties?: EnsoLogPayload): void
  warn(message: string, properties?: EnsoLogPayload): void
  error(message: string, properties?: EnsoLogPayload): void
  /** A logger whose every record carries `properties` — bind `threadId` once per handler. */
  with(properties: EnsoLogProperties): EnsoLogger
}
```

A payload may be the object or a THUNK that builds it (#284). The level gate runs first, so a
record the tier drops costs the call site nothing — which is the difference between a per-token
path that logs and one that cannot afford to. `with` stays eager: a bound context is built once.

<!-- source: packages/core/src/log.ts#EnsoLogPayload -->
```ts
/**
 * A record's payload, or a THUNK that builds it.
 *
 * LogTape evaluates the thunk only after the level gate has admitted the record
 * (`@logtape/logtape/dist/logger.d.ts:164`), so a call site on a per-token path pays nothing
 * for a record the tier drops — and the default tier drops `debug` and `trace`
 * (`log-process.ts`'s `DEFAULT_FILE_LEVEL`).
 *
 * ⚠ Pass a thunk wherever the payload is BUILT for the call (#284). An object literal of
 * ids already in hand is cheaper eagerly; a payload that spreads, maps or carries a whole
 * observation is not. The thunk runs at most once, when a sink will read it.
 */
export type EnsoLogPayload = EnsoLogProperties | (() => EnsoLogProperties)
```

<!-- source: packages/core/src/log.ts#ensoLogger -->
```ts
/**
 * The one way to get a logger: `ensoLogger("server", "follow")` is the category
 * `["enso", "server", "follow"]`, a child of the layer, a grandchild of the root.
 *
 * Module level, once per file.
 */
export function ensoLogger(layer: EnsoLogLayer, ...subcategory: readonly string[]): EnsoLogger {
  return wrap(getLogger([ENSO_LOG_ROOT, layer, ...subcategory]))
}
```

Redaction is by field NAME, at write, before anything reaches a sink. `ENSO_REDACT_FIELDS`
(`log.ts:145`) is five case-insensitive patterns — `api[-_]?key`, `secret`, `password`, `token`,
`credential` — mirroring the secret store's boundary; `token` is deliberate, so a property literally
called `tokens` is dropped by design (lines 165-167: better a missing count than a leaked key). A
redacted field's value becomes the marker below, not a deletion, so the record still says the field
was there; a known secret VALUE found anywhere becomes `ENSO_REDACTED_VALUE` (`'[REDACTED:value]'`,
line 197, #139) — a distinct marker so the manifest counts the two passes separately.

<!-- source: packages/core/src/log.ts#ENSO_REDACTED -->
```ts
/**
 * What a redacted field's value becomes on disk.
 *
 * A MARKER, not a deletion: the record still says the field was there, so a reader knows what
 * is missing rather than wondering, and the bundle (#132 item 5) counts markers per field name
 * for its redaction manifest with no bookkeeping in the writer. The value itself never lands —
 * `log-process.test.ts`.
 */
export const ENSO_REDACTED = '[REDACTED]'
```

One line of the file, pinned so the bundle reader validates what it reads:

<!-- source: packages/core/src/log.ts#EnsoLogLine -->
```ts
/**
 * One line of the JSONL file, as LogTape's `jsonLinesFormatter` writes it — pinned here
 * so the bundle reader (#132 item 5) validates what it reads and a formatter change goes
 * red instead of silently reshaping the file.
 *
 * `logger` is the category joined by `.`; `level` is upper-cased on disk and `warning` is
 * written `WARN` (measured, LogTape 2.3.4).
 */
export const EnsoLogLine = Type.Object(
  {
    '@timestamp': Type.String(),
    level: Type.Union([
      Type.Literal('TRACE'),
      Type.Literal('DEBUG'),
      Type.Literal('INFO'),
      Type.Literal('WARN'),
      Type.Literal('ERROR'),
      Type.Literal('FATAL'),
    ]),
    message: Type.Optional(Type.String()),
    logger: Type.String(),
    properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
)
```

What the browser ships to `POST /api/logs`:

<!-- source: packages/core/src/log.ts#EnsoBrowserLogBatch -->
```ts
/**
 * What the browser ships to `POST /api/logs` (#132 slice 3): its records at `info` and up,
 * batched.
 *
 * The server re-emits each through its own logger as `process: "browser"`, so they land in the
 * same file, redacted by the same sink, and `bun run logs --process browser` finds them. `at`
 * is the browser's clock; the file's `@timestamp` is the server's receipt. `page` tells two
 * tabs apart. `logger` must be under `enso.browser`: the server will not be told what the host
 * or the guard said.
 */
export const EnsoBrowserLogBatch = Type.Object(
  {
    page: Type.String({ minLength: 1, maxLength: 64 }),
    records: Type.Array(
      Type.Object(
        {
          at: Type.String(),
          level: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')]),
          logger: Type.String({ pattern: '^enso\\.browser(\\.[A-Za-z0-9-]+)*$' }),
          message: Type.String({ maxLength: 4096 }),
          properties: Type.Record(Type.String(), Type.Unknown()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 200 },
    ),
  },
  { additionalProperties: false },
)
```

A process's sink is configured once, from `@enso/core/log-process` (a subpath, never the barrel —
`log-process.ts:37-41`: the file sink builds on `node:fs` at module evaluation and took the page down
when it was exported from `index.ts`). The configurator's options:

<!-- source: packages/core/src/log-process.ts#ProcessLoggingOptions -->
```ts
export interface ProcessLoggingOptions {
  /** `logsDirFrom(environment)` — created if absent. */
  readonly logsDir: string
  /** Which launcher this is — `server`, `web`, `pi` — on every record it writes, since the file is shared. */
  readonly process: string
  /** From `parseEnsoLogLevels`; the defaults when omitted: file `info`, no console. */
  readonly levels?: EnsoLogLevels
  /**
   * The secret values to scrub wherever they appear, from `knownSecretValues` (#139).
   * Omitted — a test, a process with no secret store — means the value pass does not run.
   *
   * A THUNK — `knownSecretValuesTracking(home)` — is what a launcher passes (#207): it is
   * asked per record, so a key rotated in `ENSO_HOME/secrets.env` while the process runs is
   * redacted from the next record on, matching the reader, which was always per call. An
   * array is a snapshot of the set at configure time and stays one.
   */
  readonly secretValues?: readonly string[] | (() => readonly string[])
}
```

`configureProcessLogging` (`log-process.ts:501-581`, in prose) builds a date-named file sink with
`bufferSize: 0` (line 395; measured, header lines 53-62: the buffered sink held the last record until
the next one), creates today's file `0600` before the sink opens it and again on each record, so a
rollover at local midnight does not leave a `0664` file behind (323-339, 349-352, 370-375, #207),
stamps `process` and a per-process `sequence` on every record (370-375), filters by the category's
effective level (376-379), and wraps the file sink — and the console sink when one is configured
(393-398) — in field-name redaction then the value pass (384-390).

## Who implements it, who consumes it

**Three configurators, one per process kind**, each writing into the same day's file: the server
(`process: 'server'`) and the web launcher (`'web'`), both through `startLauncher`
(`log-process.ts:361-405`), which first moves a checkout's old `.enso/` into `ENSO_HOME` (#421), and
the runtime as a child (`packages/harness/extensions/logging/index.ts:39-47`, `'pi'`).

The extension is the interesting one (`logging/index.ts:11-21`): in-process under the web host the
server configured before the runtime existed, `isLoggingConfigured()` is true, and it configures
nothing — the extensions' records land in the server's file through the server's sinks. As a child
of the terminal launcher nothing has configured, so it does, with no console sink (stderr is the
terminal's). A second `configure` throws by the substrate's design; that is the whole reason the check
exists. The same extension writes the one record only an extension can: the provider's request id
and rate-limit headers, from an explicit four-name list (lines 56-67) so an `authorization` or
`set-cookie` header is never echoed into a file the manifest says is safe.

**The browser is the fourth layer and has its own configurator** (`packages/web/src/browser-logging.ts:13-36`):
a ring of the last 200 records at every level (the drawer's and the bundle's), a shipper that batches
`info` and up to `POST /api/logs` and flushes with `sendBeacon` on hide, and a devtools console. A
failed POST is dropped: *it is the log, and the log must never make more log* (lines 25-26).
`server/logs-route.ts:29-58` receives the batch — capped at 256 KiB (line 19), closed schema, at most
200 records, `Enso.browser.*` loggers only — and re-emits each record through this process's
`ensoLogger('browser', …)` at its level with `process: "browser"`, the tab's `page` and the browser's
`at` (lines 49-56). So the same sink redacts every layer. A bad batch is a 400 that is *not* logged
(lines 12-16): a page in a loop sending garbage would otherwise write one line per attempt.

**`process` versus `layer`** (glossary Record, decision 4). `ProcessLoggingOptions.process`
(`log-process.ts:335-336`) is *which launcher this is — `server`, `web`, `pi` — on every record it
writes, since the file is shared*: the operating-system process. `EnsoLogLayer` is the region of our
code: `extension` is our code inside the runtime's process, and under the web host that process is
`server`. Orthogonal on purpose — a browser record is `process: "browser"` because the server
re-emitted it, and `layer: browser` because the page wrote it.

**The redaction manifest** (`log-bundle.ts:47-64`, `redactionManifest`) reads the markers back: a
property valued `ENSO_REDACTED` counts under its field name; a line containing `ENSO_REDACTED_VALUE`
counts under `values`. Two counts on purpose (lines 50-53): a field redacted is a record shaped
right; a `values` row is a leak that was caught. No bookkeeping in the writer.

## What fences it

- **The logging gate** (`test/logging-gate.test.ts`, #132) holds two lines, both ratchets, over
  `packages/core/src`, `packages/web/src` and `packages/harness` (header lines 10-21):
  1. *No production `console.*` in a migrated root* — a `console.error` is a record with no level, no
     thread, no file, and no test that can hear it. The allowlist is empty (line 60).
  2. *`@logtape/*` is imported only where the schema lives and where a process configures its sink* —
     `LOGTAPE_ALLOWED` (lines 36-40) is `core/src/log.ts`, `core/src/log-process.ts` and
     `web/src/browser-logging.ts`, three files, so the record shape is ours to hold and the substrate
     is ours to swap. Comment lines are skipped (line 51), so a guard's doc may quote `console.log`.
- **`log-process.test.ts`** pins that a redacted value never lands (`log.ts:151`), that a payload
  thunk runs only for a record the tier admits (#284), and that a second configure in one process
  throws (`logging/index.ts:18-19`).

## What crosses it that should not

**The substrate is vendored, by decision, and it shows in exactly three files.** `log.ts:8-13` says
what is ours — the layers, the properties, the one way to get a logger — and that nothing outside
this file and the configurators imports the substrate. The three allowlisted files import it by name
(LogTape: `@logtape/logtape`, `@logtape/file`, `@logtape/pretty`, `@logtape/redaction`), and
`EnsoLogLine`'s header (`log.ts:163-168`) admits the on-disk shape is the substrate's JSON-lines
formatter, pinned so a formatter change goes red instead of reshaping the file. Not one of the
[numbered leaks](./README.md#leak-numbers) — L1–L6 are the loop's boundary — but the same kind of
thing, stated: one maintainer, one seam, one gate, and a `EnsoLogger` that never exposes the
substrate's `Logger`.

Nothing else. `EnsoLogProperties` is open (`[key: string]: unknown`, line 48) — whatever a caller adds
is carried, and field-name redaction at write is the only check it passes; that is the design, not a
leak. The batch, the line shape and the options are ours; no caller sees a substrate type.

## Pivot cost

Replace the substrate and the files that change are the three the gate allows to name it:
`packages/core/src/log.ts` (the `wrap` around the substrate's logger, `withEnsoLogContext`,
`ensoLogLineOf`), `packages/core/src/log-process.ts` (the sinks, the filter, the two redaction
wrappers, `logRecordOf`, the renderer) and `packages/web/src/browser-logging.ts` (the ring, the
shipper and the console over the same `configure`). `packages/harness/extensions/logging/index.ts`
changes only if the *one configurator per process* rule changes, because its `isLoggingConfigured()`
branch is written against that rule; its provider-response record is a `ensoLogger` call and stays.

What does not change: every `ensoLogger(…)` call site, because `EnsoLogger` is five methods and `with`;
`EnsoLogLine`, which is the file's shape and would be produced by `ensoLogLineOf` if the new substrate's
formatter did not; `EnsoBrowserLogBatch` and the logs route, which are wire; the bundle and its
manifest, which read lines and count two markers. The gate is the proof: with the allowlist at three
files, a substrate import anywhere else is a red test that names the file.
