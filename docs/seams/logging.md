# Seam: logging

The contract every record of ours crosses: one logger factory, four layers, the properties a record
carries when it knows them, one line shape on disk, and one batch shape the browser ships. Glossary
domain: **Record** (record, level, layer, process, redaction, redaction manifest, bundle, sink, ring).
The substrate behind it is vendored by decision (#132); the gate below keeps it behind `zenLogger`.

Every fence on this page is the source, checked by `test/docs-gate.test.ts`. Refresh with
`bun scripts/docs/refresh-fences.ts docs/seams/logging.md`.

## The contract

The region of our code a record came from — a logger category, not the operating-system process:

<!-- source: packages/core/src/log.ts#ZenLogLayer -->
```ts
/**
 * The region of our code a record came from — the logger category, not the OS process
 * (`process` on every line is that, `log-process.ts`). `extension` is our code inside the
 * runtime's process. `docs/glossary.md` → Record.
 */
export type ZenLogLayer = 'server' | 'host' | 'extension' | 'browser'
```

<!-- source: packages/core/src/log.ts#ZenLogProperties -->
```ts
/**
 * What every record carries when it knows it. These are the identities the wire already
 * has (`ZenObservation`, #112) — a line that names them can be joined to the transcript,
 * the event tail (#97), and the other layers' lines about the same moment.
 */
export interface ZenLogProperties {
  readonly threadId?: string
  /** The acquisition the record belongs to (the `status` frame's `generation`, #109). */
  readonly generation?: number
  /** The observation's sequence on the follow, where the record is about one (#112). */
  readonly seq?: number
  readonly toolCallId?: string
  readonly [key: string]: unknown
}
```

<!-- source: packages/core/src/log.ts#ZenLogger -->
```ts
/**
 * The typed surface. Five levels; `fatal` is not vocabulary here. The tiers (#132):
 * `info` is the spine — what happened; `debug` is every observation, one compact line;
 * `trace` is the same with the payload. `ZEN_LOG_LEVEL` picks the tier (`log-process.ts`).
 */
export interface ZenLogger {
  trace(message: string, properties?: ZenLogProperties): void
  debug(message: string, properties?: ZenLogProperties): void
  info(message: string, properties?: ZenLogProperties): void
  warn(message: string, properties?: ZenLogProperties): void
  error(message: string, properties?: ZenLogProperties): void
  /** A logger whose every record carries `properties` — bind `threadId` once per handler. */
  with(properties: ZenLogProperties): ZenLogger
}
```

<!-- source: packages/core/src/log.ts#zenLogger -->
```ts
/**
 * The one way to get a logger: `zenLogger("server", "follow")` is the category
 * `["zen", "server", "follow"]`, a child of the layer, a grandchild of the root. Module
 * level, once per file.
 */
export function zenLogger(layer: ZenLogLayer, ...subcategory: readonly string[]): ZenLogger {
  return wrap(getLogger([ZEN_LOG_ROOT, layer, ...subcategory]))
}
```

Redaction is by field NAME, at write, before anything reaches a sink. `ZEN_REDACT_FIELDS`
(`log.ts:133`) is five case-insensitive patterns — `api[-_]?key`, `secret`, `password`, `token`,
`credential` — mirroring the secret store's boundary; `token` is deliberate, so a property literally
called `tokens` is dropped by design (lines 127-129: better a missing count than a leaked key). A
redacted field's value becomes the marker below, not a deletion, so the record still says the field
was there; a known secret VALUE found anywhere becomes `ZEN_REDACTED_VALUE` (`'[REDACTED:value]'`,
line 149, #139) — a distinct marker so the manifest counts the two passes separately.

<!-- source: packages/core/src/log.ts#ZEN_REDACTED -->
```ts
/**
 * What a redacted field's value becomes on disk. A MARKER, not a deletion: the record still
 * says the field was there, so a reader knows what is missing rather than wondering, and the
 * bundle (#132 item 5) counts markers per field name for its redaction manifest with no
 * bookkeeping in the writer. The value itself never lands — `log-process.test.ts`.
 */
export const ZEN_REDACTED = '[REDACTED]'
```

One line of the file, pinned so the bundle reader validates what it reads:

<!-- source: packages/core/src/log.ts#ZenLogLine -->
```ts
/**
 * One line of the JSONL file, as LogTape's `jsonLinesFormatter` writes it — pinned here
 * so the bundle reader (#132 item 5) validates what it reads and a formatter change goes
 * red instead of silently reshaping the file. `logger` is the category joined by `.`;
 * `level` is upper-cased on disk and `warning` is written `WARN` (measured, LogTape 2.3.4).
 */
export const ZenLogLine = Type.Object(
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

<!-- source: packages/core/src/log.ts#ZenBrowserLogBatch -->
```ts
/**
 * What the browser ships to `POST /api/logs` (#132 slice 3): its records at `info` and up,
 * batched. The server re-emits each through its own logger as `process: "browser"`, so they
 * land in the same file, redacted by the same sink, and `bun run logs --process browser`
 * finds them. `at` is the browser's clock; the file's `@timestamp` is the server's receipt.
 * `page` tells two tabs apart. `logger` must be under `zen.browser`: the server will not be
 * told what the host or the guard said.
 */
export const ZenBrowserLogBatch = Type.Object(
  {
    page: Type.String({ minLength: 1, maxLength: 64 }),
    records: Type.Array(
      Type.Object(
        {
          at: Type.String(),
          level: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')]),
          logger: Type.String({ pattern: '^zen\\.browser(\\.[A-Za-z0-9-]+)*$' }),
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

A process's sink is configured once, from `@zen/core/log-process` (a subpath, never the barrel —
`log-process.ts:37-41`: the file sink builds on `node:fs` at module evaluation and took the page down
when it was exported from `index.ts`). The configurator's options:

<!-- source: packages/core/src/log-process.ts#ProcessLoggingOptions -->
```ts
export interface ProcessLoggingOptions {
  /** `zenLogsDir(repoRoot)` — created if absent. */
  readonly logsDir: string
  /** Which launcher this is — `server`, `web`, `pi` — on every record it writes, since the file is shared. */
  readonly process: string
  /** From `parseZenLogLevels`; the defaults when omitted: file `info`, no console. */
  readonly levels?: ZenLogLevels
  /**
   * The secret values to scrub wherever they appear, from `knownSecretValues` (#139).
   * Omitted — a test, a process with no secret store — means the value pass does not run.
   *
   * A THUNK — `knownSecretValuesTracking(repoRoot)` — is what a launcher passes (#207): it is
   * asked per record, so a key rotated in `.zen/secrets.env` while the process runs is
   * redacted from the next record on, matching the reader, which was always per call. An
   * array is a snapshot of the set at configure time and stays one.
   */
  readonly secretValues?: readonly string[] | (() => readonly string[])
}
```

`configureProcessLogging` (`log-process.ts:343-423`, in prose) builds a date-named file sink with
`bufferSize: 0` (line 361; measured, header lines 53-62: the buffered sink held the last record until
the next one), creates today's file `0600` before the sink opens it and again on each record, so a
rollover at local midnight does not leave a `0664` file behind (299-334, 345-347, 366-371, #207),
stamps `process` and a per-process `sequence` on every record (366-371), filters by the category's
effective level (372-375), and wraps the file sink — and the console sink when one is configured
(389-396) — in field-name redaction then the value pass (380-386).

## Who implements it, who consumes it

**Three configurators, one per process kind**, each writing into the same day's file: the server
(`packages/web/src/server/dev.ts:30-37`, `process: 'server'`), the web launcher (`dev-web.ts:32-39`,
`'web'`) and the runtime as a child (`packages/harness/extensions/logging/index.ts:40-48`, `'pi'`).

The extension is the interesting one (`logging/index.ts:9-19`): in-process under the web host the
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
200 records, `zen.browser.*` loggers only — and re-emits each record through this process's
`zenLogger('browser', …)` at its level with `process: "browser"`, the tab's `page` and the browser's
`at` (lines 49-56). So the same sink redacts every layer. A bad batch is a 400 that is *not* logged
(lines 12-16): a page in a loop sending garbage would otherwise write one line per attempt.

**`process` versus `layer`** (glossary Record, decision 4). `ProcessLoggingOptions.process`
(`log-process.ts:258-259`) is *which launcher this is — `server`, `web`, `pi` — on every record it
writes, since the file is shared*: the operating-system process. `ZenLogLayer` is the region of our
code: `extension` is our code inside the runtime's process, and under the web host that process is
`server`. Orthogonal on purpose — a browser record is `process: "browser"` because the server
re-emitted it, and `layer: browser` because the page wrote it.

**The redaction manifest** (`log-bundle.ts:46-63`, `redactionManifest`) reads the markers back: a
property valued `ZEN_REDACTED` counts under its field name; a line containing `ZEN_REDACTED_VALUE`
counts under `values`. Two counts on purpose (lines 49-52): a field redacted is a record shaped
right; a `values` row is a leak that was caught. No bookkeeping in the writer.

## What fences it

- **The logging gate** (`test/logging-gate.test.ts`, #132) holds two lines, both ratchets, over
  `packages/core/src`, `packages/web/src` and `packages/harness` (header lines 11-19):
  1. *No production `console.*` in a migrated root* — a `console.error` is a record with no level, no
     thread, no file, and no test that can hear it. The allowlist is empty (line 70).
  2. *`@logtape/*` is imported only where the schema lives and where a process configures its sink* —
     `LOGTAPE_ALLOWED` (lines 35-39) is `core/src/log.ts`, `core/src/log-process.ts` and
     `web/src/browser-logging.ts`, three files, so the record shape is ours to hold and the substrate
     is ours to swap. Comment lines are skipped (line 61), so a guard's doc may quote `console.log`.
- **`log-process.test.ts`** pins that a redacted value never lands (`log.ts:139`) and that a second
  configure in one process throws (`logging/index.ts:16-17`).

## What crosses it that should not

**The substrate is vendored, by decision, and it shows in exactly three files.** `log.ts:8-13` says
what is ours — the layers, the properties, the one way to get a logger — and that nothing outside
this file and the configurators imports the substrate. The three allowlisted files import it by name
(LogTape: `@logtape/logtape`, `@logtape/file`, `@logtape/pretty`, `@logtape/redaction`), and
`ZenLogLine`'s header (`log.ts:151-156`) admits the on-disk shape is the substrate's JSON-lines
formatter, pinned so a formatter change goes red instead of reshaping the file. Not one of goals §2's
numbered leaks — L1–L6 are the loop's boundary — but the same kind of thing, stated: one maintainer,
one seam, one gate, and a `ZenLogger` that never exposes the substrate's `Logger`.

Nothing else. `ZenLogProperties` is open (`[key: string]: unknown`, line 48) — whatever a caller adds
is carried, and field-name redaction at write is the only check it passes; that is the design, not a
leak. The batch, the line shape and the options are ours; no caller sees a substrate type.

## Pivot cost

Replace the substrate and the files that change are the three the gate allows to name it:
`packages/core/src/log.ts` (the `wrap` around the substrate's logger, `withZenLogContext`,
`zenLogLineOf`), `packages/core/src/log-process.ts` (the sinks, the filter, the two redaction
wrappers, `logRecordOf`, the renderer) and `packages/web/src/browser-logging.ts` (the ring, the
shipper and the console over the same `configure`). `packages/harness/extensions/logging/index.ts`
changes only if the *one configurator per process* rule changes, because its `isLoggingConfigured()`
branch is written against that rule; its provider-response record is a `zenLogger` call and stays.

What does not change: every `zenLogger(…)` call site, because `ZenLogger` is five methods and `with`;
`ZenLogLine`, which is the file's shape and would be produced by `zenLogLineOf` if the new substrate's
formatter did not; `ZenBrowserLogBatch` and the logs route, which are wire; the bundle and its
manifest, which read lines and count two markers. The gate is the proof: with the allowlist at three
files, a substrate import anywhere else is a red test that names the file.
