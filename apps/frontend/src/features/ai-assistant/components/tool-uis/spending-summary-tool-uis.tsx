import { getCategoryLabel } from "@/lib/taxonomy-labels";
import { cn } from "@/lib/utils";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, useDateFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { HealthStatus } from "@/features/spending/types/insight";
import { PrivacyNumber } from "./shared";
import {
  MissingFxNote,
  SpendingBar,
  SpendingCard,
  SpendingCardSkeleton,
  SpendingUnavailable,
  categoryMetaOrFallback,
  topLevelCategoryId,
  useSpendingAmount,
  useSpendingCategoryMeta,
} from "./spending-card-shared";
import { unwrapSpendingResult } from "./spending-result-utils";
import type {
  GetSpendingContextOutput,
  ListSpendingEventsOutput,
  SpendingInsightOutput,
  SpendingReportOutput,
} from "./spending-tool-types";

type ToolArgs = Record<string, unknown>;

function isRunning(status: { type: string } | undefined) {
  return status?.type === "running";
}

// ============================================================================
// One-line rows: get_spending_context, list_spending_events
// ============================================================================

type ContextProps = ToolCallMessagePartProps<ToolArgs, GetSpendingContextOutput>;

export function SpendingContextContentImpl({ result, status }: ContextProps) {
  const { t } = useTranslation();
  if (isRunning(status)) return null;
  const context = unwrapSpendingResult<GetSpendingContextOutput>(result);
  if (!context) return null;
  const label =
    context.availability === "disabled"
      ? t("ai:spendingCards.contextOff")
      : context.availability === "no_accounts"
        ? t("ai:spendingCards.contextNoAccounts")
        : t("ai:spendingCards.contextOn", {
            accounts: t("ai:spendingCards.accountsCount", { count: context.accountIds.length }),
            currency: context.baseCurrency,
            timezone: context.timezone,
          });
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      <Icons.Wallet className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </div>
  );
}

type EventsListProps = ToolCallMessagePartProps<ToolArgs, ListSpendingEventsOutput>;

export function ListSpendingEventsContentImpl({ result, status }: EventsListProps) {
  const { t } = useTranslation();
  if (isRunning(status)) return null;
  const data = unwrapSpendingResult<ListSpendingEventsOutput>(result);
  if (!data) return null;
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      <Icons.Calendar className="h-3.5 w-3.5 shrink-0" />
      <span>
        {t("ai:spendingCards.eventsSummary", {
          events: t("ai:spendingCards.eventsCount", { count: data.events?.length ?? 0 }),
          types: t("ai:spendingCards.eventTypesCount", { count: data.eventTypes?.length ?? 0 }),
        })}
      </span>
    </div>
  );
}

// ============================================================================
// get_spending_insight: spent against budget, categories ranked by spending
// ============================================================================

const STATUS_VARIANT: Record<
  HealthStatus,
  "success-subtle" | "warning-subtle" | "destructive-subtle"
> = {
  on_track: "success-subtle",
  approaching: "warning-subtle",
  over: "destructive-subtle",
  cashflow_negative: "destructive-subtle",
};

interface CategoryRow {
  id: string;
  name: string;
  color: string | null;
  spent: number;
  priorSpent: number;
  deltaVsPriorPct: number | null;
  overBudget: boolean;
}

function ChangeCell({ row }: { row: CategoryRow }) {
  const { t } = useTranslation();
  const numbers = useNumberFormatting();
  const pct = row.deltaVsPriorPct;
  if (pct === null || pct === undefined) {
    return row.priorSpent <= 0 && row.spent > 0 ? (
      <span className="text-muted-foreground">{t("ai:spendingCards.newCategory")}</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  const direction = pct > 0 ? "↑" : pct < 0 ? "↓" : "";
  return (
    <span
      className={cn(
        pct > 0 && "text-destructive",
        pct < 0 && "text-success",
        pct === 0 && "text-muted-foreground",
      )}
    >
      {direction} {numbers.formatPercent(Math.abs(pct), { digits: 0 })}
    </span>
  );
}

/**
 * Formats a period bound in the timezone the result was computed in, so a saved
 * chat keeps its days after the timezone setting changes.
 */
function formatPeriodDate(
  dates: ReturnType<typeof useDateFormatting>,
  value: string,
  timeZone: string | undefined,
) {
  return dates.formatDate(value, timeZone ? { dateStyle: "medium", timeZone } : {});
}

type InsightProps = ToolCallMessagePartProps<ToolArgs, SpendingInsightOutput>;

export function SpendingInsightContentImpl({ result, status }: InsightProps) {
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const numbers = useNumberFormatting();
  const formatAmount = useSpendingAmount();
  const data = unwrapSpendingResult<SpendingInsightOutput>(result);
  const insight = data?.insight;

  const { rows, emptyCount } = useMemo(() => {
    if (!insight) return { rows: [] as CategoryRow[], emptyCount: 0 };
    const categories = insight.groups.flatMap((group) => group.categories);
    const spentRows: CategoryRow[] = categories
      .filter((category) => category.spent > 0)
      .map((category) => ({
        id: category.categoryId,
        name: getCategoryLabel(t, category.taxonomyId, category.categoryId, category.name),
        color: category.color,
        spent: category.spent,
        priorSpent: category.priorSpent,
        deltaVsPriorPct: category.deltaVsPriorPct,
        overBudget: category.overspent && category.budget.total > 0,
      }));
    if (insight.uncategorized.spent > 0) {
      spentRows.push({
        id: "uncategorized",
        name: t("ai:spendingCards.uncategorized"),
        color: null,
        spent: insight.uncategorized.spent,
        priorSpent: insight.uncategorized.priorSpent,
        deltaVsPriorPct: insight.uncategorized.deltaVsPriorPct,
        overBudget: false,
      });
    }
    spentRows.sort((a, b) => b.spent - a.spent);
    return {
      rows: spentRows,
      emptyCount: categories.filter((category) => category.spent <= 0).length,
    };
  }, [insight, t]);

  const title = t("ai:spendingCards.insightTitle");
  if (isRunning(status)) return <SpendingCardSkeleton title={title} />;
  if (!data || !insight) return null;
  if (data.context && data.context.availability !== "available") {
    return <SpendingUnavailable availability={data.context.availability} />;
  }

  const { headline, currency } = insight;
  const subtitle = t("ai:spendingCards.period", {
    start: formatPeriodDate(dates, insight.period.start, data.context?.timezone),
    end: formatPeriodDate(dates, insight.period.end, data.context?.timezone),
  });

  return (
    <SpendingCard
      title={title}
      subtitle={subtitle}
      badge={
        <Badge variant={STATUS_VARIANT[headline.status] ?? "outline"}>
          {t(`ai:spendingCards.status.${headline.status}`)}
        </Badge>
      }
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <PrivacyNumber
          value={headline.spent}
          currency={currency}
          className="text-xl font-bold tabular-nums"
        />
        {headline.budget > 0 && (
          <span className="text-muted-foreground text-xs">
            {t("ai:spendingCards.ofBudget", { amount: formatAmount(headline.budget, currency) })}
          </span>
        )}
        {headline.deltaVsPriorPct !== null && headline.deltaVsPriorPct !== undefined && (
          <span
            className={cn(
              "text-xs",
              headline.deltaVsPriorPct > 0 ? "text-destructive" : "text-success",
            )}
          >
            {headline.deltaVsPriorPct > 0 ? "↑" : "↓"}{" "}
            {t("ai:spendingCards.vsPrevious", {
              percent: numbers.formatPercent(Math.abs(headline.deltaVsPriorPct), { digits: 0 }),
            })}
          </span>
        )}
      </div>
      {headline.budget > 0 && (
        <SpendingBar
          fraction={headline.spent / headline.budget}
          danger={headline.spent > headline.budget}
          className="mb-4"
        />
      )}

      {rows.length === 0 ? (
        <p className="text-muted-foreground py-2 text-xs">{t("ai:spendingCards.noSpending")}</p>
      ) : (
        <div className="max-h-62.5 overflow-y-auto">
          <table className="w-full table-fixed text-xs">
            <thead>
              <tr className="text-muted-foreground border-b text-start">
                <th className="pb-2 text-start font-medium">{t("ai:spendingCards.colCategory")}</th>
                <th className="hidden w-[22%] pb-2 text-start font-medium sm:table-cell">
                  {t("ai:spendingCards.colShare")}
                </th>
                <th className="w-[30%] pb-2 text-end font-medium whitespace-nowrap sm:w-[22%]">
                  {t("ai:spendingCards.colSpent")}
                </th>
                <th className="w-[20%] pb-2 text-end font-medium whitespace-nowrap sm:w-[16%]">
                  {t("ai:spendingCards.colChange")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const share = headline.spent > 0 ? row.spent / headline.spent : 0;
                return (
                  <tr key={row.id} className="border-border/50 border-b">
                    <td className="py-2 pe-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="bg-muted-foreground h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={row.color ? { backgroundColor: row.color } : undefined}
                        />
                        <span className="truncate">{row.name}</span>
                        {row.overBudget && (
                          <span className="text-destructive flex shrink-0 items-center">
                            <Icons.AlertCircle className="h-3 w-3 sm:hidden" aria-hidden="true" />
                            <span className="sr-only sm:not-sr-only">
                              {t("ai:spendingCards.overBudget")}
                            </span>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="hidden py-2 pe-3 sm:table-cell">
                      <SpendingBar fraction={share} color={row.color} />
                    </td>
                    <td className="py-2 text-end whitespace-nowrap tabular-nums">
                      <PrivacyNumber value={row.spent} currency={currency} />
                    </td>
                    <td className="py-2 text-end whitespace-nowrap tabular-nums">
                      <ChangeCell row={row} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {emptyCount > 0 && rows.length > 0 && (
        <p className="text-muted-foreground mt-2 text-xs">
          {t("ai:spendingCards.emptyCategories", { count: emptyCount })}
        </p>
      )}
      <MissingFxNote quality={insight.calculationQuality} />
    </SpendingCard>
  );
}

// ============================================================================
// get_spending_report: income, spending, saving and net, plus top categories
// ============================================================================

type ReportProps = ToolCallMessagePartProps<ToolArgs, SpendingReportOutput>;

const TOP_CATEGORY_COUNT = 3;

export function SpendingReportContentImpl({ result, status }: ReportProps) {
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const formatAmount = useSpendingAmount();
  const meta = useSpendingCategoryMeta();
  const data = unwrapSpendingResult<SpendingReportOutput>(result);
  const report = data?.report;

  // Breakdown rows can be subcategories: roll them up to their top-level category.
  const topCategories = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of report?.spendingBreakdown ?? []) {
      const id = topLevelCategoryId(row.categoryId, meta);
      totals.set(id, (totals.get(id) ?? 0) + row.amount);
    }
    return [...totals.entries()]
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_CATEGORY_COUNT)
      .map(([id, amount]) => ({
        id,
        amount,
        name: categoryMetaOrFallback(id, meta, t("ai:spendingCards.uncategorized")).name,
      }));
  }, [report?.spendingBreakdown, meta, t]);

  const title = t("ai:spendingCards.reportTitle");
  if (isRunning(status)) return <SpendingCardSkeleton title={title} />;
  if (!data || !report) return null;
  if (data.context && data.context.availability !== "available") {
    return <SpendingUnavailable availability={data.context.availability} />;
  }

  const currency = report.baseCurrency || data.period.currency;
  const current = report.current;
  const tiles = [
    { key: "income", value: current.income },
    { key: "spending", value: current.outflow },
    { key: "saved", value: current.saved - (current.fromSavings ?? 0) },
    { key: "net", value: current.net },
  ];

  return (
    <SpendingCard
      title={title}
      subtitle={t("ai:spendingCards.period", {
        start: formatPeriodDate(dates, data.period.startDate, data.context?.timezone),
        end: formatPeriodDate(dates, data.period.endDate, data.context?.timezone),
      })}
      badge={
        <Badge variant="outline" className="text-xs">
          {currency}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.key} className="bg-background/60 rounded-md px-3 py-2">
            <p className="text-muted-foreground text-xs">{t(`ai:spendingCards.${tile.key}`)}</p>
            <PrivacyNumber
              value={tile.value}
              currency={currency}
              className={cn(
                "text-sm font-semibold tabular-nums",
                tile.key === "net" && tile.value > 0 && "text-success",
                tile.key === "net" && tile.value < 0 && "text-destructive",
              )}
            />
          </div>
        ))}
      </div>
      {topCategories.length > 0 && (
        <p className="text-muted-foreground mt-3 text-xs">
          {t("ai:spendingCards.topSpending", {
            list: topCategories
              .map((category) =>
                t("ai:spendingCards.categoryAmount", {
                  name: category.name,
                  amount: formatAmount(category.amount, currency),
                }),
              )
              .join(" · "),
          })}
        </p>
      )}
      <MissingFxNote quality={current.calculationQuality} />
    </SpendingCard>
  );
}

// ============================================================================
// Registrations
// ============================================================================

const SpendingContextContent = memo(SpendingContextContentImpl);
const ListSpendingEventsContent = memo(ListSpendingEventsContentImpl);
const SpendingInsightContent = memo(SpendingInsightContentImpl);
const SpendingReportContent = memo(SpendingReportContentImpl);

export const SpendingContextToolUI = makeAssistantToolUI<ToolArgs, GetSpendingContextOutput>({
  toolName: "get_spending_context",
  render: (props) => <SpendingContextContent {...props} />,
});

export const ListSpendingEventsToolUI = makeAssistantToolUI<ToolArgs, ListSpendingEventsOutput>({
  toolName: "list_spending_events",
  render: (props) => <ListSpendingEventsContent {...props} />,
});

export const SpendingInsightToolUI = makeAssistantToolUI<ToolArgs, SpendingInsightOutput>({
  toolName: "get_spending_insight",
  render: (props) => <SpendingInsightContent {...props} />,
});

export const SpendingReportToolUI = makeAssistantToolUI<ToolArgs, SpendingReportOutput>({
  toolName: "get_spending_report",
  render: (props) => <SpendingReportContent {...props} />,
});
