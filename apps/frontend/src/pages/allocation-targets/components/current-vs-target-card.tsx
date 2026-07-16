import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { DriftReport, DriftRow } from "@/lib/types";
import { AllocationDonut } from "./allocation-donut";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";
import { formatPp } from "./drift-copy";
import { hasVisibleAllocation } from "./drift-row-utils";

interface CurrentVsTargetCardProps {
  report: DriftReport;
  taxonomyLabel: string;
  targetLabel: string;
}

function driftColor(row: DriftRow): string {
  if (row.status === "in_band") return "text-muted-foreground";
  if (row.status === "overweight" || row.status === "not_targeted") return "text-destructive";
  return "text-blue-600 dark:text-blue-400";
}

function formatTargetBps(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1);
}

export function CurrentVsTargetCard({
  report,
  taxonomyLabel,
  targetLabel,
}: CurrentVsTargetCardProps) {
  const { t } = useTranslation();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const visibleRows = report.rows.filter(hasVisibleAllocation);
  const colorByCategory = useMemo(() => buildAllocationTargetColorMap(report.rows), [report.rows]);
  const maxScale =
    Math.max(1, ...visibleRows.flatMap((r) => [r.currentBps / 100, r.targetBps / 100])) * 1.08;

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("allocation:vsTarget.title")}</CardTitle>
        <CardDescription>
          {t("allocation:vsTarget.description", { taxonomyLabel, targetLabel })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid items-center gap-6 pt-3 xl:grid-cols-[280px_minmax(0,1fr)] xl:pt-5">
          <div className="mx-auto shrink-0">
            <AllocationDonut
              rows={visibleRows}
              colorByCategory={colorByCategory}
              totalValue={report.totalValue}
              currency={report.baseCurrency}
              size={260}
              hoveredId={hoveredId}
              onHoverChange={setHoveredId}
            />
          </div>

          <div className="min-w-0">
            {/* Column headers */}
            <div className="text-muted-foreground hidden grid-cols-[minmax(7.5rem,1fr)_minmax(10rem,1.25fr)_3.5rem_3.5rem_5rem] gap-x-3 px-2 pb-2 text-[10px] font-medium uppercase tracking-wider md:grid">
              <span>{t("allocation:vsTarget.category")}</span>
              <span>{t("allocation:vsTarget.currentAllocation")}</span>
              <span className="text-right">{t("allocation:vsTarget.current")}</span>
              <span className="text-right">{t("allocation:vsTarget.target")}</span>
              <span className="text-right">{t("allocation:vsTarget.drift")}</span>
            </div>

            {/* Asset class rows */}
            <div className="overflow-hidden">
              {visibleRows.flatMap((row, i) => {
                const isHovered = hoveredId === row.categoryId;
                const rowColor = allocationTargetColorForRow(row, colorByCategory, i);
                const current = row.currentBps / 100;
                const target = row.targetBps / 100;
                const rowEl = (
                  <div
                    key={row.categoryId}
                    className="grid cursor-default grid-cols-[minmax(0,1fr)_5.25rem] items-center gap-x-3 gap-y-2 rounded-sm px-2 py-3 transition-colors md:grid-cols-[minmax(7.5rem,1fr)_minmax(10rem,1.25fr)_3.5rem_3.5rem_5rem]"
                    style={{ backgroundColor: isHovered ? `${rowColor}22` : undefined }}
                    onMouseEnter={() => setHoveredId(row.categoryId)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ background: rowColor }}
                      />
                      <span className="text-foreground truncate text-[12.5px] font-semibold">
                        {row.categoryName}
                      </span>
                    </div>

                    <div className="col-span-2 h-2 md:col-span-1 md:col-start-2 md:row-start-1">
                      <div className="bg-muted relative h-2 rounded-full">
                        <span
                          className="absolute top-0 h-full rounded-full opacity-60"
                          style={{
                            width: `${(current / maxScale) * 100}%`,
                            background: rowColor,
                          }}
                        />
                        <span
                          className="bg-foreground absolute -top-1 h-4 w-[2.5px] rounded-sm"
                          style={{ left: `calc(${(target / maxScale) * 100}% - 1px)` }}
                        />
                      </div>
                    </div>

                    <span className="text-foreground hidden text-right text-[12px] font-semibold tabular-nums md:block">
                      {current.toFixed(1)}%
                    </span>
                    <span className="text-muted-foreground hidden text-right text-[12px] font-medium tabular-nums md:block">
                      {formatTargetBps(row.targetBps)}%
                    </span>
                    <span
                      className={cn(
                        "col-start-2 row-start-1 text-right text-[12px] font-semibold tabular-nums md:col-start-auto md:row-start-auto",
                        driftColor(row),
                      )}
                    >
                      {formatPp(row.driftBps)}
                    </span>

                    <div className="text-muted-foreground col-span-2 flex justify-between text-[11px] tabular-nums md:hidden">
                      <span>
                        {t("allocation:vsTarget.current")}{" "}
                        <span className="text-foreground">{current.toFixed(1)}%</span>
                      </span>
                      <span>
                        {t("allocation:vsTarget.target")}{" "}
                        <span className="text-foreground">{formatTargetBps(row.targetBps)}%</span>
                      </span>
                    </div>
                  </div>
                );
                return i < visibleRows.length - 1
                  ? [rowEl, <div key={`sep-${i}`} className="bg-border/60 h-px shrink-0" />]
                  : [rowEl];
              })}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
