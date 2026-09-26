import { cn } from './lib/utils.ts'

/**
 * Enso's marks (the design direction's brand sheet, `Enso-Design-Direction/`).
 *
 * `EnsoSmile` is the painted mascot, unaltered: `public/enso-smile.png`, the export's
 * `enso-smile.png` scaled to 256px. Its ground is black, not transparent — on a dark theme it is
 * SCREEN-blended, so the black takes the surface's colour and only the glow remains; on a light
 * theme it sits on its own rounded dark tile, as the brand sheet shows it on paper.
 *
 * `EnsoRing` is the export's proposal for the sizes the painting cannot hold (a transcript's
 * speaker label): one stroke in the current text colour, so a theme colours it.
 */
export function EnsoSmile({ className }: { className?: string }): React.ReactNode {
  return <img src="/enso-smile.png" alt="" className={cn('shrink-0 rounded-md dark:mix-blend-screen', className)} />
}

export function EnsoRing({ className }: { className?: string }): React.ReactNode {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <path d="M44 11.2A24 24 0 1 0 54.55 23.79" strokeWidth="6" />
      <circle cx="24" cy="28" r="3.2" fill="currentColor" stroke="none" />
      <circle cx="40" cy="28" r="3.2" fill="currentColor" stroke="none" />
      <path d="M23 38q9 8 18 0" strokeWidth="4.5" />
    </svg>
  )
}
