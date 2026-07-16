import { Button, Icons, Input } from "@wealthfolio/ui";
import { ActivityType } from "@/lib/constants";
import { Account, AccountScope, PortfolioWithAccounts } from "@/lib/types";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DateRange } from "react-day-picker";
import { ActivityMobileFilterSheet } from "./activity-mobile-filter-sheet";

interface ActivityMobileControlsProps {
  accounts: Account[];
  portfolios: PortfolioWithAccounts[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  accountScope: AccountScope;
  selectedActivityTypes: ActivityType[];
  dateRange: DateRange | undefined;
  isCompactView: boolean;
  onCompactViewChange: (isCompact: boolean) => void;
  onFilterChange: (
    types: ActivityType[],
    range: DateRange | undefined,
    scope: AccountScope,
  ) => void;
}

export function ActivityMobileControls({
  accounts,
  portfolios,
  searchQuery,
  onSearchQueryChange,
  accountScope,
  selectedActivityTypes,
  dateRange,
  isCompactView,
  onCompactViewChange,
  onFilterChange,
}: ActivityMobileControlsProps) {
  const { t } = useTranslation();
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    accountScope.type !== "all" ||
    selectedActivityTypes.length > 0 ||
    !!dateRange?.from ||
    !!dateRange?.to;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 pt-2">
        <Input
          placeholder={t("activity:search_placeholder")}
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          className="bg-secondary/30 h-10 flex-1 rounded-full border-none md:h-12"
        />
        <Button
          variant="outline"
          size="icon"
          className="size-9 flex-shrink-0"
          onClick={() => onCompactViewChange(!isCompactView)}
          title={isCompactView ? t("activity:detailed_view") : t("activity:compact_view")}
        >
          {isCompactView ? (
            <Icons.Rows3 className="h-4 w-4" />
          ) : (
            <Icons.ListCollapse className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-9 flex-shrink-0"
          onClick={() => setIsFilterSheetOpen(true)}
        >
          <div className="relative">
            <Icons.ListFilter className="h-4 w-4" />
            {hasActiveFilters && (
              <span className="bg-primary absolute -left-[1.5px] -top-1 h-2 w-2 rounded-full" />
            )}
          </div>
        </Button>
      </div>

      <ActivityMobileFilterSheet
        open={isFilterSheetOpen}
        onOpenChange={setIsFilterSheetOpen}
        accountScope={accountScope}
        accounts={accounts}
        portfolios={portfolios}
        selectedActivityTypes={selectedActivityTypes}
        dateRange={dateRange}
        setFilters={onFilterChange}
      />
    </>
  );
}
