import { usePersistentState } from "@/hooks/use-persistent-state";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  formatAmount,
  formatPercent,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { memo, useMemo, type FC } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { ResponsiveContainer, Treemap, Tooltip as ChartTooltip } from "recharts";
import { useSettingsContext } from "@/lib/settings-provider";
import { AnimatedToggleGroup } from "@wealthfolio/ui";
import { CompactToolCard } from "./shared";
import {
  calculateBasePortfolioPerformance,
  calculateDailyPortfolioPerformance,
  getPortfolioChangePercent,
  type ReturnType,
} from "./holdings-tool-semantics";

// ============================================================================
// Types
// ============================================================================

type ViewMode = "table" | "treemap" | "both";

interface GetHoldingsArgs {
  accountId?: string;
  viewMode?: ViewMode;
  displayMode?: "compact" | "full";
}

interface HoldingDto {
  account: string;
  symbol: string;
  name?: string | null;
  holdingType: string;
  quantity: number;
  marketValueBase: number;
  costBasisBase?: number | null;
  unrealizedGainPct?: number | null;
  totalGainBase?: number | null;
  totalGainPct?: number | null;
  incomeBase?: number | null;
  totalReturnBase?: number | null;
  totalReturnPct?: number | null;
  returnBasisBase?: number | null;
  dayChangePct?: number | null;
  weight: number;
  currency: string;
}

interface GetHoldingsOutput {
  holdings: HoldingDto[];
  totalValue: number;
  currency: string;
  accountScope: string;
  viewMode?: ViewMode;
  truncated?: boolean;
  originalCount?: number;
}

// ============================================================================
// Normalizer
// ============================================================================

/**
 * Normalizes the result to handle both wrapped and unwrapped formats,
 * as well as snake_case vs camelCase field names.
 */
function normalizeResult(result: unknown, fallbackCurrency: string): GetHoldingsOutput | null {
  if (!result) {
    return null;
  }

  if (typeof result === "string") {
    try {
      return normalizeResult(JSON.parse(result), fallbackCurrency);
    } catch {
      return null;
    }
  }

  if (typeof result !== "object" || result === null) {
    return null;
  }

  const candidate = result as Record<string, unknown>;

  // Handle wrapped format: { data: ..., meta: ... }
  if ("data" in candidate && typeof candidate.data === "object") {
    return normalizeResult(candidate.data, fallbackCurrency);
  }

  // Extract holdings array
  const holdingsRaw = Array.isArray(candidate.holdings) ? candidate.holdings : [];

  const holdings: HoldingDto[] = holdingsRaw
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => ({
      account: (entry.account as string | undefined) ?? "",
      symbol: (entry.symbol as string | undefined) ?? "",
      name: (entry.name as string | undefined) ?? null,
      holdingType:
        (entry.holdingType as string | undefined) ??
        (entry.holding_type as string | undefined) ??
        "Security",
      quantity: Number(entry.quantity ?? 0),
      marketValueBase: Number(
        (entry.marketValueBase as number | string | undefined) ??
          (entry.market_value_base as number | string | undefined) ??
          0,
      ),
      costBasisBase:
        entry.costBasisBase != null || entry.cost_basis_base != null
          ? Number(entry.costBasisBase ?? entry.cost_basis_base)
          : null,
      unrealizedGainPct:
        entry.unrealizedGainPct != null || entry.unrealized_gain_pct != null
          ? Number(entry.unrealizedGainPct ?? entry.unrealized_gain_pct)
          : null,
      totalGainBase:
        entry.totalGainBase != null || entry.total_gain_base != null
          ? Number(entry.totalGainBase ?? entry.total_gain_base)
          : null,
      totalGainPct:
        entry.totalGainPct != null || entry.total_gain_pct != null
          ? Number(entry.totalGainPct ?? entry.total_gain_pct)
          : null,
      incomeBase:
        entry.incomeBase != null || entry.income_base != null
          ? Number(entry.incomeBase ?? entry.income_base)
          : null,
      totalReturnBase:
        entry.totalReturnBase != null || entry.total_return_base != null
          ? Number(entry.totalReturnBase ?? entry.total_return_base)
          : null,
      totalReturnPct:
        entry.totalReturnPct != null || entry.total_return_pct != null
          ? Number(entry.totalReturnPct ?? entry.total_return_pct)
          : null,
      returnBasisBase:
        entry.returnBasisBase != null || entry.return_basis_base != null
          ? Number(entry.returnBasisBase ?? entry.return_basis_base)
          : null,
      dayChangePct:
        entry.dayChangePct != null || entry.day_change_pct != null
          ? Number(entry.dayChangePct ?? entry.day_change_pct)
          : null,
      weight: Number(entry.weight ?? 0),
      currency: (entry.currency as string | undefined) ?? fallbackCurrency,
    }));

  return {
    holdings,
    totalValue: Number(
      (candidate.totalValue as number | string | undefined) ??
        (candidate.total_value as number | string | undefined) ??
        0,
    ),
    currency: (candidate.currency as string | undefined) ?? fallbackCurrency,
    accountScope:
      (candidate.accountScope as string | undefined) ??
      (candidate.account_scope as string | undefined) ??
      "Portfolio",
    viewMode: ((candidate.viewMode as string | undefined) ??
      (candidate.view_mode as string | undefined)) as ViewMode | undefined,
    truncated: (candidate.truncated as boolean | undefined) ?? false,
    originalCount:
      (candidate.originalCount as number | undefined) ??
      (candidate.original_count as number | undefined),
  };
}

// ============================================================================
// Treemap Helpers
// ============================================================================

interface ColorScale {
  opacity: number;
  className: string;
}

function getColorScale(gain: number, maxGain: number, minGain: number): ColorScale {
  const isGain = gain >= 0;

  if (isNaN(gain) || isNaN(maxGain) || isNaN(minGain)) {
    return {
      opacity: 0.5,
      className: isGain ? "fill-success" : "fill-destructive",
    };
  }

  let relativePosition: number;
  if (isGain) {
    relativePosition = maxGain === 0 ? 0 : Math.min(1, gain / maxGain);
  } else {
    relativePosition = minGain === 0 ? 0 : Math.min(1, gain / minGain);
  }

  const opacity = Math.max(0.4, Math.min(0.85, 0.4 + Math.abs(relativePosition) * 0.45));

  return {
    opacity,
    className: isGain ? "fill-success" : "fill-destructive",
  };
}

function truncateText(text: string, maxWidth: number, fontSize: number): string {
  if (!text) return "";
  const charWidth = fontSize * 0.6;
  const maxChars = Math.floor(maxWidth / charWidth);
  if (text.length <= maxChars) return text;
  const truncatedLength = Math.max(1, maxChars - 3);
  return text.substring(0, truncatedLength) + "...";
}

interface TreemapContentProps {
  depth?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  symbol?: string;
  name?: string;
  gain?: number;
  maxGain?: number;
  minGain?: number;
}

const TreemapContent: FC<TreemapContentProps> = ({
  depth = 0,
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  symbol,
  gain = 0,
  maxGain = 0,
  minGain = 0,
}) => {
  const fontSize = Math.min(width, height) < 60 ? Math.min(width, height) * 0.18 : 11;
  const fontSize2 = Math.min(width, height) < 60 ? Math.min(width, height) * 0.14 : 10;
  const colorScale = getColorScale(gain, maxGain, minGain);
  const truncatedText = truncateText(symbol || "", width - 8, fontSize);

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6}
        ry={6}
        className={cn("stroke-card", {
          "stroke-[3px]": depth === 1,
          "fill-none stroke-0": depth === 0,
          [colorScale.className]: depth === 1,
        })}
        style={{ fillOpacity: colorScale.opacity }}
      />
      {depth === 1 && width > 30 && height > 25 && (
        <>
          <text
            x={x + width / 2}
            y={y + height / 2 - 2}
            textAnchor="middle"
            fill="currentColor"
            className="font-medium"
            style={{ fontSize }}
          >
            {truncatedText}
          </text>
          <text
            x={x + width / 2}
            y={y + height / 2 + fontSize}
            textAnchor="middle"
            fill="currentColor"
            className="font-light"
            style={{ fontSize: fontSize2 }}
          >
            {gain > 0 ? "+" + formatPercent(gain) : formatPercent(gain)}
          </text>
        </>
      )}
    </g>
  );
};

interface TreemapTooltipProps {
  active?: boolean;
  payload?: {
    value: number;
    payload: {
      symbol: string;
      name?: string;
      gain: number;
    };
  }[];
  currency?: string;
}

const TreemapTooltip: FC<TreemapTooltipProps> = ({ active, payload, currency = "USD" }) => {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;
  const value = payload[0].value;
  const gain = data.gain || 0;
  const isPositive = gain >= 0;

  return (
    <Card className="border shadow-lg">
      <CardContent className="space-y-2 p-3">
        <div>
          <span className="text-sm font-bold">{data.symbol}</span>
          {data.name && <p className="text-muted-foreground text-xs">{data.name}</p>}
        </div>
        <div className="border-t pt-2">
          <div className="flex items-center justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{t("ai:holdings.value")}</span>
            <span className="font-medium">{formatAmount(value, currency)}</span>
          </div>
          <div className="flex items-center justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{t("ai:holdings.today")}</span>
            <span className={cn("font-medium", isPositive ? "text-success" : "text-destructive")}>
              {isPositive ? "+" : ""}
              {formatPercent(gain)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

// ============================================================================
// Tool UI Component
// ============================================================================

const HoldingsContent = memo(HoldingsContentImpl);

export const HoldingsToolUI = makeAssistantToolUI<GetHoldingsArgs, GetHoldingsOutput>({
  toolName: "get_holdings",
  render: (props) => {
    return <HoldingsContent {...props} />;
  },
});

type HoldingsContentProps = ToolCallMessagePartProps<GetHoldingsArgs, GetHoldingsOutput>;

function HoldingsContentImpl({ args, result, status }: HoldingsContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const parsed = normalizeResult(result, baseCurrency);

  const [returnType, setReturnType] = usePersistentState<ReturnType>(
    "ai-holdings-performance-mode",
    "daily",
  );

  // Sort holdings by marketValueBase descending
  const sortedHoldings = useMemo(() => {
    if (!parsed?.holdings) return [];
    return [...parsed.holdings].sort((a, b) => b.marketValueBase - a.marketValueBase);
  }, [parsed?.holdings]);

  const currency = parsed?.currency ?? baseCurrency;

  // Calculate totals for summary
  const { totalValue, totalPnl, totalPnlPct, totalReturn, totalReturnPct } = useMemo(() => {
    if (!sortedHoldings.length) {
      return { totalValue: 0, totalPnl: 0, totalPnlPct: 0, totalReturn: 0, totalReturnPct: 0 };
    }
    const value =
      parsed?.totalValue ?? sortedHoldings.reduce((sum, h) => sum + h.marketValueBase, 0);
    const performance = calculateBasePortfolioPerformance(sortedHoldings);
    return {
      totalValue: value,
      ...performance,
    };
  }, [parsed?.totalValue, sortedHoldings]);

  // Prepare treemap data based on returnType
  // Note: dayChangePct and unrealizedGainPct from backend are in decimal form (e.g., -0.1579 for -15.79%)
  const { treemapData, hasData, dailyChangeAmount, weightedDailyChange } = useMemo(() => {
    let maxGain = -Infinity;
    let minGain = Infinity;
    let hasAnyData = false;
    const dailyPerformance = calculateDailyPortfolioPerformance(sortedHoldings);

    const data = sortedHoldings
      .filter((h) => h.marketValueBase !== 0)
      .map((h) => {
        const gain =
          returnType === "daily"
            ? (h.dayChangePct ?? 0)
            : returnType === "return"
              ? (h.totalReturnPct ?? h.totalGainPct ?? 0)
              : (h.totalGainPct ?? h.unrealizedGainPct ?? 0);

        if (gain !== 0) {
          hasAnyData = true;
          maxGain = Math.max(maxGain, gain);
          minGain = Math.min(minGain, gain);
        }
        return {
          symbol: h.symbol,
          name: h.name,
          marketValue: Math.abs(h.marketValueBase),
          gain,
        };
      });

    const treemapData = data.map((item) => ({
      ...item,
      maxGain: maxGain === -Infinity ? 0 : maxGain,
      minGain: minGain === Infinity ? 0 : minGain,
    }));

    return {
      treemapData,
      hasData: hasAnyData,
      dailyChangeAmount: dailyPerformance.changeAmount,
      weightedDailyChange: dailyPerformance.changePct,
    };
  }, [sortedHoldings, returnType]);

  const portfolioChange = getPortfolioChangePercent(
    returnType,
    weightedDailyChange,
    totalPnlPct,
    totalReturnPct,
  );

  const accountLabel = parsed?.accountScope ?? args?.accountId ?? "Portfolio";
  const isLoading = status?.type === "running";

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isLoading) {
    return <CompactToolCard label={t("ai:holdings.fetched", { count: parsed.holdings.length })} />;
  }
  const isComplete = status?.type === "complete" || status?.type === "incomplete";
  const hasError = status?.type === "incomplete" && status.reason === "error";
  const holdingsCount = sortedHoldings.length;

  // Format value with privacy
  const formatValue = (value: number) => {
    if (isBalanceHidden) {
      return "******";
    }
    return formatAmount(value, currency);
  };

  // Loading skeleton
  if (isLoading) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-sm font-medium">{t("ai:holdings.title")}</CardTitle>
              <Skeleton className="mt-1 h-3 w-16" />
            </div>
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <div className="max-h-[320px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 text-xs">{t("ai:holdings.colSymbol")}</TableHead>
                  <TableHead className="text-right text-xs">{t("ai:holdings.colValue")}</TableHead>
                  <TableHead className="hidden text-right text-xs sm:table-cell">
                    {t("ai:holdings.colWeight")}
                  </TableHead>
                  <TableHead className="pr-4 text-right text-xs">
                    {t("ai:holdings.colGain")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i} className="text-xs">
                    <TableCell className="py-2 pl-4">
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      <Skeleton className="ml-auto h-4 w-20" />
                    </TableCell>
                    <TableCell className="hidden py-2 text-right sm:table-cell">
                      <Skeleton className="ml-auto h-4 w-12" />
                    </TableCell>
                    <TableCell className="py-2 pr-4 text-right">
                      <Skeleton className="ml-auto h-4 w-14" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (hasError) {
    return (
      <Card className="bg-muted/40 border-destructive/30 w-full">
        <CardContent className="py-4">
          <p className="text-destructive text-sm">{t("ai:holdings.error")}</p>
        </CardContent>
      </Card>
    );
  }

  // Empty state - don't render anything, let LLM explain
  if (isComplete && holdingsCount === 0) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full">
        <CardContent className="py-4">
          <p className="text-muted-foreground text-sm">{t("ai:holdings.empty")}</p>
        </CardContent>
      </Card>
    );
  }

  // Determine view mode: use response viewMode, fallback to args, then default to "treemap"
  const viewMode = parsed?.viewMode ?? args?.viewMode ?? "treemap";
  const canShowTreemap = hasData && treemapData.length > 0;
  const returnLabel =
    returnType === "daily"
      ? t("ai:holdings.today")
      : returnType === "return"
        ? t("ai:holdings.totalReturn")
        : t("ai:holdings.totalPnl");

  // Treemap view component
  const TreemapView = () => (
    <div className="pb-2 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 pb-2">
        <div>
          <p className="text-sm font-medium">
            {t("ai:holdings.portfolioReturn", { label: returnLabel })}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("ai:holdings.positions", { count: holdingsCount })} · {returnLabel}
            {accountLabel !== "Portfolio" && (
              <Badge variant="outline" className="ml-2 text-xs uppercase">
                {accountLabel}
              </Badge>
            )}
          </p>
        </div>
        <div className="text-right">
          <span className="text-xl font-bold">{formatValue(totalValue)}</span>
          {!isBalanceHidden && (
            <p
              className={cn(
                "text-sm font-medium",
                portfolioChange == null
                  ? "text-muted-foreground"
                  : portfolioChange >= 0
                    ? "text-success"
                    : "text-destructive",
              )}
            >
              {portfolioChange == null ? (
                "-"
              ) : (
                <>
                  {portfolioChange > 0 ? "+" : ""}
                  {formatPercent(portfolioChange)}{" "}
                  {returnType === "daily"
                    ? t("ai:holdings.todaySuffix")
                    : returnType === "return"
                      ? t("ai:holdings.returnSuffix")
                      : t("ai:holdings.pnlSuffix")}
                </>
              )}
            </p>
          )}
        </div>
      </div>
      <div className="h-[240px] px-2">
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={treemapData}
            dataKey="marketValue"
            animationDuration={100}
            content={(props) => <TreemapContent {...props} />}
          >
            <ChartTooltip content={<TreemapTooltip currency={currency} />} />
          </Treemap>
        </ResponsiveContainer>
      </div>
    </div>
  );

  // Table view component
  const TableView = ({ showHeader = true }: { showHeader?: boolean }) => {
    const gainPct = portfolioChange;
    const gainAmount =
      returnType === "daily" ? dailyChangeAmount : returnType === "return" ? totalReturn : totalPnl;

    return (
      <>
        {showHeader && (
          <div className="flex flex-wrap items-start justify-between gap-2 px-4 pb-2">
            <div>
              <p className="text-sm font-medium">
                {t("ai:holdings.holdingsLabel", { label: returnLabel })}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {t("ai:holdings.positions", { count: holdingsCount })}
                {accountLabel !== "Portfolio" && (
                  <Badge variant="outline" className="ml-2 text-xs uppercase">
                    {accountLabel}
                  </Badge>
                )}
                {parsed?.truncated && parsed.originalCount && (
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {holdingsCount} / {parsed.originalCount}
                  </Badge>
                )}
              </p>
            </div>
            <div className="text-right">
              <span className="text-xl font-bold">{formatValue(totalValue)}</span>
              {!isBalanceHidden && (
                <p
                  className={cn(
                    "text-sm font-medium",
                    gainAmount >= 0 ? "text-success" : "text-destructive",
                  )}
                >
                  {gainAmount > 0 ? "+" : ""}
                  {formatAmount(gainAmount, currency)} (
                  {gainPct == null ? (
                    "-"
                  ) : (
                    <>
                      {gainPct > 0 ? "+" : ""}
                      {formatPercent(gainPct)}
                    </>
                  )}
                  )
                </p>
              )}
            </div>
          </div>
        )}
        <div className="max-h-[320px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-xs">{t("ai:holdings.colSymbol")}</TableHead>
                <TableHead className="text-right text-xs">{t("ai:holdings.colValue")}</TableHead>
                <TableHead className="hidden text-right text-xs sm:table-cell">
                  {t("ai:holdings.colWeight")}
                </TableHead>
                <TableHead className="pr-4 text-right text-xs">
                  {returnType === "daily"
                    ? t("ai:holdings.today")
                    : returnType === "return"
                      ? t("ai:holdings.return")
                      : t("ai:holdings.pnl")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedHoldings.map((holding) => {
                const tableGainPct =
                  returnType === "daily"
                    ? (holding.dayChangePct ?? null)
                    : returnType === "return"
                      ? (holding.totalReturnPct ?? holding.totalGainPct ?? null)
                      : (holding.totalGainPct ?? holding.unrealizedGainPct ?? null);
                return (
                  <TableRow key={`${holding.account}-${holding.symbol}`} className="text-xs">
                    <TableCell className="py-2 pl-4">
                      <div>
                        <div className="font-medium">{holding.symbol}</div>
                        {holding.name && (
                          <div className="text-muted-foreground max-w-[120px] truncate text-[10px] sm:max-w-[200px]">
                            {holding.name}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-right font-medium tabular-nums">
                      <div>{formatValue(holding.marketValueBase)}</div>
                      <div className="text-muted-foreground text-[10px]">{holding.currency}</div>
                    </TableCell>
                    <TableCell className="hidden py-2 text-right tabular-nums sm:table-cell">
                      {(holding.weight * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="py-2 pr-4 text-right">
                      {tableGainPct != null ? (
                        <span
                          className={cn(
                            "tabular-nums",
                            tableGainPct >= 0 ? "text-success" : "text-destructive",
                          )}
                        >
                          {tableGainPct > 0 ? "+" : ""}
                          {formatPercent(tableGainPct)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </>
    );
  };

  // Render based on viewMode
  const ReturnTypeToggle = (
    <AnimatedToggleGroup
      items={[
        { value: "daily", label: t("ai:holdings.daily") },
        { value: "pnl", label: t("ai:holdings.pnl") },
        { value: "return", label: t("ai:holdings.toggleReturn") },
      ]}
      value={returnType}
      onValueChange={(value: ReturnType) => setReturnType(value)}
      size="sm"
    />
  );

  if (viewMode === "both" && canShowTreemap) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
          {ReturnTypeToggle}
        </CardHeader>
        <CardContent className="p-0">
          <TreemapView />
          <div className="border-t pt-2">
            <TableView showHeader={false} />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (viewMode === "treemap" && canShowTreemap) {
    return (
      <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
          {ReturnTypeToggle}
        </CardHeader>
        <CardContent className="p-0">
          <TreemapView />
        </CardContent>
      </Card>
    );
  }

  // Table view (default fallback)
  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
        {ReturnTypeToggle}
      </CardHeader>
      <CardContent className="px-0 pb-0 pt-4">
        <TableView />
      </CardContent>
    </Card>
  );
}
