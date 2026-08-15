import React from "react";
import { formatPercent, GainPercent } from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { YearComparisonData, MonthlyViewMode } from "../../monthly-performance-utils";

const MONTH_HEADERS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface MonthlyPerformanceTableProps {
  data: YearComparisonData[];
  selectedYear: number;
  onSelectYear: (year: number) => void;
  viewMode: MonthlyViewMode;
}

export const MonthlyPerformanceTable: React.FC<MonthlyPerformanceTableProps> = ({
  data,
  selectedYear,
  onSelectYear,
  viewMode,
}) => {
  const { t } = useTranslation();

  if (!data.length) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        {t("performance:monthly.no_data")}
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[640px] space-y-1 py-1 font-mono text-xs">
        {/* Table Header */}
        <div className="text-muted-foreground/70 grid grid-cols-[3.5rem_repeat(12,1fr)_4.5rem] items-center px-3 py-1.5 text-center text-[11px] font-medium">
          <div className="text-left font-semibold">{t("performance:time_period")}</div>
          {MONTH_HEADERS.map((m) => (
            <div key={m}>{m}</div>
          ))}
          <div className="text-right font-semibold">{t("performance:monthly.year_total")}</div>
        </div>

        {/* Year Rows */}
        <div className="space-y-1">
          {data.map((row) => {
            const isSelected = row.year === selectedYear;

            // Compute year total return based on viewMode
            let yearTotalValue: number | null = null;
            if (viewMode === "benchmark") {
              yearTotalValue = row.benchmarkYearTotal;
            } else if (viewMode === "relative") {
              yearTotalValue = row.relativeYearTotal;
            } else {
              yearTotalValue = row.portfolioYearTotal;
            }

            return (
              <div
                key={row.year}
                role="button"
                tabIndex={0}
                onClick={() => onSelectYear(row.year)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectYear(row.year);
                  }
                }}
                className={cn(
                  "grid cursor-pointer grid-cols-[3.5rem_repeat(12,1fr)_4.5rem] items-center rounded-lg px-3 py-2 text-center transition-all",
                  isSelected
                    ? "bg-primary/15 border-primary/40 border font-semibold shadow-sm dark:border-emerald-500/40 dark:bg-emerald-950/40"
                    : "hover:bg-muted/40 text-muted-foreground border border-transparent",
                )}
              >
                {/* Year Header */}
                <div
                  className={cn(
                    "text-left font-semibold",
                    isSelected ? "text-primary dark:text-emerald-400" : "text-foreground",
                  )}
                >
                  {row.year}
                </div>

                {/* 12 Month Cells */}
                {row.months.map((cell, monthIdx) => {
                  if (!cell) {
                    return (
                      <div key={monthIdx} className="text-muted-foreground/30">
                        -
                      </div>
                    );
                  }

                  let val: number | null = null;
                  if (viewMode === "benchmark") {
                    val = cell.benchmarkReturn;
                  } else if (viewMode === "relative") {
                    val = cell.relativeReturn;
                  } else {
                    val = cell.portfolioReturn;
                  }

                  if (val === null) {
                    return (
                      <div key={monthIdx} className="text-muted-foreground/30">
                        -
                      </div>
                    );
                  }

                  const isPositive = val >= 0;

                  return (
                    <div
                      key={monthIdx}
                      className={cn(
                        "text-[11px] font-medium tracking-tight",
                        isPositive ? "text-gain" : "text-loss",
                      )}
                    >
                      {formatPercent(val)}
                    </div>
                  );
                })}

                {/* Year Total / YTD */}
                <div className="text-right text-[11px] font-bold">
                  {yearTotalValue !== null ? (
                    <GainPercent value={yearTotalValue} />
                  ) : (
                    <span className="text-muted-foreground/30">-</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
