import { CategoryBadge, ReviewPill } from "@/features/spending/components/category-chips";
import { getBudgetGroupLabel, getEventTypeLabel } from "@/features/spending/lib/labels";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import { cn } from "@/lib/utils";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, useDateFormatting } from "@wealthfolio/ui";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PrivacyNumber } from "./shared";
import {
  MissingFxNote,
  SpendingBar,
  SpendingCard,
  SpendingCardSkeleton,
  SpendingUnavailable,
  categoryMetaOrFallback,
  useSpendingAmount,
  useSpendingCategoryMeta,
} from "./spending-card-shared";
import { unwrapSpendingResult } from "./spending-result-utils";
import type {
  EventSpendingSummariesOutput,
  GetBudgetOutput,
  SearchSpendingTransactionsOutput,
} from "./spending-tool-types";

type ToolArgs = Record<string, unknown>;

function isRunning(status: { type: string } | undefined) {
  return status?.type === "running";
}

// ============================================================================
// search_spending_transactions: a transaction table
// ============================================================================

type TransactionsProps = ToolCallMessagePartProps<ToolArgs, SearchSpendingTransactionsOutput>;

export function SpendingTransactionsContentImpl({ result, status }: TransactionsProps) {
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const meta = useSpendingCategoryMeta();
  const data = unwrapSpendingResult<SearchSpendingTransactionsOutput>(result);

  const title = t("ai:spendingCards.transactionsTitle");
  if (isRunning(status)) return <SpendingCardSkeleton title={title} />;
  if (!data) return null;
  if (data.context && data.context.availability !== "available") {
    return <SpendingUnavailable availability={data.context.availability} />;
  }

  const items = data.items ?? [];
  return (
    <SpendingCard
      title={title}
      subtitle={t("ai:spendingCards.showing", {
        shown: items.length,
        total: data.totalCount ?? items.length,
      })}
    >
      {items.length === 0 ? (
        <p className="text-muted-foreground py-2 text-xs">{t("ai:spendingCards.noTransactions")}</p>
      ) : (
        <div className="max-h-75 overflow-y-auto">
          <table className="w-full table-fixed text-xs">
            <thead>
              <tr className="text-muted-foreground border-b">
                <th className="w-[20%] pb-2 text-start font-medium sm:w-[22%]">
                  {t("ai:spendingCards.colDate")}
                </th>
                <th className="pb-2 text-start font-medium">{t("ai:spendingCards.colPayee")}</th>
                <th className="hidden w-[28%] pb-2 text-start font-medium sm:table-cell">
                  {t("ai:spendingCards.colCategory")}
                </th>
                <th className="w-[28%] pb-2 text-end font-medium sm:w-[20%]">
                  {t("ai:spendingCards.colAmount")}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const payee = (item.notes ?? "").trim();
                const allocations = item.effectiveAllocations ?? [];
                const first = allocations[0];
                const category = first
                  ? categoryMetaOrFallback(
                      first.categoryId,
                      meta,
                      t("ai:spendingCards.uncategorized"),
                    )
                  : null;
                const amount = item.netAmount ?? 0;
                const categoryChips = (
                  <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                    {category ? (
                      <CategoryBadge
                        name={category.name}
                        color={category.color}
                        icon={category.icon}
                      />
                    ) : item.cashFlowBucket === "spending" ? (
                      <ReviewPill label={t("ai:spendingCards.uncategorized")} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {allocations.length > 1 && (
                      <span className="text-muted-foreground shrink-0">
                        {t("ai:spendingCards.moreCategories", {
                          extra: allocations.length - 1,
                        })}
                      </span>
                    )}
                  </div>
                );
                return (
                  <tr key={item.id} className="border-border/50 border-b">
                    <td className="py-2 pe-2 whitespace-nowrap tabular-nums">
                      <span className="sm:hidden">
                        {dates.formatDate(item.activityDate, { month: "short", day: "numeric" })}
                      </span>
                      <span className="hidden sm:inline">
                        {dates.formatDate(item.activityDate)}
                      </span>
                    </td>
                    <td className="py-2 pe-2">
                      <div className="truncate">
                        {payee || (
                          <span className="text-muted-foreground italic">
                            {t("ai:spendingCards.noPayee")}
                          </span>
                        )}
                      </div>
                      {/* Phones have no category column: show the chip under the payee. */}
                      <div className="mt-1 sm:hidden">{categoryChips}</div>
                    </td>
                    <td className="hidden py-2 pe-2 sm:table-cell">{categoryChips}</td>
                    <td
                      className={cn(
                        "py-2 text-end whitespace-nowrap tabular-nums",
                        amount > 0 && "text-success",
                      )}
                    >
                      {amount < 0 ? "−" : amount > 0 ? "+" : ""}
                      <PrivacyNumber value={Math.abs(amount)} currency={item.currency} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SpendingCard>
  );
}

// ============================================================================
// get_budget: budget groups with progress
// ============================================================================

type BudgetProps = ToolCallMessagePartProps<ToolArgs, GetBudgetOutput>;

export function SpendingBudgetContentImpl({ result, status }: BudgetProps) {
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const formatAmount = useSpendingAmount();
  const data = unwrapSpendingResult<GetBudgetOutput>(result);
  const computed = data?.budget?.computed;

  const title = t("ai:spendingCards.budgetTitle");
  if (isRunning(status)) return <SpendingCardSkeleton title={title} />;
  if (!data || !computed) return null;

  const currency = computed.currency;
  const rows = computed.groupRows.filter((row) => row.plannedTotal > 0 || row.actual > 0);
  const totals = computed.totals;
  const subtitle =
    computed.periodKey === "default"
      ? t("ai:spendingCards.defaultBudget")
      : dates.formatCalendarDate(`${computed.periodKey}-01`, { month: "long", year: "numeric" });

  return (
    <SpendingCard
      title={title}
      subtitle={subtitle}
      badge={
        totals.spendingPlanned > 0 ? (
          <Badge variant={totals.overspentCount > 0 ? "destructive-subtle" : "outline"}>
            {t("ai:spendingCards.budgetUsed", {
              actual: formatAmount(totals.spendingActual, currency),
              planned: formatAmount(totals.spendingPlanned, currency),
            })}
          </Badge>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground py-2 text-xs">{t("ai:spendingCards.noBudget")}</p>
      ) : (
        <div className="space-y-3 text-xs">
          {rows.map((row) => {
            const fraction = row.plannedTotal > 0 ? row.actual / row.plannedTotal : 1;
            return (
              <div key={row.group.id}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate">
                    {getBudgetGroupLabel(t, row.group.id, row.group.name)}
                  </span>
                  <span
                    className={cn("shrink-0 tabular-nums", row.overspent && "text-destructive")}
                  >
                    {row.overspent
                      ? t("ai:spendingCards.overBy", {
                          used: t("ai:spendingCards.budgetUsed", {
                            actual: formatAmount(row.actual, currency),
                            planned: formatAmount(row.plannedTotal, currency),
                          }),
                          amount: formatAmount(row.actual - row.plannedTotal, currency),
                        })
                      : t("ai:spendingCards.budgetUsed", {
                          actual: formatAmount(row.actual, currency),
                          planned: formatAmount(row.plannedTotal, currency),
                        })}
                  </span>
                </div>
                <SpendingBar fraction={fraction} danger={row.overspent} />
              </div>
            );
          })}
        </div>
      )}
      <MissingFxNote quality={computed.calculationQuality} />
    </SpendingCard>
  );
}

// ============================================================================
// get_event_spending_summaries: one row per event
// ============================================================================

type EventsProps = ToolCallMessagePartProps<ToolArgs, EventSpendingSummariesOutput>;

export function SpendingEventsContentImpl({ result, status }: EventsProps) {
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const data = unwrapSpendingResult<EventSpendingSummariesOutput>(result);

  const summaries = useMemo(
    () => [...(data?.summaries ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [data?.summaries],
  );
  const missingFx = useMemo(
    () => ({
      missingFxTransactions: summaries.reduce(
        (sum, summary) => sum + (summary.calculationQuality?.missingFxTransactions ?? 0),
        0,
      ),
      missingFxCurrencies: [],
    }),
    [summaries],
  );

  const title = t("ai:spendingCards.eventsTitle");
  if (isRunning(status)) return <SpendingCardSkeleton title={title} />;
  if (!data) return null;
  if (data.context && data.context.availability !== "available") {
    return <SpendingUnavailable availability={data.context.availability} />;
  }

  return (
    <SpendingCard
      title={title}
      subtitle={t("ai:spendingCards.eventsCount", { count: summaries.length })}
    >
      {summaries.length === 0 ? (
        <p className="text-muted-foreground py-2 text-xs">{t("ai:spendingCards.noEvents")}</p>
      ) : (
        <div className="max-h-75 overflow-y-auto text-xs">
          {summaries.map((summary) => {
            const top = Object.values(summary.byCategory ?? {}).sort(
              (a, b) => b.amount - a.amount,
            )[0];
            const topName = top
              ? top.categoryId
                ? getCategoryLabel(t, "spending_categories", top.categoryId, top.categoryName)
                : t("ai:spendingCards.uncategorized")
              : null;
            const range =
              summary.startDate === summary.endDate
                ? dates.formatCalendarDate(summary.startDate)
                : dates.formatCalendarDateRange(summary.startDate, summary.endDate);
            const details = [
              range,
              t("ai:spendingCards.transactionsCount", { count: summary.transactionCount }),
              ...(topName ? [t("ai:spendingCards.mostly", { category: topName })] : []),
            ].join(" · ");
            return (
              <div key={summary.eventId} className="border-border/50 border-b py-2 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="bg-muted-foreground h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={
                        summary.eventTypeColor
                          ? { backgroundColor: summary.eventTypeColor }
                          : undefined
                      }
                    />
                    <span className="truncate font-medium">{summary.eventName}</span>
                    <Badge variant="outline" className="shrink-0">
                      {getEventTypeLabel(t, summary.eventTypeId, summary.eventTypeName)}
                    </Badge>
                  </div>
                  <PrivacyNumber
                    value={summary.totalSpending}
                    currency={summary.currency}
                    className="shrink-0 tabular-nums"
                  />
                </div>
                <p className="text-muted-foreground mt-1 ps-4.5">{details}</p>
              </div>
            );
          })}
        </div>
      )}
      <MissingFxNote quality={missingFx} />
    </SpendingCard>
  );
}

// ============================================================================
// Registrations
// ============================================================================

const SpendingTransactionsContent = memo(SpendingTransactionsContentImpl);
const SpendingBudgetContent = memo(SpendingBudgetContentImpl);
const SpendingEventsContent = memo(SpendingEventsContentImpl);

export const SpendingTransactionsToolUI = makeAssistantToolUI<
  ToolArgs,
  SearchSpendingTransactionsOutput
>({
  toolName: "search_spending_transactions",
  render: (props) => <SpendingTransactionsContent {...props} />,
});

export const SpendingBudgetToolUI = makeAssistantToolUI<ToolArgs, GetBudgetOutput>({
  toolName: "get_budget",
  render: (props) => <SpendingBudgetContent {...props} />,
});

export const SpendingEventsToolUI = makeAssistantToolUI<ToolArgs, EventSpendingSummariesOutput>({
  toolName: "get_event_spending_summaries",
  render: (props) => <SpendingEventsContent {...props} />,
});
