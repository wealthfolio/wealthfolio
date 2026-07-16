import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Card, CardContent, formatPrice, Icons, Skeleton } from "@wealthfolio/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { cn, formatAmount } from "@/lib/utils";
import { toast } from "sonner";
import type {
  AccountScope,
  DriftReport,
  RebalancePlan,
  RebalanceWarning,
  ScenarioMode,
  SuggestedManualTrade,
  AllocationTarget,
} from "@/lib/types";
import {
  allocationTargetColorForRow,
  buildAllocationTargetColorMap,
} from "./allocation-target-colors";
import { accountScopeKey } from "./target-scope";
import { useRebalancePlan } from "../hooks/use-rebalance";

// Drift direction colors — clay for overweight (+), slate-blue for underweight (−).
const DRIFT_OVER = "#b4664a";
const DRIFT_UNDER = "#4f6d99";
const FOREST = "#355c4c";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBps(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

function pp1(bps: number) {
  return (bps / 100).toFixed(1);
}

function ppSigned(bps: number) {
  const v = bps / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
}

function currencySymbol(code: string): string {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: "currency", currency: code })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? code
    );
  } catch {
    return code;
  }
}

function currencyFractionDigits(code: string): number {
  try {
    return (
      new Intl.NumberFormat(undefined, { style: "currency", currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function roundedCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return Math.round(amount).toLocaleString();
  }
}

function cashInputLimit(availableCash: number, currency: string): number {
  const factor = 10 ** currencyFractionDigits(currency);
  return Math.round((availableCash + Number.EPSILON) * factor) / factor;
}

function cashValueFromAvailable(availableCash: number, currency: string): string {
  const amount = cashInputLimit(availableCash, currency);
  return amount > 0 ? amount.toFixed(currencyFractionDigits(currency)) : "";
}

function parseCashValue(value: string): number {
  return parseFloat(value.replace(/,/g, "")) || 0;
}

/** Round drift-bar scale up to a clean ceiling, always covering the tolerance range. */
function driftScaleMaxBps(maxDriftBps: number, toleranceMaxBps: number): number {
  const ceiling = Math.ceil(Math.max(maxDriftBps, toleranceMaxBps * 1.4, 100) / 500) * 500;
  return Math.max(ceiling, 500);
}

interface DriftToleranceRange {
  minBps: number;
  maxBps: number;
  label: string;
}

function formatTolerancePct(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1);
}

function driftToleranceRange(
  profile: AllocationTarget,
  driftReport: DriftReport | null,
  t: TFunction,
): DriftToleranceRange {
  const bands =
    driftReport?.rows
      .filter((row) => row.isRequired && row.targetBps > 0)
      .map((row) => row.effectiveBandBps) ?? [];

  if (bands.length === 0) {
    const bps = profile.driftBandBps;
    return {
      minBps: bps,
      maxBps: bps,
      label: t("allocation:tolerance.single", { value: formatTolerancePct(bps) }),
    };
  }

  const minBps = Math.min(...bands);
  const maxBps = Math.max(...bands);
  const label =
    minBps === maxBps
      ? t("allocation:tolerance.single", { value: formatTolerancePct(maxBps) })
      : t("allocation:tolerance.range", {
          min: formatTolerancePct(minBps),
          max: formatTolerancePct(maxBps),
        });

  return { minBps, maxBps, label };
}

interface SleeveSummaryRow {
  categoryId: string;
  categoryName: string;
  color: string;
  currentBps: number;
  targetBps: number;
  afterBps: number;
  afterDriftBps: number;
}

function computeSleeveSummary(driftReport: DriftReport, plan: RebalancePlan): SleeveSummaryRow[] {
  const colorMap = buildAllocationTargetColorMap(driftReport.rows);
  return driftReport.rows
    .map((row, i) => {
      const afterBps = plan.afterBpsByCategory[row.categoryId] ?? row.currentBps;
      return {
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        color: allocationTargetColorForRow(row, colorMap, i),
        currentBps: row.currentBps,
        targetBps: row.targetBps,
        afterBps,
        afterDriftBps: afterBps - row.targetBps,
      };
    })
    .filter((s) => s.currentBps > 0 || s.targetBps > 0 || s.afterBps > 0);
}

/** "Cash sits 42% over a 0% target." — describes the largest current drift driver. */
function driftDriverSentence(driftReport: DriftReport, t: TFunction): string | null {
  let top: { name: string; drift: number; cur: number; tgt: number } | null = null;
  for (const r of driftReport.rows) {
    if (r.status === "not_targeted" && r.currentBps === 0) continue;
    const drift = r.currentBps - r.targetBps;
    if (!top || Math.abs(drift) > Math.abs(top.drift)) {
      top = { name: r.categoryName, drift, cur: r.currentBps, tgt: r.targetBps };
    }
  }
  if (!top) return null;
  return t(
    top.drift >= 0
      ? "allocation:planner.driverSentenceOver"
      : "allocation:planner.driverSentenceUnder",
    {
      name: top.name,
      current: (top.cur / 100).toFixed(0),
      target: (top.tgt / 100).toFixed(0),
    },
  );
}

function modeVerb(mode: ScenarioMode, t: TFunction): string {
  if (mode === "sell_to_rebalance") return t("allocation:planner.modeVerbSells");
  if (mode === "hybrid") return t("allocation:planner.modeVerbHybrid");
  return t("allocation:planner.modeVerbCashFlow");
}

/** Narrative for the Now · After · Target card. */
function reshapeNarrative(sleeves: SleeveSummaryRow[], mode: ScenarioMode, t: TFunction): string {
  const movers = sleeves.map((s) => ({
    name: s.categoryName,
    before: s.currentBps - s.targetBps,
    after: s.afterDriftBps,
    lifted: s.afterBps - s.currentBps,
  }));
  const lifted = movers.filter((m) => m.lifted > 1).sort((a, b) => b.lifted - a.lifted)[0];
  const shrank = movers
    .filter((m) => m.before > 50 && m.after < m.before - 1)
    .sort((a, b) => b.before - b.after - (a.before - a.after))[0];
  const under = movers.filter((m) => m.after < -50).sort((a, b) => a.after - b.after)[0];

  const parts: string[] = [];
  const verb = modeVerb(mode, t);
  if (lifted && shrank) {
    parts.push(
      t("allocation:narrative.liftAndShrink", {
        verb,
        lifted: lifted.name,
        shrank: shrank.name,
        before: ppSigned(shrank.before),
        after: ppSigned(shrank.after),
      }),
    );
  } else if (lifted) {
    parts.push(t("allocation:narrative.lift", { verb, lifted: lifted.name }));
  } else if (shrank) {
    parts.push(
      t("allocation:narrative.shrink", {
        verb,
        shrank: shrank.name,
        before: ppSigned(shrank.before),
        after: ppSigned(shrank.after),
      }),
    );
  }
  if (under && under.name !== shrank?.name) {
    parts.push(t("allocation:narrative.staysUnderweight", { name: under.name }));
  }
  return parts.join(" ");
}

function planCashTotals(plan: RebalancePlan) {
  const buyTotal = plan.cashUsed;
  const sellProceeds = plan.trades
    .filter((t) => t.action === "sell")
    .reduce((sum, trade) => sum + trade.estimatedAmount, 0);
  return {
    buyTotal,
    sellProceeds,
    newCashUsed: Math.max(buyTotal - sellProceeds, 0),
    hasSells: sellProceeds > 0,
  };
}

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function exportCsv(plan: RebalancePlan, currency: string, profileName: string, t: TFunction) {
  const generated = new Date().toISOString().slice(0, 10);
  const fractionDigits = currencyFractionDigits(currency);
  const cashTotals = planCashTotals(plan);
  const cashRows = cashTotals.hasSells
    ? [
        [t("allocation:csv.buyTotal"), cashTotals.buyTotal.toFixed(fractionDigits)],
        [t("allocation:csv.sellProceeds"), cashTotals.sellProceeds.toFixed(fractionDigits)],
        [t("allocation:csv.newCashUsed"), cashTotals.newCashUsed.toFixed(fractionDigits)],
        [t("allocation:csv.cashRemaining"), plan.cashRemaining.toFixed(fractionDigits)],
        [t("allocation:csv.cashAvailable"), plan.availableCash.toFixed(fractionDigits)],
      ]
    : [
        [t("allocation:csv.cashDeployed"), plan.cashUsed.toFixed(fractionDigits)],
        [t("allocation:csv.cashRemaining"), plan.cashRemaining.toFixed(fractionDigits)],
        [t("allocation:csv.cashAvailable"), plan.availableCash.toFixed(fractionDigits)],
      ];

  const meta = [
    [t("allocation:csv.generated"), generated],
    [t("allocation:csv.profile"), profileName],
    [t("allocation:csv.currency"), currency],
    ...cashRows,
    [t("allocation:csv.maxDriftBefore"), fmtBps(plan.maxDriftBpsBefore)],
    [t("allocation:csv.maxDriftAfter"), fmtBps(plan.maxDriftBpsAfter)],
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  const header = [
    t("allocation:csv.action"),
    t("allocation:csv.symbol"),
    t("allocation:csv.name"),
    t("allocation:csv.category"),
    t("allocation:csv.account"),
    t("allocation:csv.holdingId"),
    t("allocation:csv.amount", { currency }),
    t("allocation:csv.shares"),
    t("allocation:csv.lastPrice", { currency }),
    t("allocation:csv.reason"),
  ]
    .map(csvCell)
    .join(",");

  const rows = plan.trades.map((t) =>
    [
      t.action,
      t.symbol ?? "",
      t.name ?? "",
      t.categoryName,
      t.accountId ?? "",
      t.holdingId ?? "",
      t.estimatedAmount.toFixed(fractionDigits),
      t.quantity != null ? t.quantity.toFixed(t.quantity % 1 === 0 ? 0 : 4) : "",
      t.estimatedPrice != null ? String(t.estimatedPrice) : "",
      t.reason,
    ]
      .map(csvCell)
      .join(","),
  );

  const csv = [meta, "", header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rebalance-plan-${profileName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${generated}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function copyToText(plan: RebalancePlan, currency: string, t: TFunction) {
  const cashTotals = planCashTotals(plan);
  const lines = [
    t("allocation:copyText.header", { date: new Date().toLocaleDateString() }),
    cashTotals.hasSells
      ? t("allocation:copyText.newCashUsed", {
          used: formatAmount(cashTotals.newCashUsed, currency),
          buyTotal: formatAmount(cashTotals.buyTotal, currency),
          sellProceeds: formatAmount(cashTotals.sellProceeds, currency),
          cashRemaining: formatAmount(plan.cashRemaining, currency),
        })
      : t("allocation:copyText.cashDeployed", {
          used: formatAmount(plan.cashUsed, currency),
          available: formatAmount(plan.availableCash, currency),
        }),
    t("allocation:copyText.maxDrift", {
      before: fmtBps(plan.maxDriftBpsBefore),
      after: fmtBps(plan.maxDriftBpsAfter),
    }),
    "",
    t("allocation:copyText.proposedTrades"),
    ...plan.trades.map(
      (trade) =>
        `${trade.action.toUpperCase()}  ${trade.symbol ?? trade.categoryName}  ${formatAmount(trade.estimatedAmount, currency)}` +
        (trade.accountId
          ? `  ${t("allocation:copyText.account", { account: trade.accountId })}`
          : "") +
        (trade.quantity != null
          ? `  ${t("allocation:copyText.shares", { qty: trade.quantity.toFixed(trade.quantity % 1 === 0 ? 0 : 4) })}`
          : "") +
        (trade.estimatedPrice != null ? ` @ ${formatPrice(trade.estimatedPrice, currency)}` : ""),
    ),
  ];
  if (plan.warnings.length) {
    lines.push("", t("allocation:copyText.warnings", { count: plan.warnings.length }));
    plan.warnings.forEach((w) => lines.push(`  · ${w.message}`));
  }
  void navigator.clipboard.writeText(lines.join("\n"));
}

// ── Eyebrow label ─────────────────────────────────────────────────────────────

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-muted-foreground font-mono text-xs uppercase tracking-[0.14em]",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Mode switcher ─────────────────────────────────────────────────────────────

function ModeSwitch({
  currency,
  allowSells,
  value,
  onChange,
}: {
  currency: string;
  allowSells: boolean;
  value: ScenarioMode;
  onChange: (mode: ScenarioMode) => void;
}) {
  const { t } = useTranslation();
  const modes: { id: ScenarioMode; label: string; shortLabel: string; hint: string }[] = [
    {
      id: "cash_flow_only",
      label: t("allocation:mode.cashFlowOnly"),
      shortLabel: t("allocation:mode.cashFlowShort"),
      hint: t("allocation:mode.cashFlowHint", { symbol: currencySymbol(currency) }),
    },
    {
      id: "sell_to_rebalance",
      label: t("allocation:mode.sellToRebalance"),
      shortLabel: t("allocation:mode.sellShort"),
      hint: t("allocation:mode.sellHint"),
    },
    {
      id: "hybrid",
      label: t("allocation:mode.hybrid"),
      shortLabel: t("allocation:mode.hybridShort"),
      hint: t("allocation:mode.hybridHint"),
    },
  ];

  return (
    <div className="border-border/60 bg-card/40 grid w-full max-w-full grid-cols-3 gap-1 rounded-2xl border p-1 backdrop-blur-xl sm:inline-flex sm:w-auto sm:grid-cols-none">
      {modes.map((m) => {
        const disabled = !allowSells && m.id !== "cash_flow_only";
        const active = value === m.id;
        const button = (
          <button
            key={m.id}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onChange(m.id)}
            className={cn(
              "group inline-flex min-w-0 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 py-3 font-mono text-xs transition-colors sm:w-auto sm:px-4",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            <span className="min-w-0 truncate font-medium sm:hidden">{m.shortLabel}</span>
            <span className="hidden font-medium sm:inline">{m.label}</span>
            <span className={cn("hidden sm:inline", active ? "text-background/65" : "opacity-70")}>
              {m.hint}
            </span>
          </button>
        );

        if (!disabled) return button;

        return (
          <Tooltip key={m.id}>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 cursor-not-allowed">{button}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {t("allocation:mode.enableSellsTip")}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── Cash deploy controls (left panel) ─────────────────────────────────────────

function PlannerInput({
  description,
  cashValue,
  availableCash,
  currency,
  onCashChange,
  onCalculate,
  hasPlan,
  isCalculating,
  isSourceLoading,
}: {
  description: string;
  cashValue: string;
  availableCash: number;
  currency: string;
  onCashChange: (v: string) => void;
  onCalculate: () => void;
  hasPlan: boolean;
  isCalculating: boolean;
  isSourceLoading: boolean;
}) {
  const { t } = useTranslation();
  const limit = cashInputLimit(availableCash, currency);
  const deploy = parseCashValue(cashValue);
  const overBudget = deploy > limit;
  const pct = limit > 0 ? Math.min(100, Math.max(0, (deploy / limit) * 100)) : 0;
  const fraction = currencyFractionDigits(currency);

  const presets: { id: string; label: string; value: number }[] = [
    { id: "25", label: "25%", value: limit * 0.25 },
    { id: "50", label: "50%", value: limit * 0.5 },
    { id: "75", label: "75%", value: limit * 0.75 },
    { id: "all", label: t("allocation:planner.all"), value: limit },
  ];
  const activePreset = presets.find((p) => Math.abs(p.value - deploy) <= 0.5 + limit * 0.001)?.id;

  const canCalculate = !isCalculating && !isSourceLoading && limit > 0 && deploy > 0 && !overBudget;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <Eyebrow>{t("allocation:planner.cashToDeploy")}</Eyebrow>
        <span className="text-muted-foreground font-mono text-[11px] sm:text-xs">
          {t("allocation:planner.ofInScope", { amount: roundedCurrency(availableCash, currency) })}
        </span>
      </div>

      <div
        className={cn(
          "mt-1 flex items-center font-mono",
          overBudget ? "text-destructive" : "text-foreground",
        )}
      >
        <span className="text-muted-foreground mr-0.5 text-sm font-normal">
          {currencySymbol(currency)}
        </span>
        <input
          value={cashValue}
          onChange={(e) => onCashChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && canCalculate && onCalculate()}
          disabled={isSourceLoading || limit <= 0}
          inputMode="decimal"
          placeholder="0"
          className="placeholder:text-muted-foreground/50 w-full min-w-0 bg-transparent text-2xl font-semibold tabular-nums tracking-tight outline-none disabled:cursor-not-allowed"
        />
      </div>

      <input
        type="range"
        min={0}
        max={limit || 1}
        step={limit > 0 ? Math.max(limit / 1000, 10 ** -fraction) : 1}
        value={Math.min(deploy, limit)}
        onChange={(e) => onCashChange(parseFloat(e.target.value).toFixed(fraction))}
        disabled={isSourceLoading || limit <= 0}
        className="lever-slider mt-2.5 block w-full disabled:cursor-not-allowed disabled:opacity-50"
        style={{ ["--lever-pct" as string]: `${pct}%` }}
      />

      <div className="mt-2.5 grid grid-cols-4 gap-2 sm:flex sm:items-center sm:gap-1.5">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={limit <= 0}
            onClick={() => onCashChange(p.value.toFixed(fraction))}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-center font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto",
              activePreset === p.id
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <p className="text-foreground/80 mt-3 font-mono text-xs leading-relaxed sm:mt-4">
        {description}
      </p>

      {overBudget && (
        <p className="text-destructive mt-2 font-mono text-xs">
          {t("allocation:planner.exceedsAvailableCash")}
        </p>
      )}

      <div className="mt-auto pt-4 sm:pt-5">
        <Button
          onClick={onCalculate}
          disabled={!canCalculate}
          variant={hasPlan ? "outline" : "default"}
          size="sm"
          className="font-mono"
        >
          {hasPlan ? (
            <Icons.RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          ) : (
            <Icons.BarChart className="mr-1.5 h-3.5 w-3.5" />
          )}
          {isCalculating
            ? t("allocation:planner.calculating")
            : isSourceLoading
              ? t("allocation:planner.loading")
              : hasPlan
                ? t("allocation:planner.recalculate")
                : t("allocation:planner.calculatePlan")}
        </Button>
      </div>
    </div>
  );
}

// ── Drift bar ─────────────────────────────────────────────────────────────────

function DriftBar({
  beforeBps,
  afterBps,
  tolerance,
  scaleMaxBps,
}: {
  beforeBps: number;
  afterBps: number | null;
  tolerance: DriftToleranceRange;
  scaleMaxBps: number;
}) {
  const { t } = useTranslation();
  const clamp = (bps: number) => Math.min(100, Math.max(0, (bps / scaleMaxBps) * 100));
  const beforePos = clamp(beforeBps);
  const afterPos = afterBps != null ? clamp(afterBps) : 0;
  const toleranceMinPos = clamp(tolerance.minBps);
  const toleranceMaxPos = clamp(tolerance.maxBps);
  const isAfter = afterBps != null;
  const primaryLabel = driftLabelPlacement(isAfter ? afterPos : beforePos);
  const beforeLabel = driftLabelPlacement(beforePos);

  return (
    <div>
      <div className="dark:bg-muted relative h-3 w-full overflow-hidden rounded-full bg-[#e7e3d4]">
        {isAfter ? (
          <>
            {/* removed drift: hatched zone from after → before */}
            <div
              className="absolute inset-y-0 rounded-full"
              style={{
                left: `${afterPos}%`,
                width: `${Math.max(beforePos - afterPos, 0)}%`,
                backgroundImage:
                  "repeating-linear-gradient(45deg, rgba(53,92,76,0.22) 0 5px, transparent 5px 10px)",
              }}
            />
            {/* projected drift fill: 0 → after */}
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${afterPos}%`, background: FOREST }}
            />
          </>
        ) : (
          <>
            {/* tolerance band: solid to the tightest sleeve, soft to the widest sleeve */}
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${toleranceMinPos}%`, background: "#9db8a8" }}
            />
            {toleranceMaxPos > toleranceMinPos && (
              <div
                className="absolute inset-y-0 rounded-full opacity-45"
                style={{
                  left: `${toleranceMinPos}%`,
                  width: `${toleranceMaxPos - toleranceMinPos}%`,
                  background: "#9db8a8",
                }}
              />
            )}
          </>
        )}
        {/* NOW / AFTER marker */}
        <div
          className="bg-foreground absolute inset-y-0 w-[2px]"
          style={{ left: `calc(${isAfter ? afterPos : beforePos}% - 1px)` }}
        />
      </div>

      {/* marker labels */}
      <div className="relative mt-1.5 h-7">
        <div
          className={cn("absolute flex flex-col", primaryLabel.className)}
          style={primaryLabel.style}
        >
          <span className="text-foreground font-mono text-xs font-semibold tabular-nums leading-none">
            {isAfter ? pp1(afterBps) : fmtBps(beforeBps)}
          </span>
          <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">
            {isAfter ? t("allocation:driftBar.after") : t("allocation:driftBar.now")}
          </span>
        </div>
        {isAfter && (
          <div
            className={cn("absolute flex flex-col", beforeLabel.className)}
            style={beforeLabel.style}
          >
            <span className="text-muted-foreground font-mono text-xs tabular-nums leading-none">
              {pp1(beforeBps)}
            </span>
            <span className="text-muted-foreground font-mono text-xs uppercase tracking-wider">
              {t("allocation:driftBar.before")}
            </span>
          </div>
        )}
      </div>

      {/* scale */}
      <div className="text-muted-foreground mt-1 flex justify-between font-mono text-xs tabular-nums">
        <span>0%</span>
        <span>{tolerance.label}</span>
        <span>{(scaleMaxBps / 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}

function driftLabelPlacement(pos: number): { className: string; style: CSSProperties } {
  if (pos >= 88) return { className: "items-end text-right", style: { right: 0 } };
  if (pos <= 12) return { className: "items-start text-left", style: { left: 0 } };
  return {
    className: "items-center text-center",
    style: { left: `${pos}%`, transform: "translateX(-50%)" },
  };
}

// ── Planner result column (right panel) ───────────────────────────────────────

function PlannerResult({
  driftReport,
  plan,
  currency,
  tolerance,
  scaleMaxBps,
  onReview,
}: {
  driftReport: DriftReport;
  plan: RebalancePlan | null;
  currency: string;
  tolerance: DriftToleranceRange;
  scaleMaxBps: number;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  if (!plan) {
    // ── Before Calculate ──
    const driver = driftDriverSentence(driftReport, t);
    return (
      <div className="flex h-full flex-col">
        <Eyebrow>{t("allocation:result.currentMaxDrift")}</Eyebrow>
        <div className="text-muted-foreground mt-0.5 font-mono text-2xl font-semibold tabular-nums leading-none">
          {fmtBps(driftReport.maxDriftBps)}
        </div>
        {driver && <p className="text-muted-foreground mt-1.5 font-mono text-xs">{driver}</p>}

        <div className="mt-4">
          <DriftBar
            beforeBps={driftReport.maxDriftBps}
            afterBps={null}
            tolerance={tolerance}
            scaleMaxBps={scaleMaxBps}
          />
        </div>

        <div className="border-border/70 mt-4 grid grid-cols-3 gap-4 border-t pt-3">
          {[
            { key: "trades", label: t("allocation:result.trades") },
            { key: "impact", label: t("allocation:result.impact") },
            { key: "driftAfter", label: t("allocation:result.driftAfter") },
          ].map(({ key, label }) => (
            <div key={key}>
              <Eyebrow>{label}</Eyebrow>
              <div className="text-muted-foreground mt-1 font-mono text-sm">—</div>
            </div>
          ))}
        </div>

        <p className="text-muted-foreground mt-auto pt-4 font-mono text-xs">
          {t("allocation:result.setInputsHint")}
        </p>
      </div>
    );
  }

  // ── After Calculate ──
  const cashTotals = planCashTotals(plan);
  const buys = plan.trades.filter((trade) => trade.action === "buy").length;
  const sells = plan.trades.filter((trade) => trade.action === "sell").length;
  const buysWord = t("allocation:result.buysCount", { count: buys });
  const sellsWord = t("allocation:result.sellsCount", { count: sells });
  const tradeSub = `${buysWord} · ${sellsWord}`;
  const deployed = sells > 0 ? cashTotals.newCashUsed : plan.cashUsed;
  const scopePct =
    plan.availableCash > 0 ? Math.round((plan.cashUsed / plan.availableCash) * 100) : 0;
  const improvedBps = plan.maxDriftBpsBefore - plan.maxDriftBpsAfter;
  const improved = improvedBps > 0;

  const tradesWord = t("allocation:result.tradesCount", { count: plan.trades.length });
  const tradesActionSummary =
    sells > 0
      ? t("allocation:result.buysAndSells", { buys: buysWord, sells: sellsWord })
      : buysWord;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <Eyebrow>{t("allocation:result.projectedMaxDrift")}</Eyebrow>
        {improvedBps !== 0 && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs font-medium",
              improved
                ? "bg-[#dfe9df] text-[#2f6b46] dark:bg-emerald-950/40 dark:text-emerald-400"
                : "bg-[#f0e0da] text-[#b4664a] dark:bg-red-950/40 dark:text-red-400",
            )}
          >
            {improved ? "↓" : "↑"} {Math.abs(improvedBps / 100).toFixed(1)}%
          </span>
        )}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-2xl font-semibold tabular-nums leading-none",
          improved ? "text-[#2f6b46] dark:text-emerald-400" : "text-foreground",
        )}
      >
        {fmtBps(plan.maxDriftBpsAfter)}
      </div>

      <div className="mt-4">
        <DriftBar
          beforeBps={plan.maxDriftBpsBefore}
          afterBps={plan.maxDriftBpsAfter}
          tolerance={tolerance}
          scaleMaxBps={scaleMaxBps}
        />
      </div>

      <div className="border-border/70 mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 sm:grid-cols-3 sm:gap-4">
        <div>
          <Eyebrow>{t("allocation:result.trades")}</Eyebrow>
          <div className="text-foreground mt-1 font-mono text-sm font-semibold tabular-nums leading-none sm:text-base">
            {plan.trades.length}
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-xs">{tradeSub}</div>
        </div>
        <div>
          <Eyebrow>
            <span className="sm:hidden">{t("allocation:result.deployedShort")}</span>
            <span className="hidden sm:inline">{t("allocation:result.cashDeployed")}</span>
          </Eyebrow>
          <div className="text-foreground mt-1 font-mono text-sm font-semibold tabular-nums leading-none sm:text-base">
            {roundedCurrency(deployed, currency)}
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-xs">
            {t("allocation:result.percentOfScope", { pct: scopePct })}
          </div>
        </div>
        <div>
          <Eyebrow>
            <span className="sm:hidden">{t("allocation:result.remainingShort")}</span>
            <span className="hidden sm:inline">{t("allocation:result.cashRemaining")}</span>
          </Eyebrow>
          <div className="text-foreground mt-1 font-mono text-sm font-semibold tabular-nums leading-none sm:text-base">
            {roundedCurrency(plan.cashRemaining, currency)}
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-xs">
            {sells > 0
              ? t("allocation:result.cashPlusProceeds")
              : t("allocation:result.belowMinLot")}
          </div>
        </div>
      </div>

      <p className="text-foreground/80 mt-4 hidden font-mono text-xs leading-relaxed sm:block">
        {t("allocation:result.deployNarrative", {
          amount: roundedCurrency(deployed, currency),
          actions: tradesActionSummary,
          before: fmtBps(plan.maxDriftBpsBefore),
          after: fmtBps(plan.maxDriftBpsAfter),
        })}
      </p>

      {plan.trades.length > 0 && (
        <button
          type="button"
          onClick={onReview}
          className="mt-4 inline-flex w-fit items-center gap-1 font-mono text-xs font-medium text-[#2f6b46] underline-offset-4 hover:underline sm:mt-3 dark:text-emerald-400"
        >
          {t("allocation:result.reviewTrades", { trades: tradesWord })}{" "}
          <Icons.ArrowRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ── Now · After · Target ─────────────────────────────────────────────────────

function StackedBar({
  label,
  field,
  sleeves,
  bold,
}: {
  label: string;
  field: "currentBps" | "targetBps" | "afterBps";
  sleeves: SleeveSummaryRow[];
  bold?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "w-12 shrink-0 font-mono text-xs",
          bold ? "text-foreground font-semibold" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <div className="flex h-7 flex-1 overflow-hidden rounded-md">
        {sleeves.map((s) => {
          const pct = s[field] / 100;
          if (pct <= 0) return null;
          return (
            <div
              key={s.categoryId}
              className="flex items-center justify-start overflow-hidden whitespace-nowrap pl-2 font-mono text-xs font-medium text-white/95"
              style={{ width: `${pct}%`, background: s.color }}
              title={`${s.categoryName}: ${pct.toFixed(1)}%`}
            >
              {pct >= 9 ? `${pct.toFixed(0)}%` : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SleeveTable({ sleeves }: { sleeves: SleeveSummaryRow[] }) {
  const { t } = useTranslation();
  let maxIdx = -1;
  let maxAbs = -1;
  sleeves.forEach((s, i) => {
    if (Math.abs(s.afterDriftBps) > maxAbs) {
      maxAbs = Math.abs(s.afterDriftBps);
      maxIdx = i;
    }
  });

  return (
    <table className="w-full font-mono text-xs">
      <thead>
        <tr className="text-muted-foreground border-border border-b text-xs uppercase tracking-wider">
          <th className="pb-2 text-left font-medium">{t("allocation:sleeve.sleeve")}</th>
          <th className="pb-2 pr-2 text-right font-medium">{t("allocation:sleeve.now")}</th>
          <th className="pb-2 pr-2 text-right font-medium">{t("allocation:sleeve.after")}</th>
          <th className="pb-2 pr-2 text-right font-medium">{t("allocation:sleeve.tgt")}</th>
          <th className="pb-2 text-right font-medium">{t("allocation:sleeve.drift")}</th>
        </tr>
      </thead>
      <tbody>
        {sleeves.map((s, i) => {
          const drift = s.afterDriftBps;
          const driftColor = Math.abs(drift) < 5 ? undefined : drift > 0 ? DRIFT_OVER : DRIFT_UNDER;
          return (
            <tr key={s.categoryId} className="border-border/50 border-b last:border-b-0">
              <td className="py-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: s.color }}
                  />
                  <span className="text-foreground">{s.categoryName}</span>
                  {i === maxIdx && maxAbs >= 5 && (
                    <span className="text-muted-foreground border-border rounded border px-1 py-px text-xs font-medium uppercase tracking-wide">
                      {t("allocation:sleeve.max")}
                    </span>
                  )}
                </div>
              </td>
              <td className="text-muted-foreground pr-2 text-right tabular-nums">
                {pp1(s.currentBps)}
              </td>
              <td className="text-foreground pr-2 text-right font-semibold tabular-nums">
                {pp1(s.afterBps)}
              </td>
              <td className="text-muted-foreground pr-2 text-right tabular-nums">
                {(s.targetBps / 100).toFixed(0)}
              </td>
              <td className="text-right font-medium tabular-nums" style={{ color: driftColor }}>
                {ppSigned(drift)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SleeveReshapeCard({ sleeves, mode }: { sleeves: SleeveSummaryRow[]; mode: ScenarioMode }) {
  const { t } = useTranslation();
  const narrative = reshapeNarrative(sleeves, mode, t);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 pt-4">
          <h3 className="text-foreground font-mono text-sm font-semibold">
            {t("allocation:sleeve.nowAfterTarget")}
          </h3>
          <p className="text-muted-foreground mt-1 font-mono text-xs leading-relaxed">
            {t("allocation:sleeve.reshapeDescription")}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2">
          {/* Bars */}
          <div className="border-border/60 px-5 py-5 lg:border-r">
            <div className="space-y-3">
              <StackedBar label={t("allocation:sleeve.now")} field="currentBps" sleeves={sleeves} />
              <StackedBar
                label={t("allocation:sleeve.after")}
                field="afterBps"
                sleeves={sleeves}
                bold
              />
              <StackedBar
                label={t("allocation:sleeve.target")}
                field="targetBps"
                sleeves={sleeves}
              />
            </div>
            <div className="border-border/60 mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t pt-4">
              {sleeves
                .filter((s) => s.currentBps > 0 || s.afterBps > 0 || s.targetBps > 0)
                .map((s) => (
                  <div
                    key={s.categoryId}
                    className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
                    <span className="text-foreground">{s.categoryName}</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Table + narrative */}
          <div className="px-5 py-5">
            <SleeveTable sleeves={sleeves} />
            {narrative && (
              <p className="text-muted-foreground mt-5 font-mono text-xs leading-relaxed">
                {narrative}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Warnings ──────────────────────────────────────────────────────────────────

const WARN_LABEL_KEYS: Record<string, string> = {
  missing_quote: "allocation:warnings.missingQuote",
  no_buy_candidate: "allocation:warnings.noBuyCandidate",
  tagged_cash: "allocation:warnings.taggedCash",
  unclassified_asset: "allocation:warnings.unclassified",
  partial_classification: "allocation:warnings.partialClassification",
  constraint_skipped_sell: "allocation:warnings.sellConstraint",
  turnover_cap_reached: "allocation:warnings.turnoverCap",
};

function Warnings({ items }: { items: RebalanceWarning[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
      >
        <Icons.AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="flex-1 font-mono text-xs font-semibold text-amber-800 dark:text-amber-300">
          {t("allocation:warnings.thingsToKnow", { count: items.length })}
        </span>
        <Icons.ChevronDown
          className={cn(
            "h-4 w-4 text-amber-600 transition-transform dark:text-amber-400",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <ul className="divide-y divide-amber-200/60 border-t border-amber-200/70 dark:divide-amber-900/60 dark:border-amber-900/70">
          {items.map((w, i) => (
            <li key={i} className="flex items-start gap-3 px-4 py-2.5">
              <span className="mt-px shrink-0 whitespace-nowrap rounded border border-amber-300 px-1.5 py-0.5 font-mono text-xs font-medium uppercase tracking-wide text-amber-700 dark:border-amber-700 dark:text-amber-400">
                {WARN_LABEL_KEYS[w.kind] ? t(WARN_LABEL_KEYS[w.kind]) : w.kind}
              </span>
              <span className="text-foreground/80 text-xs leading-snug">{w.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Trades table ──────────────────────────────────────────────────────────────

function tradeQuantityLabel(quantity: number | null | undefined): string {
  if (quantity == null) return "—";
  return quantity.toFixed(quantity % 1 === 0 ? 0 : 4);
}

function TradeActionBadge({ action }: { action: string }) {
  const { t } = useTranslation();
  const isSell = action === "sell";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-semibold",
        isSell
          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
          : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      )}
    >
      {isSell ? t("allocation:trades.sell") : t("allocation:trades.buy")}
    </span>
  );
}

function TradesTable({ trades, currency }: { trades: SuggestedManualTrade[]; currency: string }) {
  const { t } = useTranslation();
  const buys = trades.filter((trade) => trade.action === "buy");
  const sells = trades.filter((trade) => trade.action === "sell");
  const buyTotal = buys.reduce((sum, trade) => sum + trade.estimatedAmount, 0);
  const countSummary =
    sells.length > 0
      ? `${t("allocation:result.buysCount", { count: buys.length })} · ${t("allocation:result.sellsCount", { count: sells.length })}`
      : t("allocation:result.buysCount", { count: buys.length });

  return (
    <>
      <div className="divide-border divide-y md:hidden">
        {trades.map((trade, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <TradeActionBadge action={trade.action} />
                  <span className="text-foreground truncate font-mono text-sm font-semibold">
                    {trade.symbol ?? t("allocation:trades.trade")}
                  </span>
                </div>
                {trade.name && (
                  <div className="text-muted-foreground mt-1 truncate text-xs">{trade.name}</div>
                )}
                <div className="text-muted-foreground mt-1 font-mono text-xs">
                  {trade.categoryName}
                </div>
                {trade.accountId && (
                  <div className="text-muted-foreground mt-1 truncate font-mono text-xs">
                    {t("allocation:trades.acct", { account: trade.accountId })}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-foreground font-mono text-sm font-semibold tabular-nums">
                  {formatAmount(trade.estimatedAmount, currency)}
                </div>
                <div className="text-muted-foreground mt-1 font-mono text-xs tabular-nums">
                  {t("allocation:trades.sharesLabel", { qty: tradeQuantityLabel(trade.quantity) })}
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 font-mono text-xs">
              <div>
                <div className="text-muted-foreground uppercase tracking-[0.14em]">
                  {t("allocation:trades.price")}
                </div>
                <div className="text-foreground mt-1 tabular-nums">
                  {trade.estimatedPrice != null ? formatPrice(trade.estimatedPrice, currency) : "—"}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-muted-foreground uppercase tracking-[0.14em]">
                  {t("allocation:trades.reason")}
                </div>
                <div className="text-foreground mt-1 truncate" title={trade.reason}>
                  {trade.reason}
                </div>
              </div>
            </div>
          </div>
        ))}
        <div className="bg-muted/20 flex items-center justify-between gap-3 px-4 py-3 font-mono text-xs">
          <span className="text-muted-foreground">{countSummary}</span>
          <span className="text-foreground font-semibold tabular-nums">
            {formatAmount(buyTotal, currency)}
          </span>
        </div>
      </div>

      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[920px] table-fixed text-sm">
          <colgroup>
            <col className="w-[6%]" />
            <col className="w-[23%]" />
            <col className="w-[10%]" />
            <col className="w-[13%]" />
            <col className="w-[9%]" />
            <col className="w-[12%]" />
            <col className="w-[27%]" />
          </colgroup>
          <thead>
            <tr className="border-border text-muted-foreground border-b font-mono text-xs uppercase tracking-wider">
              <th className="py-2.5 pl-5 pr-2 text-left font-medium">
                {t("allocation:trades.colAction")}
              </th>
              <th className="py-2.5 pr-3 text-left font-medium">
                {t("allocation:trades.colTicker")}
              </th>
              <th className="py-2.5 pl-14 pr-3 text-left font-medium">
                {t("allocation:trades.colCategoryAccount")}
              </th>
              <th className="py-2.5 pr-3 text-right font-medium">
                {t("allocation:trades.colAmount")}
              </th>
              <th className="py-2.5 pr-3 text-right font-medium">
                {t("allocation:trades.colShares")}
              </th>
              <th className="py-2.5 pr-7 text-right font-medium">
                {t("allocation:trades.colLastPrice")}
              </th>
              <th className="py-2.5 pl-10 pr-5 text-left font-medium">
                {t("allocation:trades.colReason")}
              </th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, i) => (
              <tr key={i} className="border-border hover:bg-muted/30 h-12 border-b last:border-b-0">
                <td className="pl-5 pr-2">
                  <TradeActionBadge action={trade.action} />
                </td>
                <td className="pr-3">
                  {trade.symbol ? (
                    <>
                      <div className="text-foreground font-mono text-xs font-medium">
                        {trade.symbol}
                      </div>
                      {trade.name && (
                        <div className="text-muted-foreground truncate text-xs">{trade.name}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-muted-foreground pl-14 pr-3 text-xs">
                  <div>{trade.categoryName}</div>
                  {trade.accountId && (
                    <div className="truncate font-mono">
                      {t("allocation:trades.acct", { account: trade.accountId })}
                    </div>
                  )}
                </td>
                <td className="text-foreground pr-3 text-right font-semibold tabular-nums">
                  {formatAmount(trade.estimatedAmount, currency)}
                </td>
                <td className="text-muted-foreground pr-3 text-right tabular-nums">
                  {tradeQuantityLabel(trade.quantity)}
                </td>
                <td className="text-muted-foreground pr-7 text-right tabular-nums">
                  {trade.estimatedPrice != null ? formatPrice(trade.estimatedPrice, currency) : "—"}
                </td>
                <td
                  className="text-muted-foreground max-w-0 truncate pl-10 pr-5 text-xs"
                  title={trade.reason}
                >
                  {trade.reason}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-xs">
              <td colSpan={3} className="text-muted-foreground py-3 pl-5 font-mono">
                {countSummary}
              </td>
              <td className="text-foreground py-3 pr-3 text-right font-semibold tabular-nums">
                {formatAmount(buyTotal, currency)}
              </td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface RebalanceTabProps {
  profile: AllocationTarget | null;
  driftReport: DriftReport | null;
  accountScope: AccountScope;
  availableCash: number;
  sourceVersion: string;
  isSourceLoading: boolean;
}

export function RebalanceTab({
  profile,
  driftReport,
  accountScope,
  availableCash,
  sourceVersion,
  isSourceLoading,
}: RebalanceTabProps) {
  const { t } = useTranslation();
  const [cashDraft, setCashDraft] = useState<{ key: string; value: string } | null>(null);
  const [scenarioMode, setScenarioMode] = useState<ScenarioMode>("cash_flow_only");
  const tradesRef = useRef<HTMLDivElement>(null);
  const currency = driftReport?.baseCurrency ?? "USD";
  const inputContextKey = `${profile?.id ?? "no-profile"}:${accountScopeKey(accountScope)}:${currency}`;
  const cashValue =
    cashDraft?.key === inputContextKey
      ? cashDraft.value
      : cashValueFromAvailable(availableCash, currency);
  const cash = parseCashValue(cashValue);
  const availableCashLimit = cashInputLimit(availableCash, currency);
  const sourceReady = !isSourceLoading && !!driftReport;
  const sourceKey = `${inputContextKey}:${availableCash}:${sourceVersion}`;

  const planQuery = useRebalancePlan({
    targetId: profile?.id ?? "",
    cash,
    filter: accountScope,
    scenarioMode,
    sourceKey,
  });
  const cachedPlan = planQuery.data ?? null;
  const hasStalePlan = !!cachedPlan && cachedPlan.sourceKey !== sourceKey;
  const plan = hasStalePlan ? null : (cachedPlan?.plan ?? null);
  const isSellMode = scenarioMode !== "cash_flow_only";

  useEffect(() => {
    if (!profile?.allowSells && isSellMode) {
      setScenarioMode("cash_flow_only");
    }
  }, [profile?.allowSells, isSellMode]);

  function handleCashChange(value: string) {
    setCashDraft({ key: inputContextKey, value });
  }

  function handleCalculate() {
    if (!profile) return;
    if (!sourceReady) {
      toast.error(t("allocation:toast.dataLoading"));
      return;
    }
    if (availableCashLimit <= 0 && !isSellMode) {
      toast.error(t("allocation:toast.noCashAvailable"));
      return;
    }
    if (cash <= 0 && !isSellMode) {
      toast.error(t("allocation:toast.enterValidCash"));
      return;
    }
    if (cash > availableCashLimit) {
      toast.error(t("allocation:toast.cashExceeds"));
      return;
    }
    void planQuery.refetch().then((res) => {
      if (res.error)
        toast.error(t("allocation:toast.calculateFailed", { message: res.error.message }));
    });
  }

  if (!profile) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-20 text-center">
        <Icons.Target className="text-muted-foreground h-10 w-10" />
        <div className="text-foreground text-sm font-semibold">
          {t("allocation:rebalance.noProfileSelected")}
        </div>
        <div className="text-muted-foreground max-w-sm text-sm">
          {t("allocation:rebalance.selectProfileHint")}
        </div>
      </div>
    );
  }

  const description =
    scenarioMode === "sell_to_rebalance"
      ? t("allocation:rebalance.descriptionSell")
      : scenarioMode === "hybrid"
        ? t("allocation:rebalance.descriptionHybrid")
        : t("allocation:rebalance.descriptionCashFlow");

  const tolerance = driftToleranceRange(profile, driftReport, t);
  const baseDrift = driftReport?.maxDriftBps ?? 0;
  const beforeDrift = plan?.maxDriftBpsBefore ?? baseDrift;
  const scaleMaxBps = driftScaleMaxBps(Math.max(beforeDrift, baseDrift), tolerance.maxBps);

  const sleeveSummary = plan && driftReport ? computeSleeveSummary(driftReport, plan) : [];
  const isCalculating = planQuery.isFetching;

  const reviewTrades = () =>
    tradesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="space-y-4">
      <ModeSwitch
        currency={currency}
        allowSells={profile.allowSells ?? false}
        value={scenarioMode}
        onChange={setScenarioMode}
      />

      {/* ── Rebalance planner ── */}
      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div className="border-border/60 border-b px-4 py-4 sm:px-5 sm:py-5 lg:border-b-0 lg:border-r">
              <PlannerInput
                description={description}
                cashValue={cashValue}
                availableCash={availableCash}
                currency={currency}
                onCashChange={handleCashChange}
                onCalculate={handleCalculate}
                hasPlan={!!plan || hasStalePlan}
                isCalculating={isCalculating}
                isSourceLoading={!sourceReady}
              />
            </div>
            <div className="px-4 py-4 sm:px-5 sm:py-5">
              {!driftReport ? (
                <div className="space-y-3">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-10 w-40" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="mt-6 h-16 w-full" />
                </div>
              ) : isCalculating ? (
                <div className="space-y-3">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-10 w-40" />
                  <Skeleton className="mt-6 h-3 w-full" />
                  <Skeleton className="mt-6 h-16 w-full" />
                </div>
              ) : (
                <PlannerResult
                  driftReport={driftReport}
                  plan={plan}
                  currency={currency}
                  tolerance={tolerance}
                  scaleMaxBps={scaleMaxBps}
                  onReview={reviewTrades}
                />
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {hasStalePlan && sourceReady && !isCalculating && (
        <div className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 font-mono text-xs">
          {t("allocation:rebalance.stalePlan")}
        </div>
      )}

      {/* ── Plan results ── */}
      {plan && !isCalculating && (
        <>
          <Warnings items={plan.warnings} />

          {sleeveSummary.length > 0 && (
            <SleeveReshapeCard sleeves={sleeveSummary} mode={scenarioMode} />
          )}

          <Card ref={tradesRef}>
            <CardContent className="p-0">
              <div className="px-5 pb-2 pt-4">
                <h3 className="text-foreground font-mono text-sm font-semibold">
                  {t("allocation:rebalance.proposedTrades")}
                </h3>
                <p className="text-muted-foreground mt-1 font-mono text-xs">
                  {(() => {
                    const buys = plan.trades.filter((trade) => trade.action === "buy").length;
                    const sells = plan.trades.filter((trade) => trade.action === "sell").length;
                    const cashTotals = planCashTotals(plan);
                    const buysWord = t("allocation:result.buysCount", { count: buys });
                    return sells > 0
                      ? t("allocation:rebalance.tradesSummarySells", {
                          buys: buysWord,
                          sells: t("allocation:result.sellsCount", { count: sells }),
                          cash: formatAmount(cashTotals.newCashUsed, currency),
                        })
                      : t("allocation:rebalance.tradesSummaryDeployed", {
                          buys: buysWord,
                          cash: formatAmount(plan.cashUsed, currency),
                        });
                  })()}
                </p>
              </div>
              {plan.trades.length > 0 ? (
                <div className="pb-1 pt-2">
                  <TradesTable trades={plan.trades} currency={currency} />
                </div>
              ) : (
                <p className="text-muted-foreground px-6 py-4 font-mono text-xs">
                  {t("allocation:rebalance.noTrades")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Footer */}
          <div className="border-border flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-muted-foreground font-mono text-xs leading-relaxed">
              {t("allocation:rebalance.calculatedFooter", {
                name: profile.name,
                date: new Date().toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              })}
            </span>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="min-w-0 justify-center"
                onClick={() => {
                  copyToText(plan, currency, t);
                  toast.success(t("allocation:toast.copiedToClipboard"));
                }}
              >
                <Icons.Copy className="mr-1.5 h-4 w-4" />
                {t("allocation:rebalance.copyAsText")}
              </Button>
              <Button
                size="sm"
                className="min-w-0 justify-center"
                onClick={() => {
                  exportCsv(plan, currency, profile.name, t);
                  toast.success(t("allocation:toast.csvDownloaded"));
                }}
              >
                <Icons.Download className="mr-1.5 h-4 w-4" />
                {t("allocation:rebalance.exportCsv")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
