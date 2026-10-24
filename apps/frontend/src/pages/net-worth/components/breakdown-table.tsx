import { DashboardCard } from "@/components/dashboard-card";
import { useNumberFormatting } from "@wealthfolio/ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CompactAmount } from "./compact-amount";
import { CompositionBar } from "./composition-bar";
import {
  CARD_LABEL,
  CATEGORY_CSS_COLORS,
  deriveChange,
  formatChangePercent,
  hadBalanceBefore,
  seriesFor,
  type Change,
  type ParsedHistoryPoint,
  type ParsedNetWorth,
  type SelectedCategory,
} from "./utils";

// Every section shares the same tracks, including the net-worth total. Layout
// follows the card width, since a desktop dashboard can still have narrow cards.
// Without subgrid, fractional tracks keep independently sized rows aligned.
const SHARED_GRID =
  "col-span-full grid grid-cols-(--breakdown-columns) gap-x-3 supports-[grid-template-columns:subgrid]:grid-cols-subgrid @min-[40rem]/breakdown:gap-x-4";
const ROW_GRID = `${SHARED_GRID} items-baseline gap-y-1`;
const NAME_CELL = "col-span-full min-w-0 @min-[28rem]/breakdown:col-span-1";
const AMOUNT_CELL =
  "min-w-0 text-end text-xs tabular-nums [overflow-wrap:anywhere] @min-[40rem]/breakdown:text-sm";

function ChangeCell({ change, currency }: { change: Change; currency: string }) {
  const formatting = useNumberFormatting();
  const { t } = useTranslation();
  const isZero = Math.abs(change.amount) < 0.005;
  const color = isZero
    ? "text-muted-foreground/60"
    : change.amount > 0
      ? "text-success"
      : "text-destructive";
  const sign = isZero ? "" : change.amount > 0 ? "+" : "-";
  return (
    <div className="@min-[48rem]/breakdown:flex-row @min-[48rem]/breakdown:flex-wrap @min-[48rem]/breakdown:items-baseline @min-[48rem]/breakdown:justify-end flex min-w-0 flex-col items-end gap-x-2 gap-y-0.5 text-end">
      <span className={`${AMOUNT_CELL} ${color} inline-flex items-baseline justify-end`}>
        {sign}
        <CompactAmount className="min-w-0" value={Math.abs(change.amount)} currency={currency} />
      </span>
      <span className={`text-muted-foreground/60 ${AMOUNT_CELL}`}>
        {formatChangePercent(change, t("insights:networth.breakdown_table.new"), formatting)}
      </span>
    </div>
  );
}

interface RowProps {
  name: string;
  dotColor: string;
  value: number;
  percentOfSection: number;
  change: Change;
  currency: string;
  negative?: boolean;
  onClick?: () => void;
}

function BreakdownRow({
  name,
  dotColor,
  value,
  percentOfSection,
  change,
  currency,
  negative,
  onClick,
}: RowProps) {
  const interactive = onClick
    ? "hover:bg-muted/40 cursor-pointer rounded-md transition-colors"
    : "";
  return (
    <div
      className={`${ROW_GRID} py-2 ${interactive}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className={`${NAME_CELL} flex items-center gap-2.5`}>
        <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
        <span className="text-foreground @min-[40rem]/breakdown:text-sm min-w-0 text-xs [overflow-wrap:anywhere]">
          {name}
        </span>
      </div>
      <span className="text-muted-foreground/70 @min-[40rem]/breakdown:block hidden text-end text-sm tabular-nums">
        {percentOfSection.toFixed(1)}%
      </span>
      <span className={`text-foreground ${AMOUNT_CELL} inline-flex items-baseline justify-end`}>
        {negative && value !== 0 ? "-" : ""}
        <CompactAmount className="min-w-0" value={value} currency={currency} />
      </span>
      <ChangeCell change={change} currency={currency} />
    </div>
  );
}

interface BreakdownTableProps {
  data: ParsedNetWorth;
  history: ParsedHistoryPoint[];
  currency: string;
  periodLabel: string;
  onSelect: (selected: SelectedCategory) => void;
}

export function BreakdownTable({
  data,
  history,
  currency,
  periodLabel,
  onSelect,
}: BreakdownTableProps) {
  const { t } = useTranslation();
  const hasLiabilities = data.liabilities.total > 0 || data.liabilities.breakdown.length > 0;
  const netWorthChange = deriveChange(
    history.map((point) => point.netWorth),
    false,
  );
  const [assetsOpen, setAssetsOpen] = useState(true);
  const [liabilitiesOpen, setLiabilitiesOpen] = useState(true);

  return (
    <div className="@container/breakdown min-w-0">
      <DashboardCard
        title={t("insights:networth.breakdown")}
        meta={t("insights:networth.breakdown_table.change_over", { period: periodLabel })}
      >
        <div className="grid-cols-(--breakdown-columns) @min-[28rem]/breakdown:[--breakdown-fallback-columns:repeat(3,minmax(0,1fr))] @min-[40rem]/breakdown:[--breakdown-fallback-columns:minmax(0,2fr)_4rem_minmax(0,1.5fr)_minmax(0,2fr)] supports-[grid-template-columns:subgrid]:@min-[28rem]/breakdown:[--breakdown-columns:minmax(0,1fr)_minmax(0,max-content)_minmax(0,max-content)] supports-[grid-template-columns:subgrid]:@min-[40rem]/breakdown:[--breakdown-columns:minmax(0,1fr)_max-content_minmax(0,max-content)_minmax(0,max-content)] @min-[40rem]/breakdown:gap-x-4 grid gap-x-3 [--breakdown-columns:var(--breakdown-fallback-columns)] [--breakdown-fallback-columns:repeat(2,minmax(0,1fr))]">
          {/* Assets — collapsible */}
          <Collapsible className={SHARED_GRID} open={assetsOpen} onOpenChange={setAssetsOpen}>
            <CollapsibleTrigger className="col-span-full flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-start">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <Icons.ChevronRight
                  className={`text-muted-foreground h-3.5 w-3.5 transition-transform ${assetsOpen ? "rotate-90" : "rtl:rotate-180"}`}
                />
                {t("insights:networth.breakdown_table.assets")}
              </span>
              <span className="text-success min-w-0 text-sm font-semibold tabular-nums [overflow-wrap:anywhere]">
                <CompactAmount value={data.assets.total} currency={currency} />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className={SHARED_GRID}>
              {/* Composition — proportion of assets (the rows below are its legend) */}
              <div className="border-border/60 col-span-full mb-1 mt-2.5 border-b pb-3">
                <CompositionBar data={data} />
              </div>

              {/* Column labels */}
              <div className={`${ROW_GRID} pt-2`}>
                <span className={`${CARD_LABEL} ${NAME_CELL}`}>
                  {t("insights:networth.breakdown_table.category")}
                </span>
                <span className={`${CARD_LABEL} @min-[40rem]/breakdown:block hidden text-end`}>
                  %
                </span>
                <span className={`${CARD_LABEL} min-w-0 text-end [overflow-wrap:anywhere]`}>
                  {t("insights:networth.breakdown_table.value")}
                </span>
                <span className={`${CARD_LABEL} min-w-0 text-end [overflow-wrap:anywhere]`}>
                  {t("insights:networth.breakdown_table.delta_period", { period: periodLabel })}
                </span>
              </div>

              <div className={`${SHARED_GRID} divide-border/40 divide-y`}>
                {data.assets.breakdown.map((item) => (
                  <BreakdownRow
                    key={item.category}
                    name={item.name}
                    dotColor={CATEGORY_CSS_COLORS[item.category] ?? "var(--muted-foreground)"}
                    value={item.value}
                    percentOfSection={
                      data.assets.total > 0 ? (item.value / data.assets.total) * 100 : 0
                    }
                    change={deriveChange(seriesFor(history, item.category), false)}
                    currency={currency}
                    onClick={() =>
                      onSelect({
                        key: item.category,
                        name: item.name,
                        value: item.value,
                        isLiability: false,
                        isInvestment: item.category === "investments",
                        children: item.children ?? [],
                      })
                    }
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Separator carrying the "−" operator (Assets − Liabilities), aligned to the icon column */}
          {hasLiabilities && (
            <div className="col-span-full my-3 flex items-center gap-1.5">
              <span className="text-muted-foreground w-3.5 shrink-0 text-center text-sm font-normal">
                −
              </span>
              <div className="border-border/60 flex-1 border-t" />
            </div>
          )}

          {/* Liabilities — collapsible */}
          {hasLiabilities && (
            <Collapsible
              className={SHARED_GRID}
              open={liabilitiesOpen}
              onOpenChange={setLiabilitiesOpen}
            >
              <CollapsibleTrigger className="col-span-full flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-start">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icons.ChevronRight
                    className={`text-muted-foreground h-3.5 w-3.5 transition-transform ${liabilitiesOpen ? "rotate-90" : "rtl:rotate-180"}`}
                  />
                  {t("insights:networth.breakdown_table.liabilities")}
                </span>
                <span className="text-destructive inline-flex min-w-0 items-baseline justify-end text-sm font-semibold tabular-nums [overflow-wrap:anywhere]">
                  -
                  <CompactAmount
                    className="min-w-0"
                    value={data.liabilities.total}
                    currency={currency}
                  />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className={SHARED_GRID}>
                <div className={`${SHARED_GRID} divide-border/40 divide-y pt-1`}>
                  {data.liabilities.breakdown.map((item, index) => {
                    const key = item.assetId ?? `${item.category}-${index}`;
                    const series = item.assetId ? seriesFor(history, item.assetId) : [];
                    return (
                      <BreakdownRow
                        key={key}
                        name={item.name}
                        dotColor={CATEGORY_CSS_COLORS.liabilities}
                        value={item.value}
                        negative
                        percentOfSection={
                          data.liabilities.total > 0
                            ? (item.value / data.liabilities.total) * 100
                            : 0
                        }
                        change={deriveChange(
                          series,
                          true,
                          hadBalanceBefore(history, item.firstValueDate),
                        )}
                        currency={currency}
                        onClick={
                          item.assetId
                            ? () =>
                                onSelect({
                                  key: item.assetId!,
                                  name: item.name,
                                  value: item.value,
                                  isLiability: true,
                                  isInvestment: false,
                                  firstValueDate: item.firstValueDate,
                                  children: [],
                                })
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Net Worth total — label indented (chevron-sized spacer) to align with the
          Assets/Liabilities section labels; value/Δ stay in the grid columns. */}
          <div className={`${ROW_GRID} border-border/60 mt-3 border-t pt-3`}>
            <span
              className={`${NAME_CELL} flex items-baseline gap-1.5 text-sm font-bold [overflow-wrap:anywhere]`}
            >
              <span className="text-muted-foreground w-3.5 shrink-0 text-center font-normal">
                =
              </span>
              {t("insights:networth.breakdown_table.net_worth")}
            </span>
            <span className="@min-[40rem]/breakdown:block hidden" />
            <span className={`${AMOUNT_CELL} font-bold`}>
              <CompactAmount value={data.netWorth} currency={currency} />
            </span>
            <ChangeCell change={netWorthChange} currency={currency} />
          </div>
        </div>
      </DashboardCard>
    </div>
  );
}
