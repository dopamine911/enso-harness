import { createStore, type Store } from './store.ts'

/**
 * The page's clock as a store (#278): the one value that changes with no input.
 *
 * Every relative age on the page ("3m") used to be computed from a `new Date()` read in
 * `ChatScreen`'s render and passed down as a prop. That read is impure — a different value
 * on every render, twice per render under StrictMode — and, worse, it only happened when
 * something ELSE re-rendered the page: an idle page's ages stopped moving, silently, while
 * still looking like live readings. A clock is exactly what an external store is for, so it
 * is one, and `useStore` is how a component reads it.
 *
 * ⚠ SUBSCRIBE AT THE LEAF. The tick re-renders whatever read the clock, so the component
 * that reads it must be the label and not the page: in `threads-rail.tsx` it is the `Age`
 * span, so a tick does not re-render the rail, the panes or the transcript.
 *
 * ⚠ The interval exists only while something is subscribed, and the value is refreshed AT
 * subscribe — a page showing no age holds no timer, and a page that mounts one after an
 * hour asleep does not paint the hour-old reading (React re-checks the snapshot right after
 * subscribing and re-renders when it has moved).
 *
 * ⚠ A STATIC RENDER (`renderToStaticMarkup`) never subscribes, so it reads the initial
 * value: the moment this module loaded. That is what keeps a static render of the rail
 * deterministic — there is no clock in it to drift.
 */

/**
 * 5s — `relativeAge`'s own floor (under five seconds every age reads `now`), so no reading
 * is ever stale by more than the resolution it is displayed at. One interval per page.
 */
const PAGE_CLOCK_PERIOD_MS = 5000

/**
 * A clock that ticks every `periodMs` while it has a subscriber.
 *
 * The period is a parameter so a test can drive one at test speed; the page's own clock is
 * {@link pageClock}.
 */
export function createClockStore(periodMs: number): Store<Date> {
  const store = createStore(new Date())
  let subscribers = 0
  let stopTicking: (() => void) | undefined
  return {
    get: store.get,
    subscribe: (listener: () => void) => {
      const unsubscribe = store.subscribe(listener)
      subscribers += 1
      if (stopTicking === undefined) {
        store.set(new Date())
        const ticking = setInterval(() => store.set(new Date()), periodMs)
        stopTicking = () => clearInterval(ticking)
      }
      return () => {
        unsubscribe()
        subscribers -= 1
        if (subscribers === 0 && stopTicking !== undefined) {
          stopTicking()
          stopTicking = undefined
        }
      }
    },
  }
}

/** The one clock every relative age on this page reads. */
export const pageClock: Store<Date> = createClockStore(PAGE_CLOCK_PERIOD_MS)
