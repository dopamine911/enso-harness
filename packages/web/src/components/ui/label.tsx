/**
 * Vendored from the shadcn/ui registry — item `label`, `shadcn/ui radix-nova` style
 * (packages/web/components.json), fetched by `shadcn@4.20.1` (the settings dialog's theme field). MIT.
 * See README.md here for the re-fetch procedure and the local changes.
 */
import * as React from "react"
import { cn } from "@/lib/utils.ts"
import { Label as LabelPrimitive } from "radix-ui"

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
