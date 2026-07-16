import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { formatDate } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { BrokerAccount } from "../types";

interface BrokerAccountCardProps {
  account: BrokerAccount;
}

/**
 * Mask account number to show only last 4 characters
 */
function maskAccountNumber(number?: string): string {
  if (!number) return "";
  const last4 = number.slice(-4);
  return `\u2022\u2022${last4}`;
}

/**
 * Get the latest sync date from transactions or holdings
 */
function getLastSyncDate(account: BrokerAccount): string | null {
  const txDate = account.sync_status?.transactions?.last_successful_sync;
  const holdingsDate = account.sync_status?.holdings?.last_successful_sync;

  // Get the most recent date
  if (txDate && holdingsDate) {
    return new Date(txDate) > new Date(holdingsDate) ? txDate : holdingsDate;
  }
  return txDate || holdingsDate || null;
}

/**
 * Format the last sync date for display
 */
function formatLastSyncDate(dateStr: string | null, t: TFunction): string {
  if (!dateStr) return t("connect:accounts.noDataYet");
  return t("connect:accounts.dataAsOf", { date: formatDate(dateStr) });
}

export function BrokerAccountCard({ account }: BrokerAccountCardProps) {
  const { t } = useTranslation();
  const lastSyncDate = getLastSyncDate(account);
  const isShared = account.owner && !account.owner.is_own_account;
  const ownerName = account.owner?.full_name;

  return (
    <Card>
      <CardContent className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          {/* Platform logo or fallback */}
          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
            {account.institution_name ? (
              <img
                src={`https://logo.clearbit.com/${account.institution_name.toLowerCase().replace(/\s+/g, "")}.com`}
                alt={account.institution_name}
                className="h-6 w-6"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                  e.currentTarget.parentElement?.classList.add("show-fallback");
                }}
              />
            ) : null}
            <Icons.Wallet className="text-muted-foreground h-5 w-5" />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">{account.name || t("connect:accounts.accountFallback")}</p>
              {account.is_paper && (
                <Badge variant="outline" className="text-xs">
                  {t("connect:accounts.paper")}
                </Badge>
              )}
              {isShared && ownerName && (
                <span className="text-muted-foreground flex items-center gap-1 text-sm">
                  <Icons.Users className="h-3.5 w-3.5" />
                  {t("connect:accounts.sharedBy", { name: ownerName })}
                </span>
              )}
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <span>{account.institution_name}</span>
              {account.number && (
                <>
                  <span className="text-muted-foreground/50">
                    {maskAccountNumber(account.number)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">
            {formatLastSyncDate(lastSyncDate, t)}
          </span>

          {/* Sync enabled indicator */}
          {account.sync_enabled ? (
            <Icons.Eye className="h-4 w-4 text-blue-500" />
          ) : (
            <Icons.EyeOff className="text-muted-foreground h-4 w-4" />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
