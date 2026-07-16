import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { HistoryChart } from "@/components/history-chart";
import { DateRange, TimePeriod } from "@/lib/types";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, Card, CardContent, CardHeader, CardTitle, IntervalSelector } from "@wealthfolio/ui";
import { isAfter, parseISO, subMonths } from "date-fns";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useSettingsContext } from "@/lib/settings-provider";
import { CompactToolCard } from "./shared";

interface ValuationArgs {
  accountId?: string;
  startDate?: string;
  endDate?: string;
  displayMode?: "compact" | "full";
}

interface ValuationPoint {
  valuationDate: string;
  totalValue: number;
  netContribution: number;
  baseCurrency: string;
}

interface ValuationResult {
  accountId: string;
  accountName?: string | null;
  baseCurrency: string;
  valuations: ValuationPoint[];
}

const getInitialDateRange = (): DateRange => ({
  from: subMonths(new Date(), 3),
  to: new Date(),
});

/**
 * Normalize backend result to consistent shape, handling both camelCase and snake_case.
 */
const normalizeResult = (result: unknown, fallbackCurrency: string): ValuationResult | null => {
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
  const valuationsRaw = Array.isArray(candidate.valuations) ? candidate.valuations : [];
  const baseCurrency =
    (candidate.baseCurrency as string | undefined) ??
    (candidate.base_currency as string | undefined) ??
    (candidate.currency as string | undefined) ??
    fallbackCurrency;

  const valuations: ValuationPoint[] = valuationsRaw
    .map((entry) => entry as Record<string, unknown>)
    .map((entry) => ({
      valuationDate:
        (entry.valuationDate as string | undefined) ??
        (entry.valuation_date as string | undefined) ??
        (entry.date as string | undefined) ??
        "",
      totalValue: Number(
        (entry.totalValue as number | string | undefined) ??
          (entry.total_value as number | string | undefined) ??
          0,
      ),
      netContribution: Number(
        (entry.netContribution as number | string | undefined) ??
          (entry.net_contribution as number | string | undefined) ??
          0,
      ),
      baseCurrency:
        (entry.baseCurrency as string | undefined) ??
        (entry.base_currency as string | undefined) ??
        (entry.currency as string | undefined) ??
        baseCurrency,
    }))
    .filter((entry) => Boolean(entry.valuationDate));

  return {
    accountId:
      (candidate.accountId as string | undefined) ??
      (candidate.account_id as string | undefined) ??
      (candidate.accountScope as string | undefined) ??
      (candidate.account_scope as string | undefined) ??
      "Portfolio",
    accountName:
      (candidate.accountName as string | undefined) ??
      (candidate.account_name as string | undefined) ??
      null,
    baseCurrency,
    valuations,
  };
};

export const ValuationToolUI = makeAssistantToolUI<ValuationArgs, ValuationResult>({
  toolName: "get_valuation_history",
  render: (props) => {
    return <ValuationContent {...props} />;
  },
});

type ValuationContentProps = ToolCallMessagePartProps<ValuationArgs, ValuationResult>;

const ValuationContent = memo(ValuationContentImpl);

function ValuationContentImpl({ args, result, status }: ValuationContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const [period, setPeriod] = useState<TimePeriod>("3M");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(getInitialDateRange());

  const parsed = normalizeResult(result, baseCurrency);

  const chartData = useMemo(() => {
    if (!parsed?.valuations) return [];

    const fromDate = period === "ALL" ? undefined : dateRange?.from;
    const toDate = dateRange?.to;

    return parsed.valuations
      .filter((valuation) => {
        if (!fromDate && !toDate) return true;
        const valuationDate = parseISO(valuation.valuationDate);
        if (fromDate && isAfter(fromDate, valuationDate)) {
          return false;
        }
        if (toDate && isAfter(valuationDate, toDate)) {
          return false;
        }
        return true;
      })
      .map((valuation) => ({
        date: valuation.valuationDate,
        totalValue: valuation.totalValue,
        netContribution: valuation.netContribution,
        currency: valuation.baseCurrency ?? parsed.baseCurrency,
      }));
  }, [parsed?.valuations, parsed?.baseCurrency, period, dateRange?.from, dateRange?.to]);

  // Cast args to typed interface since makeAssistantToolUI provides ReadonlyJSONObject
  const typedArgs = args as ValuationArgs | undefined;

  const accountLabel =
    parsed?.accountName ?? parsed?.accountId ?? typedArgs?.accountId ?? "Portfolio";

  const isRunning = status?.type === "running";
  const isComplete = status?.type === "complete";
  const isIncomplete = status?.type === "incomplete" || status?.type === "requires-action";
  const hasData = chartData.length > 0;

  // Compact mode — just show a one-liner when used as a prerequisite
  if (args?.displayMode === "compact" && parsed && !isRunning) {
    return <CompactToolCard label={t("ai:valuation.fetched")} />;
  }

  // Empty state - don't render anything, let LLM explain
  if (isComplete && !hasData) {
    return null;
  }

  // Show chart when complete or we have data
  const shouldRenderChart = hasData && (isComplete || isIncomplete || !isRunning);

  const handleIntervalSelect = (
    code: TimePeriod,
    _description: string,
    range: DateRange | undefined,
  ) => {
    setPeriod(code);
    setDateRange(range);
  };

  return (
    <Card className="bg-muted/40 border-primary/10 max-h-[320px] overflow-hidden">
      <CardHeader className="flex flex-col gap-2 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{t("ai:valuation.title")}</CardTitle>
            <Badge variant="secondary" className="uppercase">
              {accountLabel}
            </Badge>
          </div>
          <IntervalSelector
            onIntervalSelect={handleIntervalSelect}
            isLoading={isRunning}
            defaultValue={period}
            className="w-full max-w-xs"
          />
        </div>
        {(typedArgs?.startDate || typedArgs?.endDate) && (
          <p className="text-muted-foreground text-xs">
            {t("ai:valuation.range", {
              start: typedArgs?.startDate ?? t("ai:valuation.start"),
              end: typedArgs?.endDate ?? t("ai:valuation.latest"),
            })}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <div className="bg-background/60 h-[200px] w-full min-w-[280px] rounded-xl border p-3 shadow-inner">
          {shouldRenderChart ? (
            <HistoryChart data={chartData} isLoading={false} />
          ) : (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 rounded-md border border-dashed px-3 text-sm">
              {isRunning ? (
                <>
                  <Icons.Spinner className="h-5 w-5 animate-spin" />
                  <span>{t("ai:valuation.fetching")}</span>
                </>
              ) : isIncomplete ? (
                <span>{t("ai:valuation.cancelled")}</span>
              ) : (
                <span>{t("ai:valuation.noHistory")}</span>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
