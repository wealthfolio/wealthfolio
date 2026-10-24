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
import { ActivityType, ActivityTypeNames, INSTRUMENT_TYPE_OPTIONS } from "@/lib/constants";
import type { ActivityStatusFilter } from "../hooks/use-activity-search";
import { DateRangeFilter } from "@/features/spending/components/date-range-filter";
import { Account, AccountScope, PortfolioWithAccounts } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@wealthfolio/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  statusFilter: ActivityStatusFilter;
  selectedInstrumentTypes: string[];
  /** An object rather than positional args — there are five filters now. */
  setFilters: (next: {
    activityTypes: ActivityType[];
    dateRange: DateRange | undefined;
    accountScope: AccountScope;
    statusFilter: ActivityStatusFilter;
    instrumentTypes: string[];
  }) => void;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
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

/**
 * One selectable filter row.
 *
 * A real `button` rather than a clickable `li`: the rows were only reachable by
 * pointer, so keyboard and switch users could not change any filter. `aria-pressed`
 * carries the selected state that the tick mark shows visually.
 */
function FilterOptionRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full cursor-pointer items-center justify-between rounded-md p-2 text-start text-sm",
          "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
          selected ? "bg-accent" : "hover:bg-accent/50",
        )}
      >
        {children}
        {selected && <Icons.Check className="h-4 w-4 shrink-0" />}
      </button>
    </li>
  );
}

export const ActivityMobileFilterSheet = ({
  open,
  onOpenChange,
  accountScope,
  accounts,
  portfolios,
  selectedActivityTypes,
  dateRange,
  statusFilter,
  selectedInstrumentTypes,
  setFilters,
  hasActiveFilters,
  onResetFilters,
}: ActivityMobileFilterSheetProps) => {
  const { t } = useTranslation();
  // Local state for temporary selections
  const [localAccountScope, setLocalAccountScope] = useState<AccountScope>(accountScope);
  const [localActivityTypes, setLocalActivityTypes] =
    useState<ActivityType[]>(selectedActivityTypes);
  const [localDateRange, setLocalDateRange] = useState<DateRange | undefined>(dateRange);
  const [localStatus, setLocalStatus] = useState<ActivityStatusFilter>(statusFilter);
  const [localInstrumentTypes, setLocalInstrumentTypes] =
    useState<string[]>(selectedInstrumentTypes);

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
      setLocalStatus(statusFilter);
      setLocalInstrumentTypes(selectedInstrumentTypes);
    }
  }, [open, accountScope, selectedActivityTypes, dateRange, statusFilter, selectedInstrumentTypes]);

  const handleApply = () => {
    setFilters({
      activityTypes: localActivityTypes,
      dateRange: localDateRange,
      accountScope: localAccountScope,
      statusFilter: localStatus,
      instrumentTypes: localInstrumentTypes,
    });
    onOpenChange(false);
  };

  /**
   * Clears every filter, including the status and instrument-type ones this
   * sheet has no control for — without this, a filter set elsewhere (the
   * needs-review banner, or the desktop toolbar) cannot be undone on a phone.
   */
  const handleReset = () => {
    onResetFilters();
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
        <SheetHeader className="text-start">
          <SheetTitle>{t("activity:filter_activities")}</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 py-4">
          <div className="space-y-6 pe-4">
            {/* Status Filter Section — the needs-review banner sets this, so it
                has to be visible and changeable here, not just resettable. */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:view_controls.status")}</h4>
              <ul className="space-y-1">
                {(
                  [
                    { value: "all", label: t("activity:view_controls.status_all") },
                    { value: "pending", label: t("activity:view_controls.status_pending") },
                    { value: "validated", label: t("activity:view_controls.status_validated") },
                  ] as { value: ActivityStatusFilter; label: string }[]
                ).map((option) => (
                  <FilterOptionRow
                    key={option.value}
                    selected={localStatus === option.value}
                    onSelect={() => setLocalStatus(option.value)}
                  >
                    <span>{option.label}</span>
                  </FilterOptionRow>
                ))}
              </ul>
            </div>

            {/* Date Filter Section */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:field_date")}</h4>
              <DateRangeFilter value={localDateRange} onChange={setLocalDateRange} />
            </div>

            {/* Account Filter Section */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:filter_account")}</h4>
              <ul className="space-y-1">
                <FilterOptionRow
                  selected={localAccountScope.type === "all"}
                  onSelect={() => setLocalAccountScope({ type: "all" })}
                >
                  <span>{t("activity:all_accounts")}</span>
                </FilterOptionRow>
                {portfolios.map((portfolio) => {
                  const isSelected =
                    localAccountScope.type === "portfolio" &&
                    localAccountScope.portfolioId === portfolio.id;
                  return (
                    <FilterOptionRow
                      key={portfolio.id}
                      selected={isSelected}
                      onSelect={() =>
                        setLocalAccountScope({ type: "portfolio", portfolioId: portfolio.id })
                      }
                    >
                      <span className="flex items-center gap-2">
                        <Icons.Folder className="h-4 w-4" />
                        {portfolio.name}
                      </span>
                    </FilterOptionRow>
                  );
                })}
                {accounts
                  .filter((account) => account.isActive)
                  .map((account) => (
                    <FilterOptionRow
                      key={account.id}
                      selected={localAccountIds.includes(account.id)}
                      onSelect={() => handleAccountToggle(account.id)}
                    >
                      <span>
                        {account.name} ({account.currency})
                      </span>
                    </FilterOptionRow>
                  ))}
              </ul>
            </div>

            {/* Instrument Type Filter Section */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:view_controls.instrument")}</h4>
              <ul className="space-y-1">
                <FilterOptionRow
                  selected={localInstrumentTypes.length === 0}
                  onSelect={() => setLocalInstrumentTypes([])}
                >
                  <span>{t("activity:view_controls.instrument_all")}</span>
                </FilterOptionRow>
                {INSTRUMENT_TYPE_OPTIONS.map((option) => (
                  <FilterOptionRow
                    key={option.value}
                    selected={localInstrumentTypes.includes(option.value)}
                    onSelect={() =>
                      setLocalInstrumentTypes(
                        localInstrumentTypes.includes(option.value)
                          ? localInstrumentTypes.filter((existing) => existing !== option.value)
                          : [...localInstrumentTypes, option.value],
                      )
                    }
                  >
                    <span>
                      {t(`asset:createSecurity.instrumentType.${option.value.toLowerCase()}`)}
                    </span>
                  </FilterOptionRow>
                ))}
              </ul>
            </div>

            {/* Activity Type Filter Section */}
            <div>
              <h4 className="mb-3 font-medium">{t("activity:activity_type")}</h4>
              <ul className="space-y-1">
                <FilterOptionRow
                  selected={localActivityTypes.length === 0}
                  onSelect={() => setLocalActivityTypes([])}
                >
                  <span>{t("activity:all_types")}</span>
                </FilterOptionRow>
                {activityTypeOptions.map((type) => (
                  <FilterOptionRow
                    key={type.value}
                    selected={localActivityTypes.includes(type.value)}
                    onSelect={() =>
                      setLocalActivityTypes(
                        localActivityTypes.includes(type.value)
                          ? localActivityTypes.filter((existing) => existing !== type.value)
                          : [...localActivityTypes, type.value],
                      )
                    }
                  >
                    <span>{type.label}</span>
                  </FilterOptionRow>
                ))}
              </ul>
            </div>
          </div>
        </ScrollArea>
        <SheetFooter className="mt-auto flex-row gap-2">
          {hasActiveFilters && (
            <Button variant="outline" className="flex-1" onClick={handleReset}>
              {t("activity:reset_filters")}
            </Button>
          )}
          <Button className="flex-1" onClick={handleApply}>
            {t("activity:done")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
