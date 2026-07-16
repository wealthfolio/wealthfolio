import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { useTranslation } from "react-i18next";
import { localizeActivitySubtypeName, localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityType } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface ActivityTypeBadgeProps {
  type: ActivityType;
  subtype?: string | null;
  className?: string;
}

function getActivityBadgeVariant(type: ActivityType) {
  switch (type) {
    case ActivityType.DIVIDEND:
    case ActivityType.INTEREST:
    case ActivityType.BUY:
    case ActivityType.DEPOSIT:
    case ActivityType.TRANSFER_IN:
      return "success";
    case ActivityType.SELL:
    case ActivityType.WITHDRAWAL:
    case ActivityType.TRANSFER_OUT:
    case ActivityType.FEE:
    case ActivityType.TAX:
      return "destructive";
    case ActivityType.SPLIT:
      return "warning";
    case ActivityType.ADJUSTMENT:
      return "secondary";
    default:
      return "default";
  }
}

export function ActivityTypeBadge({ type, subtype, className }: ActivityTypeBadgeProps) {
  const { t } = useTranslation();
  const variant = getActivityBadgeVariant(type);
  const subtypeLabel = subtype?.trim() ? localizeActivitySubtypeName(t, subtype) : undefined;

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
      <Badge variant={variant} className={cn("rounded-sm", className)}>
        {localizeActivityTypeName(t, type)}
      </Badge>
      {subtypeLabel && (
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs font-normal">
          {subtypeLabel}
        </span>
      )}
    </span>
  );
}
