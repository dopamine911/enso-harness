import type { ArenaEventBody, ArenaShotCause } from './timeline.ts'

/**
 * The run's Enso stack (#556, #838): `bun run dev <project>` as a child the recorder outlives. Its
 * output goes to its log, its start and exit to the timeline, and `restart-enso` stops it and
 * starts another. The process, the web check and the tree's stop are the recorder's to inject.
 */

/** The running stack: Bun's `Subprocess`, or a test's stand-in. */
export interface ArenaStackChild {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

export interface ArenaStackOptions {
  /** Start `bun run dev <project>`; `onExit` hears its exit code, or the signal that ended it. */
  readonly spawn: (onExit: (code: number | null, signal: number | null) => void) => ArenaStackChild
  /** Whether Enso's page answered in time, once started. */
  readonly answered: () => Promise<boolean>
  /** Stop the process tree under `pid` (#742): the pids still running after. */
  readonly stopTree: (pid: number) => Promise<readonly number[]>
  /** One piece of the stack's output, for its log. */
  readonly log: (text: string) => void
  readonly record: (body: ArenaEventBody) => void
  readonly shoot: (cause: ArenaShotCause) => Promise<unknown>
  /** A new stack is running: the control record names its pid (#607). */
  readonly started: (pid: number) => void
  /** The run is stopping: an exit then is the recorder's own stop, not Enso dying. */
  readonly stopping: () => boolean
}

export interface ArenaStack {
  /** Start the stack: whether its page answered. */
  readonly start: () => Promise<boolean>
  /** Stop the stack's whole tree; a tree that outlives it is a `recorder-error` line. */
  readonly stop: () => Promise<void>
  /** The running stack's pid; undefined once it exited or was stopped. */
  readonly pid: () => number | undefined
}

export function createEnsoStack(options: ArenaStackOptions): ArenaStack {
  let enso: ArenaStackChild | undefined
  const pipeToLog = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) options.log(new TextDecoder().decode(chunk))
  }
  return {
    start: async () => {
      // ⚠ Only the stack running now dies on the timeline: a restart's stopped one exits after its
      // successor started, and the run's own stop at its end is no crash.
      const child = options.spawn((code, signal) => {
        if (enso !== child || options.stopping()) return
        enso = undefined
        options.record({ kind: 'enso-exit', exit: String(code ?? signal ?? 'unknown') })
        void options.shoot('enso-exit')
      })
      enso = child
      options.started(child.pid)
      void pipeToLog(child.stdout)
      void pipeToLog(child.stderr)
      options.record({ kind: 'enso-start' })
      return options.answered()
    },
    stop: async () => {
      const child = enso
      enso = undefined
      if (child === undefined) return
      // The whole tree (#742): `bun run dev` alone leaves a child slower than its launcher's 500 ms.
      const left = await options.stopTree(child.pid)
      if (left.length > 0)
        options.record({ kind: 'recorder-error', during: 'stopping Enso', error: `still running: ${left.join(', ')}` })
    },
    pid: () => enso?.pid,
  }
}
