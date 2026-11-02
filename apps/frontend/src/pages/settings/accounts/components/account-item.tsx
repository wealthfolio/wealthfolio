import { Avatar, AvatarFallback, AvatarImage } from "@wealthfolio/ui/components/ui/avatar";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons, type Icon } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@wealthfolio/ui";
import { maskAccountNumber } from "@/lib/account-number";
import type { Account, AccountType, Platform } from "@/lib/types";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SettingsListMedia, SettingsListRow } from "@/components/settings-list";
import { AccountOperations } from "./account-operations";

// Each account type's icon, shown when the account has no platform logo.
const accountTypeIcon: Record<AccountType, Icon> = {
  SECURITIES: Icons.Briefcase,
  CASH: Icons.DollarSign,
  CREDIT_CARD: Icons.CreditCard,
  CRYPTOCURRENCY: Icons.Bitcoin,
};

export interface AccountItemProps {
  account: Account;
  platform?: Platform | null;
  onEdit: (account: Account) => void;
  onDelete: (account: Account) => void;
  onArchive: (account: Account, archive: boolean) => void;
  onHide: (account: Account, hide: boolean) => void;
}

export function AccountItem({
  account,
  platform,
  onEdit,
  onDelete,
  onArchive,
  onHide,
}: AccountItemProps) {
  const { t } = useTranslation();
  // Check if account is synced from broker (has provider_account_id set)
  const isSynced = !!account.providerAccountId;
  const IconComponent = accountTypeIcon[account.accountType] ?? Icons.Wallet;
  const maskedNumber = maskAccountNumber(account.accountNumber);

  return (
    <SettingsListRow
      inactive={!account.isActive}
      media={
        isSynced && platform?.logoUrl ? (
          // The avatar falls back to the type icon when the logo fails to load.
          <Avatar className="size-9 shrink-0 rounded-lg">
            <AvatarImage
              src={platform.logoUrl}
              alt={platform.name || t("settings:accounts.platform_alt")}
              className="bg-white object-contain p-1"
            />
            <AvatarFallback className="bg-muted text-muted-foreground rounded-lg">
              <IconComponent className="size-5" />
            </AvatarFallback>
          </Avatar>
        ) : (
          <SettingsListMedia>
            <IconComponent />
          </SettingsListMedia>
        )
      }
      title={
        <span className="inline-flex items-center gap-1.5">
          <Link to={`/accounts/${account.id}`} className="hover:underline">
            {account.name}
          </Link>
          {isSynced && <Icons.CloudSync2 className="text-muted-foreground h-3.5 w-3.5" />}
        </span>
      }
      badges={
        <>
          {account.isArchived && (
            <Badge variant="destructive-subtle">
              <Icons.FileArchive className="me-1 h-3 w-3" />
              {t("settings:accounts.badge_archived")}
            </Badge>
          )}
          {!account.isActive && !account.isArchived && (
            <Badge variant="warning-subtle">
              <Icons.EyeOff className="me-1 h-3 w-3" />
              {t("settings:accounts.badge_hidden")}
            </Badge>
          )}
        </>
      }
      meta={
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span>{account.currency}</span>
          {account.group && (
            <>
              <span>·</span>
              <span>{account.group}</span>
            </>
          )}
          {maskedNumber && (
            <>
              <span>·</span>
              <span dir="ltr" data-testid="account-item-number">
                {maskedNumber}
              </span>
            </>
          )}
          <span>·</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                delay={300}
                render={
                  account.trackingMode === "HOLDINGS" ? (
                    <span className="text-success flex cursor-help items-center gap-1">
                      <Icons.Holdings className="h-3 w-3" />
                      {t("settings:accounts.tracking_holdings")}
                    </span>
                  ) : account.trackingMode === "NOT_SET" ? (
                    <span className="text-warning flex cursor-help items-center gap-1">
                      <Icons.AlertTriangle className="h-3 w-3" />
                      {t("settings:accounts.tracking_needs_setup")}
                    </span>
                  ) : (
                    <span className="flex cursor-help items-center gap-1">
                      <Icons.Receipt className="h-3 w-3" />
                      {t("settings:accounts.tracking_transactions")}
                    </span>
                  )
                }
              />
              <TooltipContent side="bottom">
                <p className="text-xs">
                  {account.trackingMode === "HOLDINGS"
                    ? t("settings:accounts.tracking_tooltip_holdings")
                    : account.trackingMode === "NOT_SET"
                      ? t("settings:accounts.tracking_tooltip_needs_setup")
                      : t("settings:accounts.tracking_tooltip_transactions")}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </span>
      }
      actions={
        <AccountOperations
          account={account}
          onEdit={onEdit}
          onDelete={onDelete}
          onArchive={onArchive}
          onHide={onHide}
        />
      }
    />
  );
}

AccountItem.Skeleton = function AccountItemSkeleton() {
  return (
    <div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  );
};
