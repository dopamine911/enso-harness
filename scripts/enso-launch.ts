/**
 * The terminal launcher's decisions, apart from the launch (`enso.ts` spawns; this decides):
 * the isolation triple as pi's arguments and the print-run trigger. Whether the pi it is about to
 * spawn is one the guard was pinned against is `@enso/core`'s since #953
 * (`packages/core/src/supported-pi-versions.ts`), because the harness checks the same range. Pure so
 * `scripts/__tests__/enso-launch.test.ts` can pin them — the launcher itself has no test,
 * because it spawns pi (docs/flows/boot-and-launchers.md).
 *
 * ⚠ The vendor-path precondition is NOT here. It was, in a copy of its own, until #221 gave
 * pi's manifest-resource layout one owner: `@enso/core/pi-manifest`. `enso.ts` calls that
 * directly, as the server and the linker do.
 */

/**
 * ⚠ PRINT RUNS LOAD A VARIANT PACKAGE WITHOUT THE PERMISSION ENGINE (#20, #496). The trigger is
 * "this run cannot prompt": an explicit `-p`/`--print`, or stdin that is not a TTY (piped
 * input cannot answer a permission dialog even without -p). Interactive runs keep the full
 * package and the full permission model.
 */
export function isPrintRun(passthroughArgs: readonly string[], stdinIsTty: boolean): boolean {
  return passthroughArgs.includes('-p') || passthroughArgs.includes('--print') || !stdinIsTty
}

/**
 * pi's arguments: the isolation triple's two argument legs, then whatever the user passed. The
 * third leg, `PI_CODING_AGENT_DIR`, is on the spawn's environment, not an argument.
 *
 * @invariant boot-and-launchers/isolation-triple Isolation is three mechanisms, each closing a different hole, and the same three at both launch points.
 * `PI_CODING_AGENT_DIR` points the runtime at `ENSO_HOME/pi-agent` (`~/.enso`, #421): none of the
 * user's packages, settings or credentials are visible. `--no-extensions` turns discovery off,
 * including this repo's own `.pi/settings.json`, which installs the package and would load it twice.
 * `--no-skills` is required and covered by neither: `~/.agents/skills/` is outside the agent dir.
 * They go BEFORE the user's arguments, so a flag the user adds cannot displace them. The host applies
 * the same triple as loader options and sets the env at creation, before the first services (it is
 * read at module import).
 *
 * The permission policy is prepared the same way at both points (#446, #496): `preparePermissionPolicy`
 * seeds `ENSO_HOME/permissions.json` with Enso's policy when it holds none, links the engine's
 * config path under the agent dir to it, and writes the mode agents; an unreadable file is refused,
 * and the launcher says which on stderr, the host in its log.
 *
 * @invariant boot-and-launchers/package-dir `-e` receives the package directory, never extension files.
 * Loaded by package rules, the manifest drives every resource kind: extensions, skills, prompts and
 * themes. Files passed individually loaded the extensions and silently dropped everything else. The
 * ONE package is the harness, or its print variant.
 */
export function piArguments(packageToLoad: string, passthroughArgs: readonly string[]): string[] {
  return ['--no-extensions', '--no-skills', '-e', packageToLoad, ...passthroughArgs]
}

/** What a print run's launch line says after the package: the variant it loads instead (#20). */
export const PRINT_VARIANT_NOTE = '(print variant, no permission engine — #20)'

/** The launch's line naming every variable removed from pi's environment (#89), without its newline. */
export function secretsKeptOutLine(removed: readonly string[]): string {
  return `enso: secrets kept out of pi's environment (#89): ${removed.join(', ')}`
}

/**
 * Whether the web surface would list threads of `projectPath` (#552): a `projects.json` entry names
 * it, or it is the directory the web server launches in — Enso's own checkout under `bun run dev`,
 * which is a project without an entry (`server/projects.ts`: the launch project, never removable).
 * Paths are compared canonical; the caller canonicalises both sides.
 */
export function isRegisteredProject(
  projectPath: string,
  registered: readonly string[],
  webLaunchDirectory: string,
): boolean {
  return projectPath === webLaunchDirectory || registered.includes(projectPath)
}

/**
 * The launch's line naming the project its threads file under (#552): the directory pi is
 * launched in, by id. When the web surface would not list it, say so — it lists a project's
 * threads only once the directory is registered, and a terminal launched in a subdirectory of a
 * registered project is its own, unregistered project.
 */
export function projectLine(launch: {
  readonly projectId: string
  readonly cwd: string
  readonly registered: boolean
}): string {
  return (
    `enso: project=${launch.projectId} (${launch.cwd})` +
    (launch.registered
      ? ''
      : ' — not in projects.json: the web surface lists these threads once this directory is registered as a project')
  )
}

/** What the launch is about to spawn, as its last line before pi's own screen says it. */
export interface VanillaPiLaunch {
  readonly piVersion: string
  readonly agentDir: string
  readonly packageToLoad: string
  readonly printRun: boolean
  readonly declaredResourceCount: number
}

/** The launch's line naming the pi it spawns, and with what, without its newline. */
export function vanillaPiLine(launch: VanillaPiLaunch): string {
  return (
    `enso: vanilla pi ${launch.piVersion} | agent-dir=${launch.agentDir} | package=${launch.packageToLoad}` +
    `${launch.printRun ? ` ${PRINT_VARIANT_NOTE}` : ''} | ` +
    `${launch.declaredResourceCount} declared resource path(s)`
  )
}
