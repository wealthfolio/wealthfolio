import { DashboardCard } from "@/components/dashboard-card";
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
  seriesFor,
  type Change,
  type ParsedHistoryPoint,
  type ParsedNetWorth,
  type SelectedCategory,
} from "./utils";

// name | % | value | Δ. Fixed widths so columns line up across rows (each row is
// its own grid). On mobile the % column and the Δ-percent collapse.
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_4.5rem_5.75rem] md:grid-cols-[minmax(0,1fr)_3rem_7rem_9.5rem] items-center gap-x-3 md:gap-x-4";

function ChangeCell({ change, currency }: { change: Change; currency: string }) {
  const isZero = Math.abs(change.amount) < 0.005;
  const color = isZero
    ? "text-muted-foreground/60"
    : change.amount > 0
      ? "text-success"
      : "text-destructive";
  const sign = isZero ? "" : change.amount > 0 ? "+" : "-";
  return (
    <div className="flex items-baseline justify-end gap-1.5 md:gap-2">
      <span
        className={`inline-flex shrink-0 items-baseline whitespace-nowrap text-xs tabular-nums md:text-sm ${color}`}
      >
        {sign}
        <CompactAmount value={Math.abs(change.amount)} currency={currency} />
      </span>
      <span className="text-muted-foreground/60 hidden w-12 shrink-0 text-right text-sm tabular-nums md:block">
        {formatChangePercent(change.percent)}
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
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
        <span className="text-foreground truncate text-xs md:text-sm">{name}</span>
      </div>
      <span className="text-muted-foreground/70 hidden text-right text-sm tabular-nums md:block">
        {percentOfSection.toFixed(1)}%
      </span>
      <span className="text-foreground justify-self-end text-xs tabular-nums md:text-sm">
        {negative && value !== 0 ? "-" : ""}
        <CompactAmount value={value} currency={currency} />
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
    <DashboardCard
      title={t("insights:networth.breakdown")}
      meta={t("insights:networth.breakdown_table.change_over", { period: periodLabel })}
    >
      {/* Assets — collapsible */}
      <Collapsible open={assetsOpen} onOpenChange={setAssetsOpen}>
        <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
          <span className="flex items-center gap-1.5 text-sm font-semibold">
            <Icons.ChevronRight
              className={`text-muted-foreground h-3.5 w-3.5 transition-transform ${assetsOpen ? "rotate-90" : ""}`}
            />
            {t("insights:networth.breakdown_table.assets")}
          </span>
          <span className="text-success text-sm font-semibold tabular-nums">
            <CompactAmount value={data.assets.total} currency={currency} />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Composition — proportion of assets (the rows below are its legend) */}
          <div className="border-border/60 mb-1 mt-2.5 border-b pb-3">
            <CompositionBar data={data} />
          </div>

          {/* Column labels */}
          <div className={`${ROW_GRID} pt-2`}>
            <span className={CARD_LABEL}>{t("insights:networth.breakdown_table.category")}</span>
            <span className={`${CARD_LABEL} hidden text-right md:block`}>%</span>
            <span className={`${CARD_LABEL} justify-self-end`}>
              {t("insights:networth.breakdown_table.value")}
            </span>
            <span className={`${CARD_LABEL} justify-self-end`}>
              {t("insights:networth.breakdown_table.delta_period", { period: periodLabel })}
            </span>
          </div>

          <div className="divide-border/40 divide-y">
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
        <div className="my-3 flex items-center gap-1.5">
          <span className="text-muted-foreground w-3.5 shrink-0 text-center text-sm font-normal">
            −
          </span>
          <div className="border-border/60 flex-1 border-t" />
        </div>
      )}

      {/* Liabilities — collapsible */}
      {hasLiabilities && (
        <Collapsible open={liabilitiesOpen} onOpenChange={setLiabilitiesOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Icons.ChevronRight
                className={`text-muted-foreground h-3.5 w-3.5 transition-transform ${liabilitiesOpen ? "rotate-90" : ""}`}
              />
              {t("insights:networth.breakdown_table.liabilities")}
            </span>
            <span className="text-destructive text-sm font-semibold tabular-nums">
              -<CompactAmount value={data.liabilities.total} currency={currency} />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-border/40 divide-y pt-1">
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
                      data.liabilities.total > 0 ? (item.value / data.liabilities.total) * 100 : 0
                    }
                    change={deriveChange(series, true)}
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
        <span className="flex items-center gap-1.5 text-sm font-bold">
          <span className="text-muted-foreground w-3.5 shrink-0 text-center font-normal">=</span>
          {t("insights:networth.breakdown_table.net_worth")}
        </span>
        <span className="hidden md:block" />
        <span className="justify-self-end text-sm font-bold tabular-nums">
          <CompactAmount value={data.netWorth} currency={currency} />
        </span>
        <ChangeCell change={netWorthChange} currency={currency} />
      </div>
    </DashboardCard>
  );
}
