import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'

/**
 * The site's social card: the image a link to the site shows on Slack, X, LinkedIn and the rest,
 * which read `og:image` (`site/astro.config.ts` → `head`). Without one, a page asking for a large
 * card (Starlight sets `twitter:card` to `summary_large_image`) previews as bare text.
 *
 *   bun run docs:social-card [--chromium <path to a chrome binary>]
 *
 * ⚠ IT SAYS WHAT THE PAGE SAYS. The text is read from the landing's own source — the hero's kicker
 * (`LandingHero.astro`) and its title (`index.astro` → `hero.title`) — never typed here, and the
 * text it was rendered from is recorded beside it (`SOCIAL_CARD_RECORD`). `test/site-gate.test.ts`
 * fails when the hero's wording has moved on and the card has not been regenerated.
 *
 * Rendered from HTML in the dark theme as hello-enso draws it (`src/styles/theme.css`), with the
 * site's fonts, at the 1200×630 every preview crops from.
 */

const ROOT = findRepoRoot(import.meta.url)

/** Served from the site's root; `astro.config.ts` points `og:image` at it. */
export const SOCIAL_CARD_IMAGE = 'site/public/social-card.png'
/** The hero text the card was rendered from. Not served: a record for the gate. */
export const SOCIAL_CARD_RECORD = 'site/src/social-card.json'
export const SOCIAL_CARD_SIZE = { width: 1200, height: 630 } as const

export interface HeroText {
  readonly kicker: string
  /** As the page writes it: the part after `|` is the muted second line. */
  readonly title: string
}

/** The hero's kicker and title, read from the landing's source. */
export function landingHeroText(root: string = ROOT): HeroText {
  const hero = readFileSync(join(root, 'site/src/components/LandingHero.astro'), 'utf8')
  const page = readFileSync(join(root, 'site/src/pages/index.astro'), 'utf8')
  const kicker = /<div class="eyebrow">([^<]+)<\/div>/.exec(hero)?.[1]?.trim()
  const title = /hero:\s*\{\s*title:\s*'([^']+)'/.exec(page)?.[1]
  if (kicker === undefined || title === undefined) {
    throw new Error("social-card: the hero's kicker or title is not where this reads it")
  }
  return { kicker, title }
}

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function cardHtml(text: HeroText, mascot: string): string {
  const [lead = '', rest = ''] = text.title.split('|').map((part) => part.trim())
  return `<!doctype html>
<html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@500&family=Sora:wght@600&display=block">
<style>
  html, body { margin: 0; }
  body {
    width: 1200px; height: 630px; box-sizing: border-box; padding: 64px 80px;
    display: flex; flex-direction: column; background: #0a0d14; color: #f4f6fb;
    background-image:
      radial-gradient(900px 520px at 88% 0%, rgba(63, 216, 240, 0.12), transparent 60%),
      radial-gradient(760px 480px at 0% 100%, rgba(167, 139, 250, 0.09), transparent 60%);
  }
  .brand { display: flex; align-items: center; gap: 18px; font: 600 38px/1 Sora, sans-serif; letter-spacing: -0.02em; }
  .brand img { width: 64px; height: 64px; border-radius: 12px; mix-blend-mode: screen; }
  .kicker { margin-top: auto; font: 500 21px/1.4 "JetBrains Mono", monospace; letter-spacing: 0.1em;
    text-transform: uppercase; color: #3fd8f0; }
  h1 { margin: 22px 0 0; font: 600 82px/1.02 Sora, sans-serif; letter-spacing: -0.045em; }
  h1 span { display: block; color: #9aa6bd; }
  .site { margin-top: 40px; font: 500 20px/1 "JetBrains Mono", monospace; color: #9aa6bd; }
</style></head>
<body>
  <div class="brand"><img src="${mascot}" alt="">Enso</div>
  <div class="kicker">${escapeHtml(text.kicker)}</div>
  <h1>${escapeHtml(lead)}<span>${escapeHtml(rest)}</span></h1>
  <div class="site">www.enso.engineer</div>
</body></html>`
}

async function main(): Promise<void> {
  const text = landingHeroText()
  const mascot = `data:image/png;base64,${readFileSync(join(ROOT, 'site/src/assets/landing/enso-smile.png')).toString('base64')}`
  const chromiumFlag = process.argv.indexOf('--chromium')
  const executablePath = chromiumFlag >= 0 ? process.argv[chromiumFlag + 1] : undefined
  // Loaded here, not at the top: the gate imports this module for `landingHeroText`, and has no
  // business loading a browser to do it.
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  try {
    const page = await browser.newPage({ viewport: SOCIAL_CARD_SIZE, deviceScaleFactor: 1 })
    await page.setContent(cardHtml(text, mascot), { waitUntil: 'networkidle' })
    // A string, evaluated in the page: this script has no DOM types. `true` because a FontFaceSet
    // does not survive the trip back.
    await page.evaluate('document.fonts.ready.then(() => true)')
    await page.screenshot({ path: join(ROOT, SOCIAL_CARD_IMAGE) })
  } finally {
    await browser.close()
  }
  writeFileSync(join(ROOT, SOCIAL_CARD_RECORD), `${JSON.stringify(text, null, 2)}\n`)
  process.stdout.write(`social-card: wrote ${SOCIAL_CARD_IMAGE} from "${text.kicker}" / "${text.title}"\n`)
}

if (import.meta.main) await main()
