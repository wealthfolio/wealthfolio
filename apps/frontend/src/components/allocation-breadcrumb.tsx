import type { DrillDownPath } from "@/hooks/use-drill-down-state";
import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type React from "react";

interface AllocationBreadcrumbProps {
  path: DrillDownPath[];
  rootLabel: string;
  onNavigate: (index: number) => void;
  className?: string;
}

/**
 * Breadcrumb navigation for drill-down allocation charts.
 * Shows the current path and allows navigating back to any level.
 */
export const AllocationBreadcrumb: React.FC<AllocationBreadcrumbProps> = ({
  path,
  rootLabel,
  onNavigate,
  className,
}) => {
  if (path.length === 0) {
    return null;
  }

  return (
    <nav className={cn("flex items-center gap-1.5 text-xs leading-none", className)}>
      <button
        onClick={() => onNavigate(0)}
        className="text-muted-foreground hover:text-foreground font-semibold uppercase tracking-[0.18em] transition-colors"
      >
        {rootLabel}
      </button>
      {path.map((item, index) => (
        <span key={item.id} className="flex items-center gap-1.5">
          <Icons.ChevronRight className="text-muted-foreground h-3.5 w-3.5" />
          {index === path.length - 1 ? (
            <span className="text-foreground font-semibold">{item.name}</span>
          ) : (
            <button
              onClick={() => onNavigate(index + 1)}
              className="text-muted-foreground hover:text-foreground font-semibold transition-colors"
            >
              {item.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
};
