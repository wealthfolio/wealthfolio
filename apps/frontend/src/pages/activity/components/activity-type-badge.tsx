import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { useTranslation } from "react-i18next";
import { localizeActivitySubtypeName, localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityType } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface ActivityTypeBadgeProps {
  type: ActivityType;
  subtype?: string | null;
  /** Replaces the type's own name, e.g. a credit card's wording for it. */
  label?: string;
  className?: string;
}

// Pale pills: the type labels a row, so it should not outweigh the numbers beside it.
function getActivityBadgeVariant(type: ActivityType) {
  switch (type) {
    case ActivityType.DIVIDEND:
    case ActivityType.INTEREST:
      return "info-subtle";
    case ActivityType.BUY:
    case ActivityType.DEPOSIT:
    case ActivityType.TRANSFER_IN:
      return "success-subtle";
    case ActivityType.SELL:
    case ActivityType.WITHDRAWAL:
    case ActivityType.TRANSFER_OUT:
    case ActivityType.FEE:
    case ActivityType.TAX:
      return "destructive-subtle";
    case ActivityType.SPLIT:
      return "warning-subtle";
    default:
      return "secondary";
  }
}

export function ActivityTypeBadge({ type, subtype, label, className }: ActivityTypeBadgeProps) {
  const { t } = useTranslation();
  const variant = getActivityBadgeVariant(type);
  const subtypeLabel = subtype?.trim() ? localizeActivitySubtypeName(t, subtype) : undefined;

  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden">
      <Badge variant={variant} className={cn("rounded-sm", className)}>
        {label ?? localizeActivityTypeName(t, type)}
      </Badge>
      {subtypeLabel && (
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-normal">
          {subtypeLabel}
        </span>
      )}
    </span>
  );
}
