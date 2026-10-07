import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'

/**
 * A header control that opens a dialog — Rename (#670), Delete (#571), Prompts (#443), Settings: an
 * icon button with its accessible name and its hover, opening a dialog with a title and a line
 * saying what it does above its body. The open state is the caller's, so a dialog that must not be
 * dismissed mid-request can refuse to close.
 */
export function HeaderDialog({
  open,
  onOpenChange,
  label,
  hover,
  icon,
  title,
  description,
  contentClassName,
  showCloseButton = true,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The button's accessible name. */
  label: string
  hover: string
  icon: React.ReactNode
  title: string
  description: React.ReactNode
  contentClassName: string
  showCloseButton?: boolean
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} title={hover}>
          {icon}
        </Button>
      </DialogTrigger>
      <DialogContent className={contentClassName} showCloseButton={showCloseButton}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
