/**
 * Vendored from the shadcn/ui registry — item `spinner`, `shadcn/ui radix-nova` style
 * (packages/web/components.json), fetched by `shadcn@4.20.1` in cc84ab4 (#31). MIT.
 * See README.md here for the re-fetch procedure and the local changes.
 */
import { cn } from "@/lib/utils.ts"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
