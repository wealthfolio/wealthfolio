import { Card } from "@wealthfolio/ui/components/ui/card";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DashboardCardProps {
  title: string;
  /** Inline subtitle next to the title (e.g. "MAY 2026"). */
  subtitle?: ReactNode;
  /** Right-aligned slot — a toggle, link, etc. Takes precedence over `meta`. */
  action?: ReactNode;
  /** Convenience: right-aligned uppercase meta text (e.g. "vs prior 6M"). */
  meta?: string;
  /** Whether the body has padding. Set false for full-bleed content (e.g. lists). */
  padded?: boolean;
  /** Extra classes for the card body. */
  className?: string;
  children: ReactNode;
}

/**
 * Shared card for the main dashboard tabs: a section header (title + optional
 * inline subtitle + optional right-side action/meta) above the app's Card, so
 * the dashboards take each theme's card surface.
 */
export function DashboardCard({
  title,
  subtitle,
  action,
  meta,
  padded = true,
  className,
  children,
}: DashboardCardProps) {
  return (
    <div className="w-full">
      {/* When the title and action don't fit on one row (a phone, a larger text size),
          the action wraps under the title, at the end, instead of running off the card. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {subtitle != null && subtitle !== "" && (
            <span className="text-muted-foreground/60 text-xs">{subtitle}</span>
          )}
        </div>
        {(action != null || meta) && (
          <div className="ms-auto">
            {action ?? (
              <span className="text-muted-foreground/70 text-xs font-medium tracking-wide uppercase">
                {meta}
              </span>
            )}
          </div>
        )}
      </div>
      <Card className={cn(padded && "p-3 md:p-4", className)}>{children}</Card>
    </div>
  );
}
