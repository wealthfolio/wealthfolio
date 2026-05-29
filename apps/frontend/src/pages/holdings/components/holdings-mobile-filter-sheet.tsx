import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { HOLDING_CATEGORY_FILTERS } from "@/lib/constants";
import { Account, AccountScope, HoldingCategoryFilterId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AnimatedToggleGroup, ScrollArea, Separator } from "@wealthfolio/ui";

interface HoldingsMobileFilterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountFilter: AccountScope;
  onAccountScopeChange: (filter: AccountScope) => void;
  accounts: Account[];
  portfolios: { id: string; name: string }[];
  selectedTypes: string[];
  setSelectedTypes: (types: string[]) => void;
  showAccountScope?: boolean;
  sortBy: "symbol" | "marketValue";
  setSortBy: (value: "symbol" | "marketValue") => void;
  showTotalReturn: boolean;
  setShowTotalReturn: (value: boolean) => void;
  categoryFilter?: HoldingCategoryFilterId;
  setCategoryFilter?: (value: HoldingCategoryFilterId) => void;
  typeOptions?: { value: string; label: string }[];
}

export const HoldingsMobileFilterSheet = ({
  open,
  onOpenChange,
  accountFilter,
  onAccountScopeChange,
  accounts,
  portfolios,
  selectedTypes,
  setSelectedTypes,
  showAccountScope = true,
  sortBy,
  setSortBy,
  showTotalReturn,
  setShowTotalReturn,
  categoryFilter = "investments",
  setCategoryFilter,
  typeOptions,
}: HoldingsMobileFilterSheetProps) => {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[85vh] flex-col rounded-t-xl pb-[max(env(safe-area-inset-bottom),0.75rem)]"
      >
        <SheetHeader className="text-left">
          <SheetTitle>Display Options</SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1 py-4">
          <div className="space-y-6">
            {/* View Settings */}
            <div className="grid grid-cols-1 gap-6">
              <div className="space-y-3">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                  Sort By
                </h4>
                <AnimatedToggleGroup<"symbol" | "marketValue">
                  value={sortBy}
                  onValueChange={setSortBy}
                  items={[
                    { value: "marketValue", label: "Market Value" },
                    { value: "symbol", label: "Symbol" },
                  ]}
                  size="sm"
                  className="inline-flex w-auto"
                />
              </div>

              <div className="space-y-3">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                  Return View
                </h4>
                <AnimatedToggleGroup
                  value={showTotalReturn ? "total" : "daily"}
                  onValueChange={(value) => setShowTotalReturn(value === "total")}
                  items={[
                    { value: "total", label: "Total Return" },
                    { value: "daily", label: "Daily Return" },
                  ]}
                  size="sm"
                  className="inline-flex w-auto"
                />
              </div>
            </div>

            <Separator />

            {/* Category Filter Section */}
            {setCategoryFilter && (
              <div className="space-y-3">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                  Category
                </h4>
                <div className="overflow-hidden rounded-lg border">
                  {HOLDING_CATEGORY_FILTERS.map((filter, index) => (
                    <div
                      key={filter.id}
                      className={cn(
                        "flex cursor-pointer items-center justify-between p-3 text-sm transition-colors",
                        index > 0 && "border-t",
                        categoryFilter === filter.id
                          ? "bg-accent/50 font-medium"
                          : "hover:bg-muted/50",
                      )}
                      onClick={() => {
                        setCategoryFilter(filter.id);
                      }}
                    >
                      <span>{filter.label}</span>
                      {categoryFilter === filter.id && (
                        <Icons.Check className="text-primary h-4 w-4" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {setCategoryFilter && <Separator />}

            {/* Account Filter Section */}
            {showAccountScope && (
              <div className="space-y-3">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                  Account
                </h4>
                <div className="overflow-hidden rounded-lg border">
                  <div
                    className={cn(
                      "flex cursor-pointer items-center justify-between p-3 text-sm transition-colors",
                      accountFilter.type === "all"
                        ? "bg-accent/50 font-medium"
                        : "hover:bg-muted/50",
                    )}
                    onClick={() => {
                      onAccountScopeChange({ type: "all" });
                      onOpenChange(false);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Icons.Wallet className="text-muted-foreground h-4 w-4" />
                      All Accounts
                    </span>
                    {accountFilter.type === "all" && (
                      <Icons.Check className="text-primary h-4 w-4" />
                    )}
                  </div>
                  {portfolios.map((portfolio) => (
                    <div
                      key={portfolio.id}
                      className={cn(
                        "flex cursor-pointer items-center justify-between border-t p-3 text-sm transition-colors",
                        accountFilter.type === "portfolio" &&
                          accountFilter.portfolioId === portfolio.id
                          ? "bg-accent/50 font-medium"
                          : "hover:bg-muted/50",
                      )}
                      onClick={() => {
                        onAccountScopeChange({ type: "portfolio", portfolioId: portfolio.id });
                        onOpenChange(false);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <Icons.Folder className="text-muted-foreground h-4 w-4" />
                        {portfolio.name}
                      </span>
                      {accountFilter.type === "portfolio" &&
                        accountFilter.portfolioId === portfolio.id && (
                          <Icons.Check className="text-primary h-4 w-4" />
                        )}
                    </div>
                  ))}
                  {accounts.map((account) => (
                    <div
                      key={account.id}
                      className={cn(
                        "flex cursor-pointer items-center justify-between border-t p-3 text-sm transition-colors",
                        accountFilter.type === "account" && accountFilter.accountId === account.id
                          ? "bg-accent/50 font-medium"
                          : "hover:bg-muted/50",
                      )}
                      onClick={() => {
                        onAccountScopeChange({ type: "account", accountId: account.id });
                        onOpenChange(false);
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <Icons.CreditCard className="text-muted-foreground h-4 w-4" />
                        {account.name}
                      </span>
                      {accountFilter.type === "account" &&
                        accountFilter.accountId === account.id && (
                          <Icons.Check className="text-primary h-4 w-4" />
                        )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Asset Type Filter Section */}
            {typeOptions && typeOptions.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                  Asset Type
                </h4>
                <div className="overflow-hidden rounded-lg border">
                  <div
                    className={cn(
                      "flex cursor-pointer items-center justify-between p-3 text-sm transition-colors",
                      selectedTypes.length === 0 ? "bg-accent/50 font-medium" : "hover:bg-muted/50",
                    )}
                    onClick={() => {
                      setSelectedTypes([]);
                      onOpenChange(false);
                    }}
                  >
                    <span>All Types</span>
                    {selectedTypes.length === 0 && <Icons.Check className="text-primary h-4 w-4" />}
                  </div>
                  {typeOptions.map((type) => (
                    <div
                      key={type.value}
                      className={cn(
                        "flex cursor-pointer items-center justify-between border-t p-3 text-sm transition-colors",
                        selectedTypes.includes(type.value)
                          ? "bg-accent/50 font-medium"
                          : "hover:bg-muted/50",
                      )}
                      onClick={() => {
                        const newTypes = selectedTypes.includes(type.value)
                          ? selectedTypes.filter((t) => t !== type.value)
                          : [...selectedTypes, type.value];
                        setSelectedTypes(newTypes);
                      }}
                    >
                      <span>{type.label}</span>
                      {selectedTypes.includes(type.value) && (
                        <Icons.Check className="text-primary h-4 w-4" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
        <SheetFooter className="mt-auto">
          <SheetClose asChild>
            <Button className="w-full">Done</Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
