import { Button } from './components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.tsx'

/** The button that opens a header dialog: its accessible name, its hover and its icon. */
export interface HeaderDialogTrigger {
  readonly label: string
  readonly hover: string
  readonly icon: React.ReactNode
}

/**
 * A header dialog — Delete (#571), Prompts (#443), Settings: a dialog with a title and a line saying
 * what it does above its body, opened by an icon button with its accessible name and its hover —
 * or, with no `trigger`, by its caller (the thread menu's Delete, #879). The open state is the
 * caller's, so a dialog that must not be dismissed mid-request can refuse to close.
 */
export function HeaderDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  contentClassName,
  showCloseButton = true,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: HeaderDialogTrigger | undefined
  title: string
  description: React.ReactNode
  contentClassName: string
  showCloseButton?: boolean
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger === undefined ? null : (
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={trigger.label} title={trigger.hover}>
            {trigger.icon}
          </Button>
        </DialogTrigger>
      )}
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
