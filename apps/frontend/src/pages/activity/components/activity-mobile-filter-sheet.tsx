import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityType, ActivityTypeNames } from "@/lib/constants";
import { DateRangeFilter } from "@/features/spending/components/date-range-filter";
import { Account, AccountScope, PortfolioWithAccounts } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@wealthfolio/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DateRange } from "react-day-picker";

interface ActivityMobileFilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountScope: AccountScope;
  accounts: Account[];
  portfolios: PortfolioWithAccounts[];
  selectedActivityTypes: ActivityType[];
  dateRange: DateRange | undefined;
  setFilters: (types: ActivityType[], range: DateRange | undefined, scope: AccountScope) => void;
}

function accountIdsForScope(scope: AccountScope, portfolios: PortfolioWithAccounts[]) {
  if (scope.type === "account") return [scope.accountId];
  if (scope.type === "accounts") return scope.accountIds;
  if (scope.type === "portfolio") {
    return portfolios.find((portfolio) => portfolio.id === scope.portfolioId)?.accountIds ?? [];
  }
  return [];
}

function scopeFromAccountIds(accountIds: string[]): AccountScope {
  if (accountIds.length === 0) return { type: "all" };
  if (accountIds.length === 1) return { type: "account", accountId: accountIds[0] };
  return { type: "accounts", accountIds };
}

export const ActivityMobileFilterSheet = ({
  open,
  onOpenChange,
  accountScope,
  accounts,
  portfolios,
  selectedActivityTypes,
  dateRange,
  setFilters,
}: ActivityMobileFilterSheetProps) => {
  const { t } = useTranslation();
  // Local state for temporary selections
  const [localAccountScope, setLocalAccountScope] = useState<AccountScope>(accountScope);
  const [localActivityTypes, setLocalActivityTypes] =
    useState<ActivityType[]>(selectedActivityTypes);
  const [localDateRange, setLocalDateRange] = useState<DateRange | undefined>(dateRange);

  const localAccountIds = useMemo(
    () => accountIdsForScope(localAccountScope, portfolios),
    [localAccountScope, portfolios],
  );

  // Sync local state when sheet opens
  useEffect(() => {
    if (open) {
      setLocalAccountScope(accountScope);
      setLocalActivityTypes(selectedActivityTypes);
      setLocalDateRange(dateRange);
    }
  }, [open, accountScope, selectedActivityTypes, dateRange]);

  const handleApply = () => {
    setFilters(localActivityTypes, localDateRange, localAccountScope);
    onOpenChange(false);
  };

  const handleAccountToggle = (accountId: string) => {
    const next = localAccountIds.includes(accountId)
      ? localAccountIds.filter((id) => id !== accountId)
      : [...localAccountIds, accountId];
    setLocalAccountScope(scopeFromAccountIds(next));
  };

  const activityTypeOptions = Object.keys(ActivityTypeNames).map((value) => ({
    label: localizeActivityTypeName(t, value),
    value: value as ActivityType,
  }));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-4xl mx-1 flex h-[80vh] flex-col">
        <SheetHeader className="text-left">
          <SheetTitle>{t("activity:filter_activities")}</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 py-4">
          <div className="space-y-6 pr-4">
            {/* Date Filter Section */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:field_date")}</h4>
              <DateRangeFilter value={localDateRange} onChange={setLocalDateRange} />
            </div>

            {/* Account Filter Section */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:filter_account")}</h4>
              <ul className="space-y-1">
                <li
                  className={cn(
                    "flex cursor-pointer items-center justify-between rounded-md p-2 text-sm",
                    localAccountScope.type === "all" ? "bg-accent" : "hover:bg-accent/50",
                  )}
                  onClick={() => {
                    setLocalAccountScope({ type: "all" });
                  }}
                >
                  <span>{t("activity:all_accounts")}</span>
                  {localAccountScope.type === "all" && <Icons.Check className="h-4 w-4" />}
                </li>
                {portfolios.map((portfolio) => {
                  const isSelected =
                    localAccountScope.type === "portfolio" &&
                    localAccountScope.portfolioId === portfolio.id;
                  return (
                    <li
                      key={portfolio.id}
                      className={cn(
                        "flex cursor-pointer items-center justify-between rounded-md p-2 text-sm",
                        isSelected ? "bg-accent" : "hover:bg-accent/50",
                      )}
                      onClick={() => {
                        setLocalAccountScope({ type: "portfolio", portfolioId: portfolio.id });
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <Icons.Folder className="h-4 w-4" />
                        {portfolio.name}
                      </span>
                      {isSelected && <Icons.Check className="h-4 w-4" />}
                    </li>
                  );
                })}
                {accounts
                  .filter((account) => account.isActive)
                  .map((account) => (
                    <li
                      key={account.id}
                      className={cn(
                        "flex cursor-pointer items-center justify-between rounded-md p-2 text-sm",
                        localAccountIds.includes(account.id) ? "bg-accent" : "hover:bg-accent/50",
                      )}
                      onClick={() => handleAccountToggle(account.id)}
                    >
                      <span>
                        {account.name} ({account.currency})
                      </span>
                      {localAccountIds.includes(account.id) && <Icons.Check className="h-4 w-4" />}
                    </li>
                  ))}
              </ul>
            </div>

            {/* Activity Type Filter Section */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:activity_type")}</h4>
              <ul className="space-y-1">
                <li
                  className={cn(
                    "flex cursor-pointer items-center justify-between rounded-md p-2 text-sm",
                    localActivityTypes.length === 0 ? "bg-accent" : "hover:bg-accent/50",
                  )}
                  onClick={() => {
                    setLocalActivityTypes([]);
                  }}
                >
                  <span>{t("activity:all_types")}</span>
                  {localActivityTypes.length === 0 && <Icons.Check className="h-4 w-4" />}
                </li>
                {activityTypeOptions.map((type) => (
                  <li
                    key={type.value}
                    className={cn(
                      "flex cursor-pointer items-center justify-between rounded-md p-2 text-sm",
                      localActivityTypes.includes(type.value) ? "bg-accent" : "hover:bg-accent/50",
                    )}
                    onClick={() => {
                      const newTypes = localActivityTypes.includes(type.value)
                        ? localActivityTypes.filter((existing) => existing !== type.value)
                        : [...localActivityTypes, type.value];
                      setLocalActivityTypes(newTypes);
                    }}
                  >
                    <span>{type.label}</span>
                    {localActivityTypes.includes(type.value) && <Icons.Check className="h-4 w-4" />}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </ScrollArea>
        <SheetFooter className="mt-auto">
          <Button className="w-full" onClick={handleApply}>
            {t("activity:done")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
