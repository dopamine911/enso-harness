import { Window } from 'happy-dom'

/**
 * What a setting chip (#877, #878) in a `renderToStaticMarkup` string says, read through a DOM (#236).
 *
 * ⚠ WHY: assertions on the markup string read React's SSR SERIALISATION, not behaviour —
 * `toContain('disabled')` matched a `disabled:opacity-60` class in EVERY render, so a test named
 * "the control is disabled while a run is in flight" stayed green with the `disabled` prop deleted
 * from the component. The chip is read here as an element: its accessible name, and the property.
 *
 * ⚠ NOT `dom-environment.ts`. That registers a browser on `globalThis` for the tests that MOUNT
 * React, and must be released in `afterAll` or the server tests get the wrong `fetch` and
 * `Response`. This parses one string in a throwaway window and touches no global, so a
 * static-render test stays DOM-free where that matters.
 */

interface RenderedChip {
  /** Its accessible name: `Mode: plan`. */
  readonly name: string
  /** Whether it takes input at all. */
  readonly disabled: boolean
}

/** The chip for `label` — the button whose name is `<label>: …`. */
export function chipIn(markup: string, label: string): RenderedChip {
  const window = new Window({ url: 'http://localhost/' })
  window.document.body.innerHTML = markup
  // happy-dom implements the same interfaces under its own declarations; read the element
  // through the standard ones.
  const chip = [...(window.document as unknown as Document).querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label')?.startsWith(`${label}: `),
  )
  if (chip === undefined) throw new Error(`the render has no ${label} chip`)
  return { name: chip.getAttribute('aria-label') ?? '', disabled: chip.disabled }
}
