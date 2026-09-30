import type { EnsoGitFileChange } from '@enso/core'

/**
 * The Diff view's file tree (#452): the changed files, by directory, the way a reader scans a
 * change — directories first, then files, each sorted by name, and each directory carrying the lines
 * added and removed under it.
 *
 * ⚠ ONE ROW FOR A CHAIN. A directory whose only child is another directory is folded into it
 * (`packages/web/src`), as editors do: a deep tree with one change in it is one row, not four.
 */

export interface TreeFile {
  readonly kind: 'file'
  /** The file's own name. */
  readonly name: string
  readonly change: EnsoGitFileChange
}

export interface TreeDirectory {
  readonly kind: 'directory'
  /** Its name, or a folded chain's names joined with `/`. */
  readonly name: string
  /** Its path from the root: the key its open or closed state is kept under. */
  readonly path: string
  readonly children: readonly TreeNode[]
  /** The lines added and removed in every file under it, binary and too-large files aside. */
  readonly added: number
  readonly removed: number
}

export type TreeNode = TreeFile | TreeDirectory

/** A directory while the tree is built: children by name. */
interface Building {
  readonly directories: Map<string, Building>
  readonly files: TreeFile[]
}

/** Code-point order, the same on every machine (a locale's collation is not). */
function byName(first: TreeNode, second: TreeNode): number {
  if (first.name < second.name) return -1
  return first.name > second.name ? 1 : 0
}

function place(root: Building, change: EnsoGitFileChange): void {
  const segments = change.path.split('/')
  const name = segments.pop() ?? change.path
  let directory = root
  for (const segment of segments) {
    let next = directory.directories.get(segment)
    if (next === undefined) {
      next = { directories: new Map(), files: [] }
      directory.directories.set(segment, next)
    }
    directory = next
  }
  directory.files.push({ kind: 'file', name, change })
}

/** The lines added and removed under a list of nodes. */
function totals(nodes: readonly TreeNode[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const node of nodes) {
    added += node.kind === 'file' ? (node.change.added ?? 0) : node.added
    removed += node.kind === 'file' ? (node.change.removed ?? 0) : node.removed
  }
  return { added, removed }
}

function finish(building: Building, name: string, path: string): TreeDirectory {
  const only = building.directories.size === 1 && building.files.length === 0 ? [...building.directories][0] : undefined
  // A directory holding exactly one directory and no file is folded into it (not the root).
  if (only !== undefined && path !== '') {
    const [childName, child] = only
    return finish(child, `${name}/${childName}`, `${path}/${childName}`)
  }
  const directories = [...building.directories].map(([childName, child]) =>
    finish(child, childName, path === '' ? childName : `${path}/${childName}`),
  )
  const children = [...directories.sort(byName), ...[...building.files].sort(byName)]
  return { kind: 'directory', name, path, children, ...totals(children) }
}

/** The changed files as a tree; the root is unnamed, and its children are the top level. */
export function buildFileTree(files: readonly EnsoGitFileChange[]): TreeDirectory {
  const root: Building = { directories: new Map(), files: [] }
  for (const change of files) place(root, change)
  return finish(root, '', '')
}

/** The tree's files in the order it draws them — the order the arrow keys and "first file" go by. */
export function filesInOrder(directory: TreeDirectory): EnsoGitFileChange[] {
  return directory.children.flatMap((node) => (node.kind === 'file' ? [node.change] : filesInOrder(node)))
}
