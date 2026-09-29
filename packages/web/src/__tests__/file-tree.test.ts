import { expect, test } from 'bun:test'
import type { EnsoGitFileChange } from '@enso/core'
import { buildFileTree, filesInOrder, type TreeNode } from '../file-tree.ts'

/**
 * #452: the changed files as a tree — directories first, names sorted, totals per directory, and a
 * chain of single-directory levels folded into one row.
 */

const change = (path: string, added: number | null = 1, removed: number | null = 0): EnsoGitFileChange => ({
  path,
  oldPath: null,
  status: 'modified',
  added,
  removed,
  patch: null,
  omitted: null,
})

/** The tree as names, indented by depth — what a reader sees. */
function outline(nodes: readonly TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === 'file'
      ? [`${'  '.repeat(depth)}${node.name}`]
      : [`${'  '.repeat(depth)}${node.name}/ +${node.added} −${node.removed}`, ...outline(node.children, depth + 1)],
  )
}

test('directories come before files, each sorted; a directory totals the files under it', () => {
  const tree = buildFileTree([
    change('README.md', 2, 1),
    change('src/b.ts', 3, 0),
    change('src/a.ts', 1, 4),
    change('docs/guide.md', 5, 5),
  ])
  expect(outline(tree.children)).toEqual(['docs/ +5 −5', '  guide.md', 'src/ +4 −4', '  a.ts', '  b.ts', 'README.md'])
  expect(tree.added).toBe(11)
})

test('a chain of directories holding one directory each is one row; the root is never folded', () => {
  const tree = buildFileTree([change('packages/web/src/app.ts'), change('packages/web/src/lib/util.ts')])
  expect(outline(tree.children)).toEqual(['packages/web/src/ +2 −0', '  lib/ +1 −0', '    util.ts', '  app.ts'])
  const folded = tree.children[0]
  expect(folded?.kind === 'directory' ? folded.path : undefined).toBe('packages/web/src')
})

test("a binary file's unknown counts add nothing to its directory", () => {
  expect(buildFileTree([change('assets/logo.png', null, null), change('assets/a.css', 2, 1)]).added).toBe(2)
})

test('the files in drawing order — the order the first file shown is chosen by', () => {
  const tree = buildFileTree([change('z.md'), change('a/y.md'), change('a/b/x.md')])
  expect(filesInOrder(tree).map((file) => file.path)).toEqual(['a/b/x.md', 'a/y.md', 'z.md'])
})
