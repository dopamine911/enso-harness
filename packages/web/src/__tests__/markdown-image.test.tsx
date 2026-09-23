import { afterAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type * as MarkdownImageModule from '../markdown-image.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client evaluates — `command-palette.test.tsx` has the reason.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { MarkdownImage, remoteImageHost }: typeof MarkdownImageModule = await import('../markdown-image.tsx')

afterAll(releaseDom)

/** `act` over async work, typed as the promise it is (the pattern `model-state.test.tsx` uses). */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

// The half the static tests cannot reach: the click is what loads it, and only the click.
test('a remote markdown image loads when its button is clicked, not before', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await flush(async () => root.render(<MarkdownImage alt="chart" src="https://images.example/chart.png" />))
  expect(container.querySelector('img')).toBeNull()

  const button = container.querySelector<HTMLButtonElement>('button[aria-label="load image from images.example"]')
  if (button === null) throw new Error('expected the click-to-load button')
  await flush(async () => button.click())

  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://images.example/chart.png')
  expect(container.querySelector('button')).toBeNull()
  await flush(async () => root.unmount())
  container.remove()
})

// A source that is not a URL at all still waits for a click, and the button names no fake host.
test('an unparseable image source is remote, named as an unrecognised address', () => {
  expect(remoteImageHost('http://[')).toBe('an unrecognised address')
})
