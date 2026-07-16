import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import { AmountDisplay, Skeleton } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useState, useCallback, useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { getHoldingsByAllocation } from "@/adapters";
import { TickerAvatar } from "@/components/ticker-avatar";
import { HoldingType } from "@/lib/constants";
import type {
  AccountScope,
  TaxonomyAllocation,
  CategoryAllocation,
  HoldingSummary,
} from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { CompactAllocationStrip } from "./compact-allocation-strip";

interface AllocationDetailSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  allocation?: TaxonomyAllocation;
  accountFilter: AccountScope;
  baseCurrency: string;
  initialCategoryId?: string | null;
}

type HoldingsByAllocationQueryKey = readonly [string, AccountScope, string, string];

export function AllocationDetailSheet({
  isOpen,
  onOpenChange,
  allocation,
  accountFilter,
  baseCurrency,
  initialCategoryId,
}: AllocationDetailSheetProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [selectedCategoryName, setSelectedCategoryName] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

  // Set initial category when sheet opens
  useEffect(() => {
    if (isOpen && allocation?.categories?.length) {
      const categoryId = initialCategoryId ?? allocation.categories[0]?.categoryId ?? null;
      // Try direct match on top-level
      let category = allocation.categories.find((c) => c.categoryId === categoryId);
      let childMatch: CategoryAllocation | undefined;

      // If not a top-level, search children to find the parent
      if (!category && categoryId) {
        for (const parent of allocation.categories) {
          childMatch = parent.children?.find((child) => child.categoryId === categoryId);
          if (childMatch) {
            category = parent;
            break;
          }
        }
      }

      if (category) {
        // If we matched a child, select the child and expand the parent
        if (childMatch) {
          setExpandedParents(new Set([category.categoryId]));
          setSelectedCategoryId(childMatch.categoryId);
          setSelectedCategoryName(childMatch.categoryName);
          setSelectedColor(childMatch.color);
        } else {
          setSelectedCategoryId(category.categoryId);
          setSelectedCategoryName(category.categoryName);
          setSelectedColor(category.color);
          // Auto-expand if it has children
          if (category.children?.length) {
            setExpandedParents(new Set([category.categoryId]));
          }
        }
      }
    }
  }, [isOpen, initialCategoryId, allocation?.categories]);

  const taxonomyId = allocation?.taxonomyId ?? "";
  const categoryId = selectedCategoryId ?? "";
  const holdingsQueryKey: HoldingsByAllocationQueryKey = [
    QueryKeys.HOLDINGS_BY_ALLOCATION,
    accountFilter,
    taxonomyId,
    categoryId,
  ];

  // Fetch holdings for the selected category
  const {
    data: allocationHoldings,
    isLoading: holdingsLoading,
    isError: holdingsError,
    error: holdingsQueryError,
    refetch: refetchAllocationHoldings,
  } = useQuery({
    queryKey: holdingsQueryKey,
    queryFn: ({ queryKey }) => {
      const [, filter, selectedTaxonomyId, selectedCategoryId] = queryKey;
      return getHoldingsByAllocation(filter, selectedTaxonomyId, selectedCategoryId);
    },
    enabled: !!categoryId && !!taxonomyId,
    staleTime: 30000,
  });

  const hasRequestedCategory = !!categoryId && !!taxonomyId;
  const holdingsMatchSelection =
    allocationHoldings?.taxonomyId === taxonomyId && allocationHoldings?.categoryId === categoryId;
  const holdings = holdingsMatchSelection ? allocationHoldings?.holdings : undefined;
  const holdingsLoadingForSelection =
    holdingsLoading ||
    (hasRequestedCategory && !holdingsError && !!allocationHoldings && !holdingsMatchSelection);

  const handleSegmentClick = useCallback(
    (categoryId: string, categoryName: string) => {
      const category = allocation?.categories?.find((c) => c.categoryId === categoryId);
      setSelectedCategoryId(categoryId);
      setSelectedCategoryName(categoryName);
      setSelectedColor(category?.color ?? null);
    },
    [allocation?.categories],
  );

  const handleParentClick = useCallback((category: CategoryAllocation) => {
    const hasChildren = category.children && category.children.length > 0;

    if (hasChildren) {
      // Toggle expand/collapse
      setExpandedParents((prev) => {
        const next = new Set(prev);
        if (next.has(category.categoryId)) {
          next.delete(category.categoryId);
        } else {
          next.add(category.categoryId);
        }
        return next;
      });
    }

    // Always select the parent
    setSelectedCategoryId(category.categoryId);
    setSelectedCategoryName(category.categoryName);
    setSelectedColor(category.color);
  }, []);

  const handleChildClick = useCallback((child: CategoryAllocation) => {
    setSelectedCategoryId(child.categoryId);
    setSelectedCategoryName(child.categoryName);
    setSelectedColor(child.color);
  }, []);

  const handleHoldingClick = useCallback(
    (holding: HoldingSummary) => {
      if (holding.holdingType === HoldingType.CASH) return;
      onOpenChange(false);
      navigate(`/holdings/${encodeURIComponent(holding.id)}`);
    },
    [navigate, onOpenChange],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedCategoryId(null);
    setSelectedCategoryName(null);
    setSelectedColor(null);
  }, []);

  // Reset state when sheet closes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setSelectedCategoryId(null);
        setSelectedCategoryName(null);
        setSelectedColor(null);
        setExpandedParents(new Set());
      }
      onOpenChange(open);
    },
    [onOpenChange],
  );

  const categories = allocation?.categories ?? [];
  const hasData = categories.length > 0;

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetContent
        className="flex w-full flex-col overflow-hidden sm:max-w-xl"
        style={{
          paddingTop: "max(env(safe-area-inset-top, 0px), 1.5rem)",
        }}
      >
        <SheetHeader className="mt-4">
          <SheetTitle>{allocation?.taxonomyName ?? t("holdings:allocation")}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto py-4">
          {/* Allocation Bar */}
          {hasData && (
            <CompactAllocationStrip
              title=""
              allocation={allocation}
              baseCurrency={baseCurrency}
              isLoading={false}
              onSegmentClick={handleSegmentClick}
            />
          )}

          {/* Category List */}
          {hasData && (
            <div className="overflow-hidden rounded-lg border">
              {categories.map((category, idx) => {
                const hasChildren = category.children && category.children.length > 0;
                const isExpanded = expandedParents.has(category.categoryId);
                const isSelected = selectedCategoryId === category.categoryId;
                const isLast = idx === categories.length - 1;

                return (
                  <div key={category.categoryId}>
                    {/* Parent row */}
                    <div
                      className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${
                        isSelected ? "bg-muted" : "hover:bg-muted/50"
                      } ${idx > 0 ? "border-t" : ""}`}
                      onClick={() => handleParentClick(category)}
                    >
                      {/* Expand indicator or spacer */}
                      <div className="flex w-4 shrink-0 items-center justify-center">
                        {hasChildren ? (
                          <Icons.ChevronRight
                            className={`text-muted-foreground h-3.5 w-3.5 transition-transform duration-200 ${
                              isExpanded ? "rotate-90" : ""
                            }`}
                          />
                        ) : (
                          <div className="w-3.5" />
                        )}
                      </div>

                      {/* Color dot + name */}
                      <div
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {category.categoryName}
                      </span>

                      {/* Value + percentage */}
                      <AmountDisplay
                        value={category.value}
                        currency={baseCurrency}
                        className="shrink-0 text-sm"
                      />
                      <span className="text-muted-foreground w-12 shrink-0 text-right text-xs tabular-nums">
                        {category.percentage.toFixed(1)}%
                      </span>
                    </div>

                    {/* Children rows */}
                    {hasChildren && (
                      <div
                        className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${
                          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                        }`}
                      >
                        <div className="overflow-hidden">
                          <div
                            className={`bg-muted/30 ${!(isLast && isExpanded) ? "border-t" : ""}`}
                          >
                            {category.children!.map((child, childIdx) => {
                              const isChildSelected = selectedCategoryId === child.categoryId;

                              return (
                                <div
                                  key={child.categoryId}
                                  className={`flex cursor-pointer items-center gap-3 py-2.5 pl-11 pr-4 transition-colors ${
                                    isChildSelected ? "bg-muted" : "hover:bg-muted/50"
                                  } ${childIdx > 0 ? "border-t border-dashed" : ""}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleChildClick(child);
                                  }}
                                >
                                  <div
                                    className="h-2 w-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: child.color }}
                                  />
                                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                                    {child.categoryName}
                                  </span>
                                  <AmountDisplay
                                    value={child.value}
                                    currency={baseCurrency}
                                    className="text-muted-foreground shrink-0 text-xs"
                                  />
                                  <span className="text-muted-foreground w-12 shrink-0 text-right text-xs tabular-nums">
                                    {child.percentage.toFixed(1)}%
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Holdings List */}
          {selectedCategoryId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  <Trans
                    i18nKey="holdings:holdings_in_category"
                    values={{ category: selectedCategoryName }}
                    components={{
                      1: <span style={{ color: selectedColor ?? undefined }} />,
                    }}
                  />
                </h3>
                <Button variant="ghost" size="sm" onClick={handleClearSelection}>
                  {t("common:clear")}
                </Button>
              </div>

              {holdingsLoadingForSelection ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3 py-3">
                      <Skeleton className="h-9 w-9 rounded-full" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-16" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                      <div className="space-y-1.5 text-right">
                        <Skeleton className="ml-auto h-4 w-20" />
                        <Skeleton className="ml-auto h-3 w-12" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : holdingsError ? (
                <div className="space-y-3 py-4 text-center">
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-sm">
                      {t("holdings:could_not_load_holdings")}
                    </p>
                    {holdingsQueryError?.message && (
                      <p className="text-muted-foreground text-xs">{holdingsQueryError.message}</p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refetchAllocationHoldings()}
                  >
                    {t("common:retry")}
                  </Button>
                </div>
              ) : holdings && holdings.length > 0 ? (
                <div className="divide-y">
                  {holdings.map((holding, index) => {
                    const canNavigate = holding.holdingType !== HoldingType.CASH;
                    const isCash = holding.holdingType === HoldingType.CASH;
                    const avatarSymbol = isCash ? `CASH:${holding.currency}` : holding.symbol;
                    const primaryLabel = isCash
                      ? (holding.accountName ?? holding.symbol)
                      : holding.symbol;
                    const secondaryLabel = isCash
                      ? (holding.name ??
                        t("holdings:cash_with_currency", { currency: holding.currency }))
                      : (holding.name ?? holding.symbol);
                    const rowKey = isCash
                      ? [
                          categoryId,
                          holding.id,
                          holding.accountName ?? "",
                          holding.symbol,
                          holding.currency,
                          index,
                        ].join(":")
                      : `${categoryId}:${holding.id}`;
                    return (
                      <div
                        key={rowKey}
                        className={cn(
                          "flex items-center gap-3 py-3 transition-colors",
                          canNavigate ? "hover:bg-muted/30 cursor-pointer" : "cursor-default",
                        )}
                        onClick={() => handleHoldingClick(holding)}
                      >
                        <TickerAvatar symbol={avatarSymbol} className="h-9 w-9" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">{primaryLabel}</p>
                          <p className="text-muted-foreground truncate text-xs">{secondaryLabel}</p>
                        </div>
                        <div className="text-right">
                          <AmountDisplay
                            value={holding.marketValue}
                            currency={baseCurrency}
                            className="text-sm font-medium"
                          />
                          <p className="text-muted-foreground text-xs">
                            {holding.weightInCategory.toFixed(1)}%
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground py-4 text-center text-sm">
                  {t("holdings:no_holdings_in_category")}
                </p>
              )}
            </div>
          )}

          {!hasData && (
            <p className="text-muted-foreground py-8 text-center">
              {t("holdings:no_allocation_data")}
            </p>
          )}
        </div>

        <SheetFooter className="border-t pt-4">
          <SheetClose asChild>
            <Button variant="outline" className="w-full">
              {t("holdings:close")}
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
