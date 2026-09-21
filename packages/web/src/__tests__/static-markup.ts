import { Window } from 'happy-dom'

/**
 * What a `<select>` in a `renderToStaticMarkup` string offers, read through a DOM (#236).
 *
 * ⚠ WHY: the assertions this replaced read React's SSR SERIALISATION, not behaviour.
 * `toContain('<option value="plan" selected="">plan</option>')` pins how React 19 spells
 * selectedness — true of a correct render, and false of a React upgrade that spells it
 * differently while the control still works — and `toContain('disabled')` matched the
 * `disabled:opacity-60` class in EVERY render, so a test named "the control is disabled while a
 * run is in flight" stayed green with the `disabled` prop deleted from the component.
 *
 * ⚠ NOT `dom-environment.ts`. That registers a browser on `globalThis` for the tests that MOUNT
 * React, and must be released in `afterAll` or the server tests get the wrong `fetch` and
 * `Response`. This parses one string in a throwaway window and touches no global, so a
 * static-render test stays DOM-free where that matters.
 */

interface RenderedSelect {
  /** Whether the control takes input at all. */
  readonly disabled: boolean
  /** The values on offer, in order. */
  readonly options: readonly string[]
  /** The visible text of each option, in order. */
  readonly labels: readonly string[]
  /** The value of the initially selected option, `undefined` if none is. */
  readonly selected: string | undefined
}

export function selectIn(markup: string): RenderedSelect {
  const window = new Window({ url: 'http://localhost/' })
  window.document.body.innerHTML = markup
  // happy-dom implements the same interfaces under its own declarations; read the element
  // through the standard ones.
  const select = (window.document as unknown as Document).querySelector<HTMLSelectElement>('select')
  if (select === null) throw new Error('the render contains no <select>')
  const options = [...select.options]
  return {
    disabled: select.disabled,
    options: options.map((option) => option.value),
    labels: options.map((option) => option.textContent ?? ''),
    // ⚠ The `selected` ATTRIBUTE rather than `select.value`: in static markup the initially
    // selected option IS that attribute — HTML's rule, not React's spelling, so presence is
    // what we read and never the text around it. `select.value` would be the obvious read and
    // is WRONG here: measured 2026-09-18 on happy-dom 20.14, markup whose third option carries
    // `selected` parses with `select.value === 'plan'` (the second) and `option.selected` on
    // the wrong element. The mounted tests are unaffected — React sets the property there.
    selected: options.find((option) => option.hasAttribute('selected'))?.value,
  }
}
