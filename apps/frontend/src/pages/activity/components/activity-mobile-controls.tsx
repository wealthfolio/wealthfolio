import { Button, Icons, Input } from "@wealthfolio/ui";
import { ActivityType } from "@/lib/constants";
import { Account, AccountScope, PortfolioWithAccounts } from "@/lib/types";
import { useState } from "react";
import { ActivityMobileFilterSheet } from "./activity-mobile-filter-sheet";

interface ActivityMobileControlsProps {
  accounts: Account[];
  portfolios: PortfolioWithAccounts[];
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  accountScope: AccountScope;
  onAccountScopeChange: (accountScope: AccountScope) => void;
  selectedActivityTypes: ActivityType[];
  onActivityTypesChange: (types: ActivityType[]) => void;
  isCompactView: boolean;
  onCompactViewChange: (isCompact: boolean) => void;
}

export function ActivityMobileControls({
  accounts,
  portfolios,
  searchQuery,
  onSearchQueryChange,
  accountScope,
  onAccountScopeChange,
  selectedActivityTypes,
  onActivityTypesChange,
  isCompactView,
  onCompactViewChange,
}: ActivityMobileControlsProps) {
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  const hasActiveFilters = accountScope.type !== "all" || selectedActivityTypes.length > 0;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 pt-2">
        <Input
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          className="bg-secondary/30 h-10 flex-1 rounded-full border-none md:h-12"
        />
        <Button
          variant="outline"
          size="icon"
          className="size-9 flex-shrink-0"
          onClick={() => onCompactViewChange(!isCompactView)}
          title={isCompactView ? "Detailed view" : "Compact view"}
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
        setAccountScope={onAccountScopeChange}
        selectedActivityTypes={selectedActivityTypes}
        setSelectedActivityTypes={onActivityTypesChange}
      />
    </>
  );
}
