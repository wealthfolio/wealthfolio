import { EmptyPlaceholder, PrivacyAmount } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { listPrivateAssetRows } from "@/adapters";
import { useHoldings } from "@/hooks/use-holdings";
import { usePortfolioAllocations } from "@/hooks/use-portfolio-allocations";
import { usePortfolios } from "@/hooks/use-portfolios";
import { usePrivateAssetsEnabled } from "@/hooks/use-private-assets-enabled";
import { isAlternativeAssetKind, type AssetKind } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type {
  AccountScope,
  PrivateAssetFreshnessState,
  PrivateAssetListRow,
  TaxonomyAllocation,
} from "@/lib/types";
import { useNavigate } from "react-router-dom";
import {
  formatPrivateAssetStrategy,
  getFreshnessBadgeClass,
} from "@/pages/settings/private-assets/private-assets-utils";
import { AllocationDetailSheet } from "./components/allocation-detail-sheet";
import { CashHoldingsWidget } from "./components/cash-holdings-widget";
import { CompactAllocationStrip } from "./components/compact-allocation-strip";
import { PortfolioComposition } from "./components/composition-chart";
import { HoldingCurrencyChart } from "./components/currency-chart";
import { DrillableAccountChart } from "./components/drillable-account-chart";
import { DrillableDonutChart } from "./components/drillable-donut-chart";
import { SectorsChart } from "./components/sectors-chart";
import { SegmentedAllocationBar } from "./components/segmented-allocation-bar";

interface HoldingsInsightsPageProps {
  accountId?: string;
  filter?: AccountScope;
}

const PRIVATE_STRATEGY_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
] as const;

const PRIVATE_FRESHNESS_ORDER: readonly PrivateAssetFreshnessState[] = [
  "CURRENT",
  "STALE",
  "ESTIMATED",
  "MISSING",
];

const PRIVATE_FRESHNESS_LABELS: Record<PrivateAssetFreshnessState, string> = {
  CURRENT: "Current",
  STALE: "Stale",
  ESTIMATED: "Estimated",
  MISSING: "Missing",
};

export const HoldingsInsightsPage = ({
  accountId: accountIdProp,
  filter: filterProp,
}: HoldingsInsightsPageProps) => {
  const navigate = useNavigate();
  const { settings } = useSettingsContext();
  const privateAssetsEnabled = usePrivateAssetsEnabled();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const accountFilter: AccountScope =
    filterProp ?? (accountIdProp ? { type: "account", accountId: accountIdProp } : { type: "all" });
  const { holdings, isLoading: holdingsLoading } = useHoldings(accountFilter);
  const { allocations, isLoading: allocationsLoading } = usePortfolioAllocations(accountFilter);

  const { data: portfolios = [] } = usePortfolios();
  const filteredAccountIds = useMemo(() => {
    if (accountFilter.type === "account") return [accountFilter.accountId];
    if (accountFilter.type === "accounts") return accountFilter.accountIds;
    if (accountFilter.type === "portfolio") {
      return portfolios.find((p) => p.id === accountFilter.portfolioId)?.accountIds ?? [];
    }
    return undefined; // "all" → DrillableAccountChart shows every account
  }, [accountFilter, portfolios]);

  const showPrivateAssetsSection = privateAssetsEnabled && accountFilter.type === "all";
  const privateAssetsQuery = useQuery<PrivateAssetListRow[], Error>({
    enabled: showPrivateAssetsSection,
    queryKey: QueryKeys.privateAssetRows(false),
    queryFn: () => listPrivateAssetRows(false),
  });
  const privateAssetRows = privateAssetsQuery.data ?? [];

  const isLoading =
    holdingsLoading ||
    allocationsLoading ||
    (showPrivateAssetsSection && privateAssetsQuery.isLoading);

  // State for allocation detail sheet
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [selectedAllocation, setSelectedAllocation] = useState<TaxonomyAllocation | undefined>(
    undefined,
  );
  const [initialCategoryId, setInitialCategoryId] = useState<string | null>(null);

  // Map filter types to allocations
  const getAllocationForType = useCallback(
    (type: string): TaxonomyAllocation | undefined => {
      switch (type) {
        case "class":
          return allocations?.assetClasses;
        case "sector":
          return allocations?.sectors;
        case "country":
          return allocations?.regions;
        case "risk":
          return allocations?.riskCategory;
        case "securityType":
          return allocations?.securityTypes;
        default:
          // Check custom groups
          if (type === "custom" && allocations?.customGroups?.length) {
            return allocations.customGroups[0];
          }
          return undefined;
      }
    },
    [allocations],
  );

  // Handle chart section click - opens sheet with clicked category pre-selected
  const handleChartSectionClick = useCallback(
    (type: string, _name: string, _title?: string, categoryId?: string) => {
      const allocation = getAllocationForType(type);
      if (allocation) {
        setSelectedAllocation(allocation);
        setInitialCategoryId(categoryId ?? null);
        setIsSheetOpen(true);
      }
    },
    [getAllocationForType],
  );

  // Handle card click - opens sheet with first category selected
  const openAllocationSheet = useCallback((allocation: TaxonomyAllocation | undefined) => {
    if (allocation) {
      setSelectedAllocation(allocation);
      setInitialCategoryId(null); // Will default to first category
      setIsSheetOpen(true);
    }
  }, []);

  const { cashHoldings, nonCashHoldings } = useMemo(() => {
    const cash = holdings?.filter((holding) => holding.holdingType?.toLowerCase() === "cash") ?? [];
    const nonCash =
      holdings?.filter((holding) => {
        if (holding.holdingType?.toLowerCase() === "cash") return false;
        if (holding.assetKind && isAlternativeAssetKind(holding.assetKind as AssetKind))
          return false;
        return true;
      }) ?? [];

    return { cashHoldings: cash, nonCashHoldings: nonCash };
  }, [holdings]);

  const privateAssetStrategyAllocation = useMemo<TaxonomyAllocation | undefined>(() => {
    if (!showPrivateAssetsSection || privateAssetRows.length === 0) {
      return undefined;
    }

    const totals = new Map<string, number>();
    for (const row of privateAssetRows) {
      const currentValue = row.latestSnapshot?.currentValue ?? 0;
      if (currentValue <= 0) {
        continue;
      }
      totals.set(row.strategyType, (totals.get(row.strategyType) ?? 0) + currentValue);
    }

    const totalValue = Array.from(totals.values()).reduce((sum, value) => sum + value, 0);
    if (totalValue <= 0) {
      return undefined;
    }

    const categories = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([strategyType, value], index) => ({
        categoryId: strategyType,
        categoryName: formatPrivateAssetStrategy(rowStrategy(strategyType)),
        color: PRIVATE_STRATEGY_COLORS[index % PRIVATE_STRATEGY_COLORS.length],
        value,
        percentage: (value / totalValue) * 100,
      }));

    return {
      taxonomyId: "private-strategies",
      taxonomyName: "Private Strategies",
      color: PRIVATE_STRATEGY_COLORS[0],
      categories,
    };
  }, [privateAssetRows, showPrivateAssetsSection]);

  const privateAssetsSummary = useMemo(() => {
    const freshnessCounts: Record<PrivateAssetFreshnessState, number> = {
      CURRENT: 0,
      STALE: 0,
      ESTIMATED: 0,
      MISSING: 0,
    };

    let totalCurrentValue = 0;
    let latestAsOfDate: string | null = null;

    for (const row of privateAssetRows) {
      freshnessCounts[row.freshnessState] += 1;
      const currentValue = row.latestSnapshot?.currentValue ?? 0;
      totalCurrentValue += currentValue;

      const asOfDate = row.latestSnapshot?.asOfDate;
      if (asOfDate && (!latestAsOfDate || asOfDate > latestAsOfDate)) {
        latestAsOfDate = asOfDate;
      }
    }

    return {
      assetCount: privateAssetRows.length,
      freshnessCounts,
      latestAsOfDate,
      totalCurrentValue,
    };
  }, [privateAssetRows]);

  const hasPrivateAssets = showPrivateAssetsSection && privateAssetRows.length > 0;
  const hasNoHoldingsAtAll =
    !isLoading && (!holdings || holdings.length === 0) && !hasPrivateAssets;

  const hasRiskAllocations =
    allocations?.riskCategory && allocations.riskCategory.categories.length > 0;

  const hasCustomGroups =
    allocations?.customGroups?.some(
      (taxonomy) =>
        taxonomy.categories.length > 0 &&
        taxonomy.categories.some(
          (cat) => cat.value > 0 && cat.categoryName.toLowerCase() !== "unknown",
        ),
    ) ?? false;

  const renderEmptyState = () => (
    <div className="flex items-center justify-center py-16">
      <EmptyPlaceholder
        icon={<Icons.TrendingUp className="text-muted-foreground h-10 w-10" />}
        title="No holdings yet"
        description="Get started by adding your first transaction or quickly import your existing holdings from a CSV file."
      >
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <Button size="default" onClick={() => navigate("/activities/manage")}>
            <Icons.Plus className="mr-2 h-4 w-4" />
            Add Transaction
          </Button>
          {privateAssetsEnabled && (
            <Button
              size="default"
              variant="outline"
              onClick={() => navigate("/settings/private-assets")}
            >
              <Icons.Wallet className="mr-2 h-4 w-4" />
              Add Private Asset
            </Button>
          )}
          <Button size="default" variant="outline" onClick={() => navigate("/import")}>
            <Icons.Import className="mr-2 h-4 w-4" />
            Import from CSV
          </Button>
        </div>
      </EmptyPlaceholder>
    </div>
  );

  const renderAnalyticsView = () => {
    if (hasNoHoldingsAtAll) {
      return renderEmptyState();
    }

    return (
      <div className="space-y-4">
        {hasPrivateAssets && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <div className="col-span-1 lg:col-span-3">
              <SegmentedAllocationBar
                title="Private Strategies"
                allocation={privateAssetStrategyAllocation}
                baseCurrency={baseCurrency}
                isLoading={privateAssetsQuery.isLoading}
                onSegmentClick={() => navigate("/settings/private-assets")}
              />
            </div>

            <Card>
              <CardHeader className="gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-sm font-medium uppercase tracking-wider">
                      Private Assets
                    </CardTitle>
                    <CardDescription>
                      Portfolio-level marks from the private-assets layer.
                    </CardDescription>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate("/settings/private-assets")}
                  >
                    Manage
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs uppercase tracking-wider">
                    Current Value
                  </p>
                  <div className="text-xl font-semibold">
                    <PrivacyAmount
                      value={privateAssetsSummary.totalCurrentValue}
                      currency={baseCurrency}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg border p-3">
                    <p className="text-muted-foreground text-xs uppercase tracking-wider">Assets</p>
                    <p className="mt-1 text-lg font-semibold">{privateAssetsSummary.assetCount}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-muted-foreground text-xs uppercase tracking-wider">
                      Latest Mark
                    </p>
                    <p className="mt-1 text-sm font-medium">
                      {formatAsOfDate(privateAssetsSummary.latestAsOfDate)}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {PRIVATE_FRESHNESS_ORDER.map((state) => {
                    const count = privateAssetsSummary.freshnessCounts[state];
                    if (count === 0) return null;

                    return (
                      <Badge
                        key={state}
                        variant="outline"
                        className={getFreshnessBadgeClass(state)}
                      >
                        {PRIVATE_FRESHNESS_LABELS[state]} {count}
                      </Badge>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Row 1: Cash Balance (full width) */}
        <CashHoldingsWidget cashHoldings={cashHoldings ?? []} isLoading={isLoading} />

        {/* Row 2: 4 semi-donut charts */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HoldingCurrencyChart
            holdings={[...cashHoldings, ...nonCashHoldings]}
            baseCurrency={baseCurrency}
            isLoading={isLoading}
            onCurrencySectionClick={(currencyName) =>
              handleChartSectionClick("currency", currencyName, `Holdings in ${currencyName}`)
            }
          />

          <DrillableAccountChart isLoading={isLoading} accountIds={filteredAccountIds} />

          <DrillableDonutChart
            title="Classes"
            allocation={allocations?.assetClasses}
            baseCurrency={baseCurrency}
            isLoading={isLoading}
            onCategoryClick={(categoryId, categoryName) =>
              handleChartSectionClick(
                "class",
                categoryName,
                `Asset Class: ${categoryName}`,
                categoryId,
              )
            }
            onCardClick={() => openAllocationSheet(allocations?.assetClasses)}
          />

          <DrillableDonutChart
            title="Regions"
            allocation={allocations?.regions}
            baseCurrency={baseCurrency}
            isLoading={isLoading}
            onCategoryClick={(categoryId, categoryName) =>
              handleChartSectionClick(
                "country",
                categoryName,
                `Holdings in ${categoryName}`,
                categoryId,
              )
            }
            onCardClick={() => openAllocationSheet(allocations?.regions)}
          />
        </div>

        {/* Row 3: Composition (col-span-3) + Right column (Security Type, Risk Profile, Sectors) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <div className="col-span-1 lg:col-span-3">
            <PortfolioComposition holdings={nonCashHoldings ?? []} isLoading={isLoading} />
          </div>

          <div className="col-span-1 space-y-4">
            {hasRiskAllocations && (
              <CompactAllocationStrip
                title="Risk Composition"
                allocation={allocations?.riskCategory}
                baseCurrency={baseCurrency}
                isLoading={isLoading}
                variant="risk-composition"
                onSegmentClick={(categoryId, categoryName) =>
                  handleChartSectionClick(
                    "risk",
                    categoryName,
                    `Risk Category: ${categoryName}`,
                    categoryId,
                  )
                }
              />
            )}

            <CompactAllocationStrip
              title="Security Types"
              allocation={allocations?.securityTypes}
              baseCurrency={baseCurrency}
              isLoading={isLoading}
              variant="security-types"
              onSegmentClick={(categoryId, categoryName) =>
                handleChartSectionClick(
                  "securityType",
                  categoryName,
                  `Type: ${categoryName}`,
                  categoryId,
                )
              }
            />

            <SectorsChart
              allocation={allocations?.sectors}
              baseCurrency={baseCurrency}
              isLoading={isLoading}
              onSectorSectionClick={(categoryId, categoryName) =>
                handleChartSectionClick(
                  "sector",
                  categoryName,
                  `Holdings in Sector: ${categoryName}`,
                  categoryId,
                )
              }
            />
          </div>
        </div>

        {/* Row 4: Custom Groups (under composition, col-span-3) */}
        {hasCustomGroups && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            <div className="col-span-1 space-y-4 lg:col-span-3">
              {allocations?.customGroups?.map(
                (taxonomy) =>
                  taxonomy.categories.length > 0 &&
                  taxonomy.categories.some(
                    (cat) => cat.value > 0 && cat.categoryName.toLowerCase() !== "unknown",
                  ) && (
                    <SegmentedAllocationBar
                      key={taxonomy.taxonomyId}
                      title={taxonomy.taxonomyName}
                      allocation={taxonomy}
                      baseCurrency={baseCurrency}
                      isLoading={isLoading}
                      compact={true}
                      onSegmentClick={(categoryId, categoryName) =>
                        handleChartSectionClick(
                          "custom",
                          categoryName,
                          `${taxonomy.taxonomyName}: ${categoryName}`,
                          categoryId,
                        )
                      }
                    />
                  ),
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {renderAnalyticsView()}

      {/* Allocation Detail Sheet */}
      <AllocationDetailSheet
        isOpen={isSheetOpen}
        onOpenChange={setIsSheetOpen}
        allocation={selectedAllocation}
        accountFilter={accountFilter}
        baseCurrency={baseCurrency}
        initialCategoryId={initialCategoryId}
      />
    </>
  );
};

export default HoldingsInsightsPage;

function rowStrategy(strategyType: string) {
  return strategyType as PrivateAssetListRow["strategyType"];
}

function formatAsOfDate(value: string | null | undefined) {
  if (!value) {
    return "—";
  }

  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
