/**
 * The terminal launcher's decisions, apart from the launch (`zen.mjs` spawns; this decides):
 * the isolation triple as pi's arguments and the print-run trigger. Pure so
 * `scripts/__tests__/zen-launch.test.ts` can pin them — the launcher itself has no test,
 * because it spawns pi (docs/flows/boot-and-launchers.md).
 *
 * ⚠ The vendor-path precondition is NOT here. It was, in a copy of its own, until #221 gave
 * pi's manifest-resource layout one owner: `@zen/core/pi-manifest`. `zen.mjs` calls that
 * directly, as the server and the linker do.
 */

/**
 * ⚠ PRINT RUNS LOAD A VARIANT PACKAGE WITHOUT picc-permission-modes (#20). The trigger is
 * "this run cannot prompt": an explicit `-p`/`--print`, or stdin that is not a TTY (piped
 * input cannot answer a permission dialog even without -p). Interactive runs keep the full
 * package and the full permission model.
 * @param {readonly string[]} passthroughArgs
 * @param {boolean} stdinIsTty
 */
export function isPrintRun(passthroughArgs, stdinIsTty) {
  return passthroughArgs.includes('-p') || passthroughArgs.includes('--print') || !stdinIsTty
}

/**
 * pi's arguments: the isolation triple, then whatever the user passed.
 *   --no-extensions  disables discovery, which also suppresses the PROJECT-local
 *                    `.pi/settings.json` that would otherwise load this package twice;
 *   --no-skills      ⚠ REQUIRED, and neither the agent dir nor --no-extensions covers it:
 *                    pi discovers skills from `~/.agents/skills/` too;
 *   -e <package>     the ONE package to load — the harness, or its print variant.
 * (`PI_CODING_AGENT_DIR` is the third leg, on the spawn's environment, not an argument.)
 * @param {string} packageToLoad
 * @param {readonly string[]} passthroughArgs
 * @returns {string[]}
 */
export function piArguments(packageToLoad, passthroughArgs) {
  return ['--no-extensions', '--no-skills', '-e', packageToLoad, ...passthroughArgs]
}
