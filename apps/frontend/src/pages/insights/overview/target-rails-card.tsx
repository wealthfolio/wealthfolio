import { useI18n } from "@/i18n/i18n-provider";
import { translateClassificationLabel } from "@/i18n/ui-text";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { cn } from "@/lib/utils";
import type { DriftReport, DriftRow, AllocationTarget } from "@/lib/types";
import { Button, Card, Icons, Skeleton } from "@wealthfolio/ui";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "@/pages/allocation-targets/components/allocation-target-colors";
import { formatTolerance } from "@/pages/allocation-targets/components/drift-copy";
import { resolveDriftReportCategories } from "@/pages/allocation-targets/components/drift-report-resolver";
import {
  formatDriftBps,
  hasVisibleAllocation,
  isOutOfBand,
  rebalanceMove,
} from "@/pages/allocation-targets/components/drift-row-utils";
import { formatCompact } from "./allocation-derivations";

interface TargetRailsCardProps {
  targets: AllocationTarget[];
  selectedTargetId: string | null;
  onTargetChange: (id: string) => void;
  driftReport: DriftReport | null;
  isLoading?: boolean;
  onCreateTarget?: () => void;
  /** Opens the full current-vs-target analysis. */
  onViewDetails?: () => void;
}

function driftClass(row: DriftRow): string {
  if (row.status === "overweight" || row.status === "not_targeted") return "text-destructive";
  if (row.status === "underweight") return "text-blue-600 dark:text-blue-400";
  return "text-muted-foreground";
}

export function TargetRailsCard({
  targets,
  selectedTargetId,
  onTargetChange,
  driftReport,
  isLoading,
  onCreateTarget,
  onViewDetails,
}: TargetRailsCardProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const { isBalanceHidden } = useBalancePrivacy();
  const selectedTarget = targets.find((target) => target.id === selectedTargetId) ?? null;
  const { data: taxonomy } = useTaxonomy(selectedTarget?.taxonomyId ?? null);
  const resolvedDriftReport = driftReport
    ? resolveDriftReportCategories(driftReport, taxonomy?.categories)
    : null;
  const colorByCategory = resolvedDriftReport
    ? buildAllocationTargetColorMap(resolvedDriftReport.rows)
    : undefined;

  if (isLoading) {
    return (
      <Card className="space-y-4 p-5 xl:h-full">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }

  const hasTarget = !!resolvedDriftReport;
  const currency = resolvedDriftReport?.baseCurrency ?? "USD";
  const rows = resolvedDriftReport?.rows.filter(hasVisibleAllocation) ?? [];

  const toleranceLabel = (() => {
    const requiredRows = rows.filter((r) => r.isRequired && r.targetBps > 0);
    if (!requiredRows.length) return formatTolerance(selectedTarget?.driftBandBps ?? 0);
    const bands = requiredRows.map((r) => r.effectiveBandBps);
    const minBand = Math.min(...bands);
    const maxBand = Math.max(...bands);
    if (minBand === maxBand) return formatTolerance(minBand);
    const fmt = (bps: number) => {
      const pp = bps / 100;
      return Number.isInteger(pp) ? pp.toFixed(0) : pp.toFixed(1);
    };
    return `±${fmt(minBand)}–${fmt(maxBand)}%`;
  })();
  const maxScale =
    Math.max(1, ...rows.flatMap((r) => [r.currentBps / 100, r.targetBps / 100])) * 1.08;
  const withinTolerance = resolvedDriftReport ? resolvedDriftReport.outOfBandCount === 0 : false;
  const largestGapRow = rows
    .filter(isOutOfBand)
    .sort((a, b) => Math.abs(b.driftBps) - Math.abs(a.driftBps))[0];
  const largestGapLabel = formatDriftBps(
    largestGapRow?.driftBps ?? resolvedDriftReport?.maxDriftBps ?? 0,
  );

  // Suggested rebalance moves for the out-of-range categories, largest first.
  const moves = rows
    .map((row, index) => ({
      row,
      color: allocationTargetColorForRow(row, colorByCategory, index),
    }))
    .filter(({ row }) => isOutOfBand(row))
    .sort((a, b) => Math.abs(b.row.valueDelta) - Math.abs(a.row.valueDelta));
  const money = (value: number) =>
    isBalanceHidden ? "••••" : formatCompact(Math.abs(value), currency, language);

  return (
    <Card className="flex flex-col gap-4 p-5 xl:h-full">
      {/* Header: title + Details (top-right) */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-muted-foreground text-[12px] font-semibold uppercase tracking-[0.18em]">
          {isChinese ? "目标配置" : "Target allocation"}
        </div>
        {hasTarget && onViewDetails && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 rounded-full px-3.5 text-xs"
            onClick={onViewDetails}
          >
            {isChinese ? "详情" : "Details"}
            <Icons.ArrowRight className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* Target selector — pill carousel */}
      {targets.length > 0 && (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {targets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onTargetChange(p.id)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
                p.id === selectedTargetId
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {hasTarget ? (
        <>
          {/* Rails */}
          <div className="flex flex-col">
            {rows.map((row, index) => {
              const cur = row.currentBps / 100;
              const tgt = row.targetBps / 100;
              const color = allocationTargetColorForRow(row, colorByCategory, index);
              const categoryName = translateClassificationLabel(language, row.categoryName);
              return (
                <div
                  key={row.categoryId}
                  className="grid grid-cols-[110px_1fr_62px] items-center gap-2.5 border-t py-3 first:border-t-0"
                >
                  <span className="flex items-center gap-2 overflow-hidden text-[12.5px] font-semibold">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: color }}
                    />
                    <span className="truncate">{categoryName}</span>
                  </span>
                  <span className="bg-muted relative h-2 rounded-full">
                    <span
                      className="absolute top-0 h-full rounded-full opacity-60"
                      style={{ width: `${(cur / maxScale) * 100}%`, background: color }}
                    />
                    <span
                      className="bg-foreground absolute -top-1 h-4 w-[2.5px] rounded-sm"
                      style={{ left: `calc(${(tgt / maxScale) * 100}% - 1px)` }}
                    />
                  </span>
                  <span
                    className={cn(
                      "text-right text-[11.5px] font-bold tabular-nums",
                      driftClass(row),
                    )}
                  >
                    {formatDriftBps(row.driftBps)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Suggested moves — fills the remaining height */}
          <div className="flex flex-col pt-5 xl:flex-1">
            <div className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-wider">
              {isChinese ? "建议调整" : "Suggested moves"}
            </div>
            {moves.length === 0 ? (
              <div className="text-muted-foreground flex flex-col items-center justify-center gap-1.5 py-4 text-center xl:flex-1">
                <Icons.CheckCircle className="text-success h-6 w-6" />
                <span className="text-[12px]">
                  {isChinese
                    ? "所有分类均在目标范围内，无需再平衡"
                    : "All categories inside target range — no rebalancing needed"}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {moves.slice(0, 6).map(({ row, color }) => {
                  const move = rebalanceMove(row);
                  const add = move.action === "Add";
                  const categoryName = translateClassificationLabel(language, row.categoryName);
                  return (
                    <div
                      key={row.categoryId}
                      className="flex items-center justify-between gap-2 text-[12px]"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-sm"
                          style={{ background: color }}
                        />
                        <span className="text-muted-foreground">
                          {language === "zh-CN" ? (add ? "加仓" : "减仓") : add ? "Add" : "Trim"}
                        </span>
                        <span className="text-foreground truncate font-medium">
                          {categoryName}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-bold tabular-nums",
                          add ? "text-success" : "text-destructive",
                        )}
                      >
                        {add ? "+" : "−"}
                        {money(move.amount)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Bottom status */}
          <div
            className={cn(
              "mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] font-semibold xl:mt-auto",
              withinTolerance
                ? "border-success/15 bg-success/[0.04] text-success"
                : "border-warning/15 bg-warning/[0.05] text-warning",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                withinTolerance ? "bg-success" : "bg-warning",
              )}
            />
            <span className="min-w-0 flex-1 truncate">
              {withinTolerance
                ? language === "zh-CN"
                  ? "在目标范围内"
                  : "Inside target range"
                : language === "zh-CN"
                  ? `${resolvedDriftReport?.outOfBandCount} 项超出范围 · 最大差距 ${largestGapLabel}`
                  : `${resolvedDriftReport?.outOfBandCount} outside range · largest gap ${largestGapLabel}`}
            </span>
            <span className="shrink-0 tabular-nums">
              {language === "zh-CN" ? `容差 ${toleranceLabel}` : `tolerance ${toleranceLabel}`}
            </span>
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-1 text-center">
          <div className="bg-muted/25 w-full rounded-xl border p-4">
            <div className="text-muted-foreground mb-4 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider">
              <span>{isChinese ? "当前" : "Current"}</span>
              <span>{isChinese ? "目标" : "Target"}</span>
            </div>
            <div className="space-y-3">
              {[
                { width: "72%", target: "64%", color: "bg-success/70" },
                { width: "46%", target: "58%", color: "bg-warning/70" },
                { width: "28%", target: "36%", color: "bg-primary/65" },
              ].map((row, index) => (
                <div key={index} className="grid grid-cols-[14px_1fr] items-center gap-2">
                  <span className={cn("h-2.5 w-2.5 rounded-sm", row.color)} />
                  <span className="bg-background relative h-2.5 overflow-visible rounded-full border">
                    <span
                      className={cn("absolute inset-y-0 left-0 rounded-full", row.color)}
                      style={{ width: row.width }}
                    />
                    <span
                      className="bg-foreground absolute -top-1 h-4 w-[2.5px] rounded-sm"
                      style={{ left: row.target }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <div className="bg-background mx-auto flex h-11 w-11 items-center justify-center rounded-full border shadow-sm">
              <Icons.Target className="text-muted-foreground h-5 w-5" />
            </div>
            <div>
              <h3 className="text-foreground text-[13px] font-semibold">
                {isChinese ? "尚未设置目标配置" : "No target allocation yet"}
              </h3>
              <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
                {isChinese
                  ? "对比当前权重与目标组合。"
                  : "Compare current weights with your intended portfolio."}
              </p>
            </div>
            {onCreateTarget && (
              <Button size="sm" className="gap-2 rounded-full px-4" onClick={onCreateTarget}>
                {isChinese ? "设置目标配置" : "Set target allocation"}
                <Icons.ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
