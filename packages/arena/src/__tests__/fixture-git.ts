import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * git in a fixture repository, in an environment of its own: git by absolute path, an empty `HOME`,
 * no system config, the identity as flags, and NOTHING inherited from the process.
 *
 * ⚠ The suite runs inside the pre-commit gate, under git's hook environment. A fixture's `git add .`
 * and `commit` that inherit a `GIT_DIR` act on the repository running the suite, with the fixture as
 * its work tree. Measured while building #624: with `GIT_DIR` inherited, one fixture commit staged
 * every file of this checkout as deleted and moved its branch.
 */
const git = Bun.which('git') ?? 'git'
const environment = {
  PATH: dirname(git),
  HOME: mkdtempSync(join(tmpdir(), 'arena-git-home-')),
  GIT_CONFIG_NOSYSTEM: '1',
}

export function gitIn(directory: string, ...args: string[]): void {
  spawnSync(git, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: directory,
    env: environment,
  })
}
