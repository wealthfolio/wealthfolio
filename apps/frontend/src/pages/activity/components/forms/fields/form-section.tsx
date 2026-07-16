import type { ReactNode } from "react";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { cn } from "@/lib/utils";

interface FormSectionProps {
  /** Uppercase section label shown in the card header (e.g. "Asset & Account"). */
  title: string;
  /** Optional control rendered at the right edge of the header (e.g. a toggle). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Override the content wrapper classes (default stacks children with gap-4). */
  contentClassName?: string;
}

/**
 * Titled card section used to group related activity-form fields. Renders an
 * uppercase tracked label and an optional right-aligned action (a toggle).
 */
export function FormSection({
  title,
  action,
  children,
  className,
  contentClassName,
}: FormSectionProps) {
  return (
    <Card className={className}>
      <CardContent className={cn("space-y-4 p-4", contentClassName)}>
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h3 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
            {title}
          </h3>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
