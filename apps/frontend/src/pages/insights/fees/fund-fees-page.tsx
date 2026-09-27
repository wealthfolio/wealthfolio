import { AccountScopeSelector } from "@/components/account-filter-selector";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useHoldings } from "@/hooks/use-holdings";
import { useAccountScopeStore } from "@/lib/account-scope-store";
import { useAssets } from "@/pages/asset/hooks/use-assets";
import { enrichAssetProfile, updateAssetProfile } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import type { AccountScope, Asset } from "@/lib/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  AmountDisplay,
  EmptyPlaceholder,
  Icons,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from "@wealthfolio/ui/components/ui/chart";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

interface FundFeesPageProps {
  accountFilter: AccountScope;
}

const PROJECTION_YEARS = [5, 10, 15, 20] as const;
const DEFAULT_ANNUAL_RETURN_PCT = 5;
const FEE_REVIEW_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

type FundType = "etf" | "mutual_fund" | "other";
type FundTypeFilter = "all" | FundType;
type FeeBand = "all" | "low" | "medium" | "high";

interface PreviousFeeSnapshot {
  rate: number | null;
  source: "provider" | "manual" | "missing";
  updatedAt?: string | null;
  providerSource?: string | null;
}

function getPreviousFeeSnapshot(asset: Asset): PreviousFeeSnapshot | null {
  const value = asset.metadata?.annualExpenseRatioPrevious;
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  const source = snapshot.source;
  if (source !== "provider" && source !== "manual" && source !== "missing") return null;
  return {
    rate:
      typeof snapshot.rate === "number" && Number.isFinite(snapshot.rate) && snapshot.rate >= 0
        ? snapshot.rate
        : null,
    source,
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : null,
    providerSource: typeof snapshot.providerSource === "string" ? snapshot.providerSource : null,
  };
}

function getProviderFeeRate(asset: Asset): number | null {
  const profile = asset.metadata?.profile;
  if (!profile || typeof profile !== "object") return null;
  const rate = (profile as Record<string, unknown>).annualExpenseRatioPct;
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate : null;
}

function getFundType(quoteType: unknown): FundType {
  if (typeof quoteType !== "string") return "other";
  const normalized = quoteType.trim().toUpperCase().replace(/[ _-]/g, "");
  if (normalized === "ETF" || normalized === "ETP") return "etf";
  if (["MUTUALFUND", "FUND", "OPENENDMUTUALFUND"].includes(normalized)) {
    return "mutual_fund";
  }
  return "other";
}

function matchesFeeBand(rate: number, band: FeeBand): boolean {
  if (band === "low") return rate <= 0.3;
  if (band === "medium") return rate > 0.3 && rate <= 0.75;
  if (band === "high") return rate > 0.75;
  return true;
}

const feeRateTone = (rate: number) =>
  rate <= 0.3
    ? "bg-success/10 text-success"
    : rate <= 0.75
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : "bg-destructive/10 text-destructive";

export default function FundFeesPage({ accountFilter }: FundFeesPageProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const setAccountScope = useAccountScopeStore((state) => state.setScope);
  const {
    holdings,
    isLoading: holdingsLoading,
    isError: holdingsError,
  } = useHoldings(accountFilter);
  const { assets, isLoading: assetsLoading, isError: assetsError } = useAssets();
  const { isBalanceHidden } = useBalancePrivacy();
  const amountFormatting = useAmountFormatting();
  const dateFormatting = useDateFormatting();
  const formatting = useNumberFormatting();
  const [fundTypeFilter, setFundTypeFilter] = useState<FundTypeFilter>("all");
  const [feeBand, setFeeBand] = useState<FeeBand>("all");
  const [scenarioAReductionPp, setScenarioAReductionPp] = useState(0.1);
  const [scenarioBReductionPp, setScenarioBReductionPp] = useState(0.2);
  const [isRefreshingMarketFees, setIsRefreshingMarketFees] = useState(false);
  const [restoringFeeAssetId, setRestoringFeeAssetId] = useState<string | null>(null);
  const [marketFeeRefreshMessage, setMarketFeeRefreshMessage] = useState<string | null>(null);
  const formatPercentagePoints = (value: number) =>
    new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);

  const allRows = useMemo(() => {
    const valuesByAsset = new Map<string, { value: number; currency: string }>();
    for (const holding of holdings) {
      if (holding.isClosed || !holding.instrument?.id) continue;
      const current = valuesByAsset.get(holding.instrument.id);
      valuesByAsset.set(holding.instrument.id, {
        value: (current?.value ?? 0) + holding.marketValue.base,
        currency: holding.baseCurrency,
      });
    }

    return assets
      .flatMap((asset) => {
        const position = valuesByAsset.get(asset.id);
        const manualRate = asset.metadata?.annualExpenseRatioPct;
        const profile = asset.metadata?.profile;
        const providerProfile =
          profile && typeof profile === "object" ? (profile as Record<string, unknown>) : null;
        const providerRate = providerProfile?.annualExpenseRatioPct;
        if (!position) return [];
        const hasManualRate =
          typeof manualRate === "number" && Number.isFinite(manualRate) && manualRate >= 0;
        const hasProviderRate =
          typeof providerRate === "number" && Number.isFinite(providerRate) && providerRate >= 0;
        const feeRate = hasProviderRate ? providerRate : hasManualRate ? manualRate : null;
        const updatedAt = hasProviderRate
          ? providerProfile?.annualExpenseRatioUpdatedAt
          : asset.metadata?.annualExpenseRatioUpdatedAt;
        const updatedAtValue = typeof updatedAt === "string" ? updatedAt : null;
        const updatedAtTimestamp = updatedAtValue ? Date.parse(updatedAtValue) : Number.NaN;
        const hasValidUpdatedAt =
          updatedAtValue !== null &&
          /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(updatedAtValue) &&
          Number.isFinite(updatedAtTimestamp);
        return [
          {
            id: asset.id,
            asset,
            previousFee: getPreviousFeeSnapshot(asset),
            name: asset.name || asset.displayCode || "",
            symbol: asset.displayCode || "",
            fundType: getFundType(providerProfile?.quoteType),
            feeRate,
            source: hasProviderRate ? "provider" : hasManualRate ? "manual" : "missing",
            updatedAt: updatedAtValue,
            needsReview:
              feeRate !== null &&
              (!hasValidUpdatedAt || Date.now() - updatedAtTimestamp > FEE_REVIEW_MAX_AGE_MS),
            value: position.value,
            annualCost: feeRate === null ? 0 : position.value * (feeRate / 100),
            currency: position.currency,
          },
        ];
      })
      .sort((a, b) => b.annualCost - a.annualCost);
  }, [assets, holdings]);

  const rows = allRows.filter(
    (row): row is typeof row & { feeRate: number } =>
      row.feeRate !== null &&
      row.feeRate > 0 &&
      (fundTypeFilter === "all" || row.fundType === fundTypeFilter) &&
      matchesFeeBand(row.feeRate, feeBand),
  );
  const simulationRows = allRows.filter(
    (row): row is typeof row & { feeRate: number } =>
      row.feeRate !== null &&
      row.feeRate >= 0 &&
      (fundTypeFilter === "all" || row.fundType === fundTypeFilter) &&
      matchesFeeBand(row.feeRate, feeBand),
  );
  const unknownFeeCount = allRows.filter(
    (row) =>
      row.source === "missing" && (fundTypeFilter === "all" || row.fundType === fundTypeFilter),
  ).length;
  const missingFeeRows = allRows.filter(
    (row) =>
      row.source === "missing" && (fundTypeFilter === "all" || row.fundType === fundTypeFilter),
  );
  const reviewFeeRows = rows.filter((row) => row.needsReview);
  const marketFeeChangeRows = allRows.filter(
    (row) => row.previousFee && (fundTypeFilter === "all" || row.fundType === fundTypeFilter),
  );
  const refreshableRows = allRows.filter(
    (row) =>
      row.asset.quoteMode === "MARKET" &&
      Boolean(row.asset.instrumentSymbol || row.asset.displayCode) &&
      (row.fundType !== "other" || row.feeRate !== null) &&
      (fundTypeFilter === "all" || row.fundType === fundTypeFilter) &&
      (row.feeRate === null || matchesFeeBand(row.feeRate, feeBand)),
  );
  const totalAnnualCost = rows.reduce((total, row) => total + row.annualCost, 0);
  const totalCurrentValue = simulationRows.reduce((total, row) => total + row.value, 0);
  const weightedAverageRate =
    totalCurrentValue > 0 ? (totalAnnualCost / totalCurrentValue) * 100 : 0;
  const highestAnnualCostProduct = rows[0] ?? null;
  const projectionCurrency = simulationRows[0]?.currency ?? rows[0]?.currency ?? "EUR";
  const projectionData = useMemo(() => {
    const projectCapital = (years: number, feeReductionPp: number) =>
      simulationRows.reduce((total, row) => {
        const netAnnualFactor =
          (1 + DEFAULT_ANNUAL_RETURN_PCT / 100) *
          (1 - Math.max(0, row.feeRate - feeReductionPp) / 100);
        return total + row.value * Math.pow(Math.max(0, netAnnualFactor), years);
      }, 0);
    return Array.from({ length: 21 }, (_, year) => ({
      year,
      current: projectCapital(year, 0),
      scenarioA: projectCapital(year, scenarioAReductionPp),
      scenarioB: projectCapital(year, scenarioBReductionPp),
    }));
  }, [simulationRows, scenarioAReductionPp, scenarioBReductionPp]);
  const projectionChartConfig = {
    current: {
      label: t("insights:insights.fees.scenario_current"),
      color: "var(--chart-1)",
    },
    scenarioA: {
      label: t("insights:insights.fees.scenario_fee_reduction", {
        value: formatPercentagePoints(scenarioAReductionPp),
      }),
      color: "var(--chart-2)",
    },
    scenarioB: {
      label: t("insights:insights.fees.scenario_fee_reduction", {
        value: formatPercentagePoints(scenarioBReductionPp),
      }),
      color: "var(--chart-3)",
    },
  } satisfies ChartConfig;
  const cacheUpdatedAsset = (updatedAsset: Asset) => {
    queryClient.setQueryData<Asset[]>([QueryKeys.ASSETS], (current) =>
      (current ?? assets).map((asset) => (asset.id === updatedAsset.id ? updatedAsset : asset)),
    );
    queryClient.setQueryData([QueryKeys.ASSET_DATA, updatedAsset.id], updatedAsset);
  };
  const handleRefreshMarketFees = async () => {
    if (isRefreshingMarketFees || refreshableRows.length === 0) return;
    setIsRefreshingMarketFees(true);
    setMarketFeeRefreshMessage(null);
    let changed = 0;
    let failed = 0;
    for (const row of refreshableRows) {
      try {
        const updatedAsset = await enrichAssetProfile(row.id);
        const marketRate = getProviderFeeRate(updatedAsset);
        if (marketRate !== null && (row.source !== "provider" || row.feeRate !== marketRate)) {
          changed += 1;
        }
        cacheUpdatedAsset(updatedAsset);
      } catch {
        failed += 1;
      }
    }
    setMarketFeeRefreshMessage(
      t("insights:insights.fees.market_fee_refresh_result", {
        checked: refreshableRows.length,
        changed,
        failed,
      }),
    );
    setIsRefreshingMarketFees(false);
  };
  const handleUndoMarketFeeUpdate = async (row: (typeof allRows)[number]) => {
    if (!row.previousFee || restoringFeeAssetId) return;
    setRestoringFeeAssetId(row.id);
    const metadata = { ...(row.asset.metadata ?? {}) };
    const profileValue = metadata.profile;
    const profile =
      profileValue && typeof profileValue === "object"
        ? { ...(profileValue as Record<string, unknown>) }
        : {};
    if (row.previousFee.source === "provider" && row.previousFee.rate !== null) {
      profile.annualExpenseRatioPct = row.previousFee.rate;
      if (row.previousFee.updatedAt) {
        profile.annualExpenseRatioUpdatedAt = row.previousFee.updatedAt;
      } else {
        delete profile.annualExpenseRatioUpdatedAt;
      }
      if (row.previousFee.providerSource) {
        profile.annualExpenseRatioSource = row.previousFee.providerSource;
      } else {
        delete profile.annualExpenseRatioSource;
      }
    } else {
      delete profile.annualExpenseRatioPct;
      delete profile.annualExpenseRatioUpdatedAt;
      delete profile.annualExpenseRatioSource;
    }
    if (profileValue || Object.keys(profile).length > 0) {
      metadata.profile = profile;
    } else {
      delete metadata.profile;
    }
    delete metadata.annualExpenseRatioPrevious;
    try {
      const restoredAsset = await updateAssetProfile({
        id: row.id,
        notes: row.asset.notes ?? "",
        metadata,
      });
      cacheUpdatedAsset(restoredAsset);
    } catch {
      setMarketFeeRefreshMessage(t("insights:insights.fees.market_fee_refresh_error"));
    } finally {
      setRestoringFeeAssetId(null);
    }
  };
  const isLoading = holdingsLoading || assetsLoading;
  const filters = (
    <div className="flex justify-end">
      <AccountScopeSelector value={accountFilter} onChange={setAccountScope} />
    </div>
  );
  const productFilters = (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="grid min-w-40 gap-1.5">
          <label className="text-muted-foreground text-xs font-medium">
            {t("insights:insights.fees.filter_fund_type")}
          </label>
          <Select
            value={fundTypeFilter}
            onValueChange={(value) => setFundTypeFilter(value as FundTypeFilter)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("insights:insights.fees.filter_all_types")}</SelectItem>
              <SelectItem value="etf">{t("insights:insights.fees.fund_type_etf")}</SelectItem>
              <SelectItem value="mutual_fund">
                {t("insights:insights.fees.fund_type_mutual")}
              </SelectItem>
              <SelectItem value="other">{t("insights:insights.fees.fund_type_other")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-40 gap-1.5">
          <label className="text-muted-foreground text-xs font-medium">
            {t("insights:insights.fees.filter_fee_level")}
          </label>
          <Select value={feeBand} onValueChange={(value) => setFeeBand(value as FeeBand)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("insights:insights.fees.filter_all_levels")}</SelectItem>
              <SelectItem value="low">{t("insights:insights.fees.fee_level_low")}</SelectItem>
              <SelectItem value="medium">{t("insights:insights.fees.fee_level_medium")}</SelectItem>
              <SelectItem value="high">{t("insights:insights.fees.fee_level_high")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex flex-col items-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isRefreshingMarketFees || refreshableRows.length === 0}
            onClick={() => void handleRefreshMarketFees()}
          >
            {isRefreshingMarketFees
              ? t("insights:insights.fees.refreshing_market_fees")
              : t("insights:insights.fees.refresh_market_fees", {
                  count: refreshableRows.length,
                })}
          </Button>
          {marketFeeRefreshMessage && (
            <p className="text-muted-foreground text-right text-xs" aria-live="polite">
              {marketFeeRefreshMessage}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
  const dataQualityNotice =
    missingFeeRows.length > 0 || reviewFeeRows.length > 0 || marketFeeChangeRows.length > 0 ? (
      <Card>
        <CardContent className="flex flex-wrap gap-x-6 gap-y-2 p-4 text-sm">
          {missingFeeRows.length > 0 && (
            <div className="text-amber-700 dark:text-amber-400">
              <span className="font-medium">
                {t("insights:insights.fees.missing_data_count", { count: missingFeeRows.length })}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {missingFeeRows.map((row) => row.name).join(", ")}
              </span>
            </div>
          )}
          {reviewFeeRows.length > 0 && (
            <div className="text-amber-700 dark:text-amber-400">
              <span className="font-medium">
                {t("insights:insights.fees.review_data_count", { count: reviewFeeRows.length })}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {reviewFeeRows.map((row) => row.name).join(", ")}
              </span>
            </div>
          )}
          {marketFeeChangeRows.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0 last:pb-0"
            >
              <div className="min-w-0">
                <span className="font-medium">{row.name}</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  {t("insights:insights.fees.market_fee_change", {
                    previous:
                      row.previousFee?.rate === null || !row.previousFee
                        ? t("insights:insights.fees.market_fee_previous_missing")
                        : formatting.formatPercent(row.previousFee.rate / 100),
                    current:
                      row.feeRate === null
                        ? t("insights:insights.fees.market_fee_previous_missing")
                        : row.feeRate === 0
                          ? t("insights:insights.fees.market_fee_current_hidden")
                          : formatting.formatPercent(row.feeRate / 100),
                  })}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={restoringFeeAssetId !== null}
                onClick={() => void handleUndoMarketFeeUpdate(row)}
              >
                {restoringFeeAssetId === row.id
                  ? t("insights:insights.fees.undoing_market_fee_update")
                  : t("insights:insights.fees.undo_market_fee_update")}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    ) : null;

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        {filters}
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (holdingsError || assetsError) {
    return (
      <div className="space-y-4 p-4">
        {filters}
        <p className="text-muted-foreground p-2 text-sm">
          {t("insights:insights.fees.load_error")}
        </p>
      </div>
    );
  }

  if (rows.length === 0 && simulationRows.length === 0) {
    return (
      <div className="space-y-4 p-4">
        {filters}
        {productFilters}
        {dataQualityNotice}
        <EmptyPlaceholder
          className="mx-auto flex max-w-[460px] items-center justify-center pt-12"
          icon={<Icons.Receipt className="text-muted-foreground h-10 w-10" />}
          title={t("insights:insights.fees.empty_title")}
          description={
            allRows.some((row) => row.feeRate !== null && row.feeRate > 0)
              ? t("insights:insights.fees.no_matching_products")
              : t("insights:insights.fees.empty_description")
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {filters}
      {productFilters}
      {dataQualityNotice}
      <div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-muted-foreground text-xs font-medium">
              {t("insights:insights.fees.annual_total")}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              <AmountDisplay
                value={totalAnnualCost}
                currency={projectionCurrency}
                isHidden={isBalanceHidden}
              />
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("insights:insights.fees.estimate_disclaimer")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-muted-foreground text-xs font-medium">
              {t("insights:insights.fees.weighted_average_rate")}
            </div>
            <div className="mt-1">
              <span
                className={`inline-flex rounded px-1.5 py-0.5 text-xl font-semibold tabular-nums ${feeRateTone(weightedAverageRate)}`}
              >
                {formatting.formatPercent(weightedAverageRate / 100)}
              </span>
            </div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t("insights:insights.fees.weighted_average_hint", {
                count: simulationRows.length,
              })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-muted-foreground text-xs font-medium">
              {t("insights:insights.fees.highest_annual_cost")}
            </div>
            {highestAnnualCostProduct && (
              <>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  <AmountDisplay
                    value={highestAnnualCostProduct.annualCost}
                    currency={highestAnnualCostProduct.currency}
                    isHidden={isBalanceHidden}
                  />
                </div>
                <div
                  className="text-muted-foreground mt-1 truncate text-xs"
                  title={highestAnnualCostProduct.name}
                >
                  {highestAnnualCostProduct.name}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {t("insights:insights.fees.projection_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <label htmlFor="fee-scenario-a-reduction" className="font-medium">
                  {t("insights:insights.fees.scenario_a_reduction")}
                </label>
                <span className="text-muted-foreground tabular-nums">
                  {formatPercentagePoints(scenarioAReductionPp)}
                </span>
              </div>
              <input
                id="fee-scenario-a-reduction"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={scenarioAReductionPp}
                onChange={(event) => setScenarioAReductionPp(Number(event.target.value))}
                className="lever-slider block w-full"
                aria-label={t("insights:insights.fees.scenario_a_reduction")}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <label htmlFor="fee-scenario-b-reduction" className="font-medium">
                  {t("insights:insights.fees.scenario_b_reduction")}
                </label>
                <span className="text-muted-foreground tabular-nums">
                  {formatPercentagePoints(scenarioBReductionPp)}
                </span>
              </div>
              <input
                id="fee-scenario-b-reduction"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={scenarioBReductionPp}
                onChange={(event) => setScenarioBReductionPp(Number(event.target.value))}
                className="lever-slider block w-full"
                aria-label={t("insights:insights.fees.scenario_b_reduction")}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("insights:insights.fees.scenario_reduction_help")}
          </p>
          <ChartContainer config={projectionChartConfig} className="h-[280px] w-full">
            <AreaChart data={projectionData} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
              <XAxis
                dataKey="year"
                ticks={[0, ...PROJECTION_YEARS]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(year: number) =>
                  year === 0
                    ? "0"
                    : t("insights:insights.fees.projection_years_short", { count: year })
                }
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={76}
                tickFormatter={(value: number) =>
                  isBalanceHidden
                    ? "•••"
                    : amountFormatting.formatCompactAmount(
                        value,
                        projectionCurrency,
                        true,
                        "narrowSymbol",
                      )
                }
              />
              <ChartTooltip
                cursor={false}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const year = Number(payload[0]?.payload?.year ?? label);
                  if (!Number.isFinite(year)) return null;

                  return (
                    <div className="border-border/50 bg-background min-w-44 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
                      <div className="font-medium">
                        {t("insights:insights.fees.projection_years", { count: year })}
                      </div>
                      <div className="mt-1.5 grid gap-1.5">
                        {payload.map((entry) => {
                          const fees = Number(entry.value);
                          if (!Number.isFinite(fees)) return null;
                          const seriesKey = String(entry.dataKey);
                          const seriesLabel =
                            seriesKey in projectionChartConfig
                              ? projectionChartConfig[
                                  seriesKey as keyof typeof projectionChartConfig
                                ].label
                              : seriesKey;
                          return (
                            <div
                              key={seriesKey}
                              className="flex items-center justify-between gap-4"
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <span
                                  className="size-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: entry.color }}
                                />
                                <span className="text-muted-foreground truncate">
                                  {seriesLabel}
                                </span>
                              </span>
                              <span className="shrink-0 font-mono tabular-nums">
                                {isBalanceHidden
                                  ? "••••"
                                  : amountFormatting.formatAmount(fees, projectionCurrency)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                }}
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                type="monotone"
                dataKey="current"
                stroke="var(--color-current)"
                fill="var(--color-current)"
                fillOpacity={0.16}
                strokeWidth={2}
                activeDot={{ r: 5 }}
              />
              <Area
                type="monotone"
                dataKey="scenarioA"
                stroke="var(--color-scenarioA)"
                fill="var(--color-scenarioA)"
                fillOpacity={0.06}
                strokeWidth={2}
                activeDot={{ r: 5 }}
              />
              <Area
                type="monotone"
                dataKey="scenarioB"
                stroke="var(--color-scenarioB)"
                fill="var(--color-scenarioB)"
                fillOpacity={0.03}
                strokeWidth={2}
                activeDot={{ r: 5 }}
              />
            </AreaChart>
          </ChartContainer>
          <p className="text-muted-foreground text-xs">
            {t("insights:insights.fees.projection_disclaimer")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("insights:insights.fees.simulation_note", {
              initialCapital: amountFormatting.formatAmount(totalCurrentValue, projectionCurrency),
              knownCount: simulationRows.length,
              unknownCount: unknownFeeCount,
            })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("insights:insights.fees.products_title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0 p-0">
          <div className="text-muted-foreground hidden grid-cols-[minmax(0,1fr)_8rem_10rem_10rem] gap-3 border-y px-5 py-2 text-xs font-medium md:grid">
            <span>{t("insights:insights.fees.product")}</span>
            <span className="text-right">{t("insights:insights.fees.rate")}</span>
            <span className="text-right">{t("insights:insights.fees.current_value")}</span>
            <span className="text-right">{t("insights:insights.fees.annual_cost")}</span>
          </div>
          {rows.length === 0 && (
            <p className="text-muted-foreground p-4 text-sm">
              {t("insights:insights.fees.no_matching_products")}
            </p>
          )}
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid gap-1.5 border-b px-4 py-2.5 last:border-b-0 md:grid-cols-[minmax(0,1fr)_8rem_10rem_10rem] md:items-center md:gap-3 md:px-5"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{row.name}</div>
                {row.symbol && <div className="text-muted-foreground text-xs">{row.symbol}</div>}
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                  <span>
                    {row.source === "manual"
                      ? t("insights:insights.fees.source_manual")
                      : t("insights:insights.fees.source_provider")}
                  </span>
                  {row.source === "manual" &&
                    row.updatedAt &&
                    Number.isFinite(Date.parse(row.updatedAt)) && (
                      <span>
                        {t("insights:insights.fees.updated_on", {
                          date: dateFormatting.formatDate(new Date(row.updatedAt)),
                        })}
                      </span>
                    )}
                  {row.needsReview && (
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      {t("insights:insights.fees.needs_review")}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex justify-between text-sm md:justify-end">
                <span className="text-muted-foreground md:hidden">
                  {t("insights:insights.fees.rate")}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${feeRateTone(row.feeRate)}`}
                >
                  {formatting.formatPercent(row.feeRate / 100)}
                </span>
              </div>
              <div className="flex justify-between text-sm md:justify-end">
                <span className="text-muted-foreground md:hidden">
                  {t("insights:insights.fees.current_value")}
                </span>
                <AmountDisplay
                  value={row.value}
                  currency={row.currency}
                  isHidden={isBalanceHidden}
                />
              </div>
              <div className="flex justify-between text-sm font-medium md:justify-end">
                <span className="text-muted-foreground md:hidden">
                  {t("insights:insights.fees.annual_cost")}
                </span>
                <AmountDisplay
                  value={row.annualCost}
                  currency={row.currency}
                  isHidden={isBalanceHidden}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
