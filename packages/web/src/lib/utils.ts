import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge knows Tailwind's own scales, not the ones `styles/global.css` names: without these,
 * `text-detail` reads as a COLOUR (so a later `text-refuse` drops it) and `shadow-pop` never
 * replaces a primitive's `shadow-md` — both kept, the stylesheet's order deciding (#417).
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['meta', 'tag', 'message', 'detail', 'figure', 'brand'],
      shadow: ['pop', 'save-bar', 'glow-evidence', 'glow-human'],
      tracking: ['label'],
    },
    classGroups: { 'border-w': [{ border: ['dot'] }] },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
