import { expect, test } from 'bun:test'
import { highlightLines, languageOf } from '../diff-highlight.ts'

/**
 * #461: a changed file's syntax, in the theme's own tokens. The file is tokenised in slices so the
 * page stays live; a construct that spans two slices must read as one.
 */

test('a file is tokenised whole across slices: a block comment open at one slice’s end colours the next', async () => {
  // Slices are 200 lines: the comment opens on line 199 and closes on line 203.
  const lines = [
    ...Array.from({ length: 198 }, (_, lineIndex) => `const value${lineIndex} = ${lineIndex}`),
    '/* a comment that opens here',
    '   and runs past the slice',
    '   const notCode = 1',
    '   still the comment',
    '*/',
    'const after = 2',
  ]
  const highlighted = await highlightLines(lines.join('\n'), 'typescript')
  expect(highlighted).toHaveLength(lines.length)
  // Line 201 is inside the comment: every token muted, `const` no keyword.
  expect(highlighted[200]?.map((token) => token.className)).toEqual(['text-muted-foreground'])
  expect(highlighted[203]?.find((token) => token.text === 'const')?.className).toBe('text-chart-4')
  // The tokens spell each line exactly: the view draws them only then.
  expect(highlighted.map((tokens) => tokens.map((token) => token.text).join(''))).toEqual(lines)
})

test('a path names its language by extension or name; any other is not guessed at', () => {
  expect(languageOf('src/app.ts')).toBe('typescript')
  expect(languageOf('src/App.JSX')).toBe('tsx')
  expect(languageOf('deploy/Dockerfile')).toBe('dockerfile')
  expect(languageOf('src/main.zig')).toBeUndefined()
  expect(languageOf('.env')).toBeUndefined()
})
