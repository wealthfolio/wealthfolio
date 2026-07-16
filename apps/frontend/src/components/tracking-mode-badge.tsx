import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export interface TrackingModeBadgeProps {
  account: Account;
  syncEnabled?: boolean; // For connected accounts
  className?: string;
}

/**
 * Displays a badge indicating the tracking mode for an account.
 * - "Transactions" (blue) - tracking via activity transactions
 * - "Holdings" (green) - tracking via manual holdings snapshots
 * - "Needs setup" (warning/yellow) - when trackingMode === 'NOT_SET'
 * - "Sync disabled" (muted/gray) - when account is connected but sync is disabled
 */
export function TrackingModeBadge({ account, syncEnabled, className }: TrackingModeBadgeProps) {
  const { t } = useTranslation();
  const isConnectedAccount = !!account.providerAccountId;

  // For connected accounts with sync disabled, show that status
  if (isConnectedAccount && syncEnabled === false) {
    return (
      <Badge
        variant="outline"
        className={cn("text-muted-foreground border-muted-foreground/30", className)}
      >
        {t("common:component.tracking_sync_disabled")}
      </Badge>
    );
  }

  switch (account.trackingMode) {
    case "TRANSACTIONS":
      return (
        <Badge
          variant="outline"
          className={cn(
            "rounded-sm border-blue-500/30 text-blue-600 dark:text-blue-400",
            className,
          )}
        >
          <Icons.Receipt className="mr-1 h-3 w-3" />
          {t("common:component.tracking_transactions")}
        </Badge>
      );
    case "HOLDINGS":
      return (
        <Badge
          variant="outline"
          className={cn("border-success/30 text-success rounded-sm", className)}
        >
          <Icons.Holdings className="mr-1 h-3 w-3" />
          {t("common:component.tracking_holdings")}
        </Badge>
      );
    case "NOT_SET":
    default:
      return (
        <Badge
          variant="outline"
          className={cn("border-warning/30 text-warning rounded-sm", className)}
        >
          <Icons.AlertTriangle className="mr-1 h-3 w-3" />
          {t("common:component.tracking_needs_setup")}
        </Badge>
      );
  }
}
