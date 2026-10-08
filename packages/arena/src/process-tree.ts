import { spawnSync } from 'node:child_process'

/**
 * Stopping a process AND what it started (#742). `bun run dev` is a tree: the `bun run` shell, the
 * launcher (`scripts/dev.ts`), the server and the web proxy. A SIGTERM to its root reaches only the
 * root; `scripts/dev.ts` passes it on, then gives its children 500 ms and exits regardless, so a
 * child slower than that outlived the stack, holding a port with no parent left to name it.
 *
 * ⚠ The tree is read BEFORE anything is signalled: once a parent exits, its children are re-parented
 * and no longer read as its descendants.
 */

/** Every running process's parent, from `ps` (Linux and macOS alike). */
function parentsByPid(): Map<number, number> {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  const parents = new Map<number, number>()
  if (listed.status !== 0) return parents
  for (const line of listed.stdout.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number)
    if (pid !== undefined && parent !== undefined && Number.isInteger(pid) && Number.isInteger(parent)) {
      parents.set(pid, parent)
    }
  }
  return parents
}

/** `root` and every process under it, root first. */
export function processTreeOf(root: number): number[] {
  const parents = parentsByPid()
  const tree = [root]
  for (let treeIndex = 0; treeIndex < tree.length; treeIndex++) {
    const parent = tree[treeIndex]
    for (const [pid, itsParent] of parents) if (itsParent === parent && !tree.includes(pid)) tree.push(pid)
  }
  return tree
}

/** Is a process with this id running? Signal 0 asks without sending anything; EPERM means it runs, as someone else. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  } catch {
    // Gone between the read and the signal: what was wanted.
  }
}

async function untilGone(pids: readonly number[], deadline: number): Promise<number[]> {
  let running = pids.filter(isRunning)
  while (running.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100)
    running = running.filter(isRunning)
  }
  return running
}

/**
 * Stop `root` and everything under it: SIGTERM to the root, as a stop always sent, so a launcher
 * still ends its children its own way; after `graceMs`, SIGTERM to whatever of the tree is left;
 * after another `graceMs`, SIGKILL. Settles with the processes still running after all that, which
 * is empty unless one could not be killed (another user's).
 */
export async function stopProcessTree(root: number, graceMs: number): Promise<number[]> {
  const tree = processTreeOf(root)
  signal(root, 'SIGTERM')
  let left = await untilGone(tree, Date.now() + graceMs)
  if (left.length === 0) return left
  for (const pid of left) signal(pid, 'SIGTERM')
  left = await untilGone(left, Date.now() + graceMs)
  for (const pid of left) signal(pid, 'SIGKILL')
  return untilGone(left, Date.now() + graceMs)
}
