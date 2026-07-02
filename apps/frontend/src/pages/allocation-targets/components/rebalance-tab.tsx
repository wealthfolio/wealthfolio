import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Card, CardContent, Icons, Skeleton } from "@wealthfolio/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useI18n } from "@/i18n/i18n-provider";
import { translateClassificationLabel } from "@/i18n/ui-text";
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

function isChineseLanguage(language: string): boolean {
  return language === "zh-CN";
}

function localizedCategoryName(language: string, name: string): string {
  return translateClassificationLabel(language === "zh-CN" ? "zh-CN" : "en", name);
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
  language = "en",
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
      label: isChineseLanguage(language)
        ? `容差 ±${formatTolerancePct(bps)}%`
        : `tolerance ±${formatTolerancePct(bps)}%`,
    };
  }

  const minBps = Math.min(...bands);
  const maxBps = Math.max(...bands);
  const label =
    minBps === maxBps
      ? isChineseLanguage(language)
        ? `容差 ±${formatTolerancePct(maxBps)}%`
        : `tolerance ±${formatTolerancePct(maxBps)}%`
      : isChineseLanguage(language)
        ? `容差范围 ±${formatTolerancePct(minBps)}-${formatTolerancePct(maxBps)}%`
        : `tolerance range ±${formatTolerancePct(minBps)}-${formatTolerancePct(maxBps)}%`;

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
function driftDriverSentence(driftReport: DriftReport, language = "en"): string | null {
  let top: { name: string; drift: number; cur: number; tgt: number } | null = null;
  for (const r of driftReport.rows) {
    if (r.status === "not_targeted" && r.currentBps === 0) continue;
    const drift = r.currentBps - r.targetBps;
    if (!top || Math.abs(drift) > Math.abs(top.drift)) {
      top = { name: localizedCategoryName(language, r.categoryName), drift, cur: r.currentBps, tgt: r.targetBps };
    }
  }
  if (!top) return null;
  if (isChineseLanguage(language)) {
    return `${top.name} 当前 ${(top.cur / 100).toFixed(0)}%，${top.drift >= 0 ? "高于" : "低于"} ${(top.tgt / 100).toFixed(0)}% 的目标。`;
  }
  return `${top.name} sits ${(top.cur / 100).toFixed(0)}% ${top.drift >= 0 ? "over" : "under"} a ${(top.tgt / 100).toFixed(0)}% target.`;
}

function modeVerb(mode: ScenarioMode, language = "en"): string {
  if (isChineseLanguage(language)) {
    if (mode === "sell_to_rebalance") return "卖出并买入";
    if (mode === "hybrid") return "现金和卖出";
    return "现金流买入";
  }
  if (mode === "sell_to_rebalance") return "Sells and buys";
  if (mode === "hybrid") return "Cash and sells";
  return "Cash-flow buys";
}

/** Narrative for the Now · After · Target card. */
function reshapeNarrative(sleeves: SleeveSummaryRow[], mode: ScenarioMode, language = "en"): string {
  const movers = sleeves.map((s) => ({
    name: localizedCategoryName(language, s.categoryName),
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
  const verb = modeVerb(mode, language);
  if (lifted && shrank) {
    parts.push(
      isChineseLanguage(language)
        ? `${verb}会让 ${lifted.name} 向目标靠拢，并把 ${shrank.name} 的超配从 ${ppSigned(shrank.before)} 缩小到 ${ppSigned(shrank.after)}。`
        : `${verb} lift ${lifted.name} toward target and shrink the ${shrank.name} overweight from ${ppSigned(shrank.before)} to ${ppSigned(shrank.after)}.`,
    );
  } else if (lifted) {
    parts.push(
      isChineseLanguage(language)
        ? `${verb}会让 ${lifted.name} 向目标靠拢。`
        : `${verb} lift ${lifted.name} toward target.`,
    );
  } else if (shrank) {
    parts.push(
      isChineseLanguage(language)
        ? `${verb}会把 ${shrank.name} 的超配从 ${ppSigned(shrank.before)} 缩小到 ${ppSigned(shrank.after)}。`
        : `${verb} shrink the ${shrank.name} overweight from ${ppSigned(shrank.before)} to ${ppSigned(shrank.after)}.`,
    );
  }
  if (under && under.name !== shrank?.name) {
    parts.push(
      isChineseLanguage(language)
        ? `${under.name} 仍然低配，想完全补齐需要卖出或买入金额高于最低交易额。`
        : `${under.name} stays underweight — closing it needs a sell or a buy above the minimum lot.`,
    );
  }
  return parts.join(" ");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function tradeCountSummary(buys: number, sells: number, language = "en"): string {
  if (isChineseLanguage(language)) {
    return sells > 0 ? `${buys} 笔买入 · ${sells} 笔卖出` : `${buys} 笔买入 · 0 笔卖出`;
  }
  return sells > 0
    ? `${pluralize(buys, "buy")} · ${pluralize(sells, "sell")}`
    : `${pluralize(buys, "buy")} · 0 sells`;
}

function tradeActionSummary(buys: number, sells: number, language = "en"): string {
  if (isChineseLanguage(language)) {
    return sells > 0 ? `${buys} 笔买入和 ${sells} 笔卖出` : `${buys} 笔买入`;
  }
  return sells > 0
    ? `${pluralize(buys, "buy")} and ${pluralize(sells, "sell")}`
    : pluralize(buys, "buy");
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

function tradeReason(trade: SuggestedManualTrade, language: string): string {
  if (!isChineseLanguage(language)) {
    return trade.reason;
  }

  const categoryName = localizedCategoryName(language, trade.categoryName);
  if (/ improves portfolio drift\.$/.test(trade.reason)) {
    return `${trade.symbol ?? categoryName} 可改善组合偏离。`;
  }

  if (/ is overweight — selling reduces portfolio drift\.$/.test(trade.reason)) {
    return `${trade.symbol ?? categoryName} 超配，卖出可降低组合偏离。`;
  }

  if (/^Category .+ is underweight\. Allocate manually\.$/.test(trade.reason)) {
    return `${categoryName} 低配，请手动配置。`;
  }

  return "该交易用于改善组合偏离。";
}

function exportCsv(plan: RebalancePlan, currency: string, profileName: string, language = "en") {
  const generated = new Date().toISOString().slice(0, 10);
  const fractionDigits = currencyFractionDigits(currency);
  const cashTotals = planCashTotals(plan);
  const isChinese = isChineseLanguage(language);
  const cashRows = cashTotals.hasSells
    ? [
        [isChinese ? "买入合计" : "Buy total", cashTotals.buyTotal.toFixed(fractionDigits)],
        [isChinese ? "卖出所得" : "Sell proceeds", cashTotals.sellProceeds.toFixed(fractionDigits)],
        [isChinese ? "新增现金使用" : "New cash used", cashTotals.newCashUsed.toFixed(fractionDigits)],
        [isChinese ? "剩余现金" : "Cash remaining", plan.cashRemaining.toFixed(fractionDigits)],
        [isChinese ? "可用现金" : "Cash available", plan.availableCash.toFixed(fractionDigits)],
      ]
    : [
        [isChinese ? "已投入现金" : "Cash deployed", plan.cashUsed.toFixed(fractionDigits)],
        [isChinese ? "剩余现金" : "Cash remaining", plan.cashRemaining.toFixed(fractionDigits)],
        [isChinese ? "可用现金" : "Cash available", plan.availableCash.toFixed(fractionDigits)],
      ];

  const meta = [
    [isChinese ? "生成日期" : "Generated", generated],
    [isChinese ? "配置" : "Profile", profileName],
    [isChinese ? "币种" : "Currency", currency],
    ...cashRows,
    [isChinese ? "调整前最大偏离" : "Max drift before", fmtBps(plan.maxDriftBpsBefore)],
    [isChinese ? "调整后最大偏离" : "Max drift after", fmtBps(plan.maxDriftBpsAfter)],
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  const header = [
    isChinese ? "操作" : "Action",
    isChinese ? "代码" : "Symbol",
    isChinese ? "名称" : "Name",
    isChinese ? "分类" : "Category",
    `${isChinese ? "金额" : "Amount"} (${currency})`,
    isChinese ? "股数" : "Shares",
    `${isChinese ? "最新价" : "Last Price"} (${currency})`,
    isChinese ? "原因" : "Reason",
  ]
    .map(csvCell)
    .join(",");

  const rows = plan.trades.map((t) =>
    [
      isChinese ? (t.action === "sell" ? "卖出" : "买入") : t.action,
      t.symbol ?? "",
      t.name ?? "",
      localizedCategoryName(language, t.categoryName),
      t.estimatedAmount.toFixed(fractionDigits),
      t.quantity != null ? t.quantity.toFixed(t.quantity % 1 === 0 ? 0 : 4) : "",
      t.estimatedPrice != null ? t.estimatedPrice.toFixed(fractionDigits) : "",
      tradeReason(t, language),
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

function copyToText(plan: RebalancePlan, currency: string, language = "en") {
  const cashTotals = planCashTotals(plan);
  const isChinese = isChineseLanguage(language);
  const lines = [
    `${isChinese ? "再平衡方案" : "Rebalance plan"} · ${new Date().toLocaleDateString(isChinese ? "zh-CN" : undefined)}`,
    cashTotals.hasSells
      ? isChinese
        ? `新增现金使用：${formatAmount(cashTotals.newCashUsed, currency)}（买入合计 ${formatAmount(cashTotals.buyTotal, currency)}，卖出所得 ${formatAmount(cashTotals.sellProceeds, currency)}，剩余现金 ${formatAmount(plan.cashRemaining, currency)}）`
        : `New cash used: ${formatAmount(cashTotals.newCashUsed, currency)} (buy total ${formatAmount(cashTotals.buyTotal, currency)}, sell proceeds ${formatAmount(cashTotals.sellProceeds, currency)}, cash remaining ${formatAmount(plan.cashRemaining, currency)})`
      : isChinese
        ? `已投入现金：${formatAmount(plan.cashUsed, currency)}，可用现金 ${formatAmount(plan.availableCash, currency)}`
        : `Cash deployed: ${formatAmount(plan.cashUsed, currency)} of ${formatAmount(plan.availableCash, currency)}`,
    `${isChinese ? "最大偏离" : "Max drift"}: ${fmtBps(plan.maxDriftBpsBefore)} -> ${fmtBps(plan.maxDriftBpsAfter)}`,
    "",
    isChinese ? "建议交易" : "PROPOSED TRADES",
    ...plan.trades.map(
      (t) =>
        `${isChinese ? (t.action === "sell" ? "卖出" : "买入") : t.action.toUpperCase()}  ${t.symbol ?? localizedCategoryName(language, t.categoryName)}  ${formatAmount(t.estimatedAmount, currency)}` +
        (t.quantity != null
          ? `  ${t.quantity.toFixed(t.quantity % 1 === 0 ? 0 : 4)} ${isChinese ? "股" : "sh"}`
          : "") +
        (t.estimatedPrice != null ? ` @ ${formatAmount(t.estimatedPrice, currency)}` : ""),
    ),
  ];
  if (plan.warnings.length) {
    lines.push("", isChinese ? `${plan.warnings.length} 条提示：` : `${plan.warnings.length} warning(s):`);
    plan.warnings.forEach((w) => lines.push(`  · ${warningMessage(w, language)}`));
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
  language,
}: {
  currency: string;
  allowSells: boolean;
  value: ScenarioMode;
  onChange: (mode: ScenarioMode) => void;
  language: string;
}) {
  const isChinese = isChineseLanguage(language);
  const modes: { id: ScenarioMode; label: string; shortLabel: string; hint: string }[] = [
    {
      id: "cash_flow_only",
      label: isChinese ? "仅现金流" : "Cash-flow only",
      shortLabel: isChinese ? "现金流" : "Cash-flow",
      hint: isChinese ? `投入新增${currencySymbol(currency)}` : `deploy new ${currencySymbol(currency)}`,
    },
    {
      id: "sell_to_rebalance",
      label: isChinese ? "卖出再平衡" : "Sell to rebalance",
      shortLabel: isChinese ? "卖出" : "Sell",
      hint: isChinese ? "卖出资金买入" : "sells fund buys",
    },
    {
      id: "hybrid",
      label: isChinese ? "混合" : "Hybrid",
      shortLabel: isChinese ? "混合" : "Hybrid",
      hint: isChinese ? "现金 + 卖出" : "cash + sells",
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
              {isChinese ? "请在此目标中启用“允许卖出”后使用该模式" : "Enable 'Allow sells' on this target to use this mode"}
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
  language,
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
  language: string;
}) {
  const isChinese = isChineseLanguage(language);
  const limit = cashInputLimit(availableCash, currency);
  const deploy = parseCashValue(cashValue);
  const overBudget = deploy > limit;
  const pct = limit > 0 ? Math.min(100, Math.max(0, (deploy / limit) * 100)) : 0;
  const fraction = currencyFractionDigits(currency);

  const presets: { id: string; label: string; value: number }[] = [
    { id: "25", label: "25%", value: limit * 0.25 },
    { id: "50", label: "50%", value: limit * 0.5 },
    { id: "75", label: "75%", value: limit * 0.75 },
    { id: "all", label: isChinese ? "全部" : "All", value: limit },
  ];
  const activePreset = presets.find((p) => Math.abs(p.value - deploy) <= 0.5 + limit * 0.001)?.id;

  const canCalculate = !isCalculating && !isSourceLoading && limit > 0 && deploy > 0 && !overBudget;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <Eyebrow>{isChinese ? "可投入现金" : "Cash to deploy"}</Eyebrow>
        <span className="text-muted-foreground font-mono text-[11px] sm:text-xs">
          {isChinese
            ? `当前范围内可用 ${roundedCurrency(availableCash, currency)}`
            : `of ${roundedCurrency(availableCash, currency)} in scope`}
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
          {isChinese ? "超过可用现金" : "Exceeds available cash"}
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
            ? isChinese
              ? "计算中…"
              : "Calculating…"
            : isSourceLoading
              ? isChinese
                ? "加载中…"
                : "Loading…"
              : hasPlan
                ? isChinese
                  ? "重新计算"
                  : "Recalculate"
                : isChinese
                  ? "计算方案"
                  : "Calculate plan"}
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
  language,
}: {
  beforeBps: number;
  afterBps: number | null;
  tolerance: DriftToleranceRange;
  scaleMaxBps: number;
  language: string;
}) {
  const isChinese = isChineseLanguage(language);
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
            {isAfter ? (isChinese ? "调整后" : "After") : isChinese ? "当前" : "Now"}
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
              {isChinese ? "调整前" : "Before"}
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
  mode,
  onReview,
  language,
}: {
  driftReport: DriftReport;
  plan: RebalancePlan | null;
  currency: string;
  tolerance: DriftToleranceRange;
  scaleMaxBps: number;
  mode: ScenarioMode;
  onReview: () => void;
  language: string;
}) {
  const isChinese = isChineseLanguage(language);
  if (!plan) {
    // ── Before Calculate ──
    const driver = driftDriverSentence(driftReport, language);
    return (
      <div className="flex h-full flex-col">
        <Eyebrow>{isChinese ? "当前最大偏离" : "Current max drift"}</Eyebrow>
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
            language={language}
          />
        </div>

        <div className="border-border/70 mt-4 grid grid-cols-3 gap-4 border-t pt-3">
          {(isChinese ? ["交易", "影响", "调整后偏离"] : ["Trades", "Impact", "Drift after"]).map((label) => (
            <div key={label}>
              <Eyebrow>{label}</Eyebrow>
              <div className="text-muted-foreground mt-1 font-mono text-sm">—</div>
            </div>
          ))}
        </div>

        <p className="text-muted-foreground mt-auto pt-4 font-mono text-xs">
          {isChinese ? "设置输入后，点击“计算方案”来预估结果 →" : "Set your inputs, then Calculate to project the plan →"}
        </p>
      </div>
    );
  }

  // ── After Calculate ──
  const cashTotals = planCashTotals(plan);
  const buys = plan.trades.filter((t) => t.action === "buy").length;
  const sells = plan.trades.filter((t) => t.action === "sell").length;
  const tradeSub = tradeCountSummary(buys, sells, language);
  const deployed = sells > 0 ? cashTotals.newCashUsed : plan.cashUsed;
  const scopePct =
    plan.availableCash > 0 ? Math.round((plan.cashUsed / plan.availableCash) * 100) : 0;
  const improvedBps = plan.maxDriftBpsBefore - plan.maxDriftBpsAfter;
  const improved = improvedBps > 0;

  const tradesWord = isChinese ? `${plan.trades.length} 笔交易` : pluralize(plan.trades.length, "trade");
  const tradesActionSummary = tradeActionSummary(buys, sells, language);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <Eyebrow>{isChinese ? "预计最大偏离" : "Projected max drift"}</Eyebrow>
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
          language={language}
        />
      </div>

      <div className="border-border/70 mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 sm:grid-cols-3 sm:gap-4">
        <div>
          <Eyebrow>{isChinese ? "交易" : "Trades"}</Eyebrow>
          <div className="text-foreground mt-1 font-mono text-sm font-semibold tabular-nums leading-none sm:text-base">
            {plan.trades.length}
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-xs">{tradeSub}</div>
        </div>
        <div>
          <Eyebrow>
            <span className="sm:hidden">{isChinese ? "已投入" : "Deployed"}</span>
            <span className="hidden sm:inline">{isChinese ? "已投入现金" : "Cash deployed"}</span>
          </Eyebrow>
          <div className="text-foreground mt-1 font-mono text-sm font-semibold tabular-nums leading-none sm:text-base">
            {roundedCurrency(deployed, currency)}
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-xs">
            {isChinese ? `占范围 ${scopePct}%` : `${scopePct}% of scope`}
          </div>
        </div>
        <div>
          <Eyebrow>
            <span className="sm:hidden">{isChinese ? "剩余" : "Remaining"}</span>
            <span className="hidden sm:inline">{isChinese ? "剩余现金" : "Cash remaining"}</span>
          </Eyebrow>
          <div className="text-foreground mt-1 font-mono text-sm font-semibold tabular-nums leading-none sm:text-base">
            {roundedCurrency(plan.cashRemaining, currency)}
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-xs">
            {isChinese
              ? sells > 0
                ? "现金 + 卖出所得"
                : "低于最低交易额"
              : sells > 0
                ? "cash + proceeds"
                : "below min lot"}
          </div>
        </div>
      </div>

      <p className="text-foreground/80 mt-4 hidden font-mono text-xs leading-relaxed sm:block">
        {isChinese
          ? "此方案将投入"
          : modeVerb(mode, language) === "Cash-flow buys"
            ? "Deploying"
            : "This plan deploys"}{" "}
        <span className="text-foreground font-semibold">{roundedCurrency(deployed, currency)}</span>{" "}
        {isChinese ? `，执行 ${tradesActionSummary}，将最大偏离从 ` : `across ${tradesActionSummary} — cutting max drift `}
        <span className="text-foreground font-semibold">{fmtBps(plan.maxDriftBpsBefore)}</span>
        {isChinese ? " 降至 " : " to "}
        <span className="text-foreground font-semibold">{fmtBps(plan.maxDriftBpsAfter)}</span>
        {isChinese ? "。" : "."}
      </p>

      {plan.trades.length > 0 && (
        <button
          type="button"
          onClick={onReview}
          className="mt-4 inline-flex w-fit items-center gap-1 font-mono text-xs font-medium text-[#2f6b46] underline-offset-4 hover:underline sm:mt-3 dark:text-emerald-400"
        >
          {isChinese ? `查看${tradesWord}` : `Review ${tradesWord}`}{" "}
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
  language,
}: {
  label: string;
  field: "currentBps" | "targetBps" | "afterBps";
  sleeves: SleeveSummaryRow[];
  bold?: boolean;
  language: string;
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
              title={`${localizedCategoryName(language, s.categoryName)}: ${pct.toFixed(1)}%`}
            >
              {pct >= 9 ? `${pct.toFixed(0)}%` : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SleeveTable({ sleeves, language }: { sleeves: SleeveSummaryRow[]; language: string }) {
  const isChinese = isChineseLanguage(language);
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
          <th className="pb-2 text-left font-medium">{isChinese ? "分类" : "Sleeve"}</th>
          <th className="pb-2 pr-2 text-right font-medium">{isChinese ? "当前" : "Now"}</th>
          <th className="pb-2 pr-2 text-right font-medium">{isChinese ? "调整后" : "After"}</th>
          <th className="pb-2 pr-2 text-right font-medium">{isChinese ? "目标" : "Tgt"}</th>
          <th className="pb-2 text-right font-medium">{isChinese ? "偏离" : "Drift"}</th>
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
                  <span className="text-foreground">{localizedCategoryName(language, s.categoryName)}</span>
                  {i === maxIdx && maxAbs >= 5 && (
                    <span className="text-muted-foreground border-border rounded border px-1 py-px text-xs font-medium uppercase tracking-wide">
                      {isChinese ? "最大" : "Max"}
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

function SleeveReshapeCard({
  sleeves,
  mode,
  language,
}: {
  sleeves: SleeveSummaryRow[];
  mode: ScenarioMode;
  language: string;
}) {
  const isChinese = isChineseLanguage(language);
  const narrative = reshapeNarrative(sleeves, mode, language);
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-5 pt-4">
          <h3 className="text-foreground font-mono text-sm font-semibold">
            {isChinese ? "当前 · 调整后 · 目标" : "Now · After · Target"}
          </h3>
          <p className="text-muted-foreground mt-1 font-mono text-xs leading-relaxed">
            {isChinese
              ? "查看投入这笔现金后，各分类在组合中的变化。三条堆叠条使用相同顺序。"
              : "How deploying this cash reshapes the portfolio by sleeve. Sleeves are stacked in the same order across all three bars."}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2">
          {/* Bars */}
          <div className="border-border/60 px-5 py-5 lg:border-r">
            <div className="space-y-3">
              <StackedBar
                label={isChinese ? "当前" : "Now"}
                field="currentBps"
                sleeves={sleeves}
                language={language}
              />
              <StackedBar
                label={isChinese ? "调整后" : "After"}
                field="afterBps"
                sleeves={sleeves}
                bold
                language={language}
              />
              <StackedBar
                label={isChinese ? "目标" : "Target"}
                field="targetBps"
                sleeves={sleeves}
                language={language}
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
                    <span className="text-foreground">
                      {localizedCategoryName(language, s.categoryName)}
                    </span>
                  </div>
                ))}
            </div>
          </div>

          {/* Table + narrative */}
          <div className="px-5 py-5">
            <SleeveTable sleeves={sleeves} language={language} />
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

const WARN_LABEL: Record<string, string> = {
  missing_quote: "Missing quote",
  no_buy_candidate: "No buy candidate",
  tagged_cash: "Tagged cash",
  unclassified_asset: "Unclassified",
  partial_classification: "Partial classification",
};

const WARN_LABEL_ZH: Record<string, string> = {
  missing_quote: "缺少报价",
  no_buy_candidate: "没有买入候选",
  tagged_cash: "已标记现金",
  unclassified_asset: "未分类",
  partial_classification: "部分分类",
};

function warningMessage(warning: RebalanceWarning, language: string): string {
  if (!isChineseLanguage(language)) {
    return warning.message;
  }

  const categoryName =
    warning.categoryId && warning.categoryId !== "__UNKNOWN__"
      ? localizedCategoryName(language, warning.categoryId)
      : "";

  switch (warning.kind) {
    case "missing_quote": {
      const symbol = warning.message.split(":")[0] || "该资产";
      return `${symbol} 没有有效价格，整股模式下已跳过。`;
    }
    case "no_buy_candidate": {
      const match = warning.message.match(/Allocate ([0-9.,-]+) to this category manually\./);
      const amount = match?.[1] ? ` ${match[1]}` : "";
      return `没有可自动归类到该分类的持仓，请手动向${categoryName || "此分类"}配置${amount}。`;
    }
    case "tagged_cash": {
      return `${categoryName || "该分类"}包含已标记现金。这部分现金不会计入可投入现金；请移动或重新分类后再再平衡。`;
    }
    case "unclassified_asset": {
      const symbol = warning.message.split(" ")[0] || "该资产";
      return `${symbol} 未按此目标分类，因此已从方案中排除。分类后即可纳入。`;
    }
    case "partial_classification": {
      const symbol = warning.message.split(" ")[0] || "该资产";
      return `${symbol} 只有部分分类，因此方案只计算已知敞口，其余部分会忽略。`;
    }
    default:
      return "此方案有一条未分类提示，请检查设置。";
  }
}

function Warnings({ items, language }: { items: RebalanceWarning[]; language: string }) {
  const [open, setOpen] = useState(false);
  const isChinese = isChineseLanguage(language);
  if (!items.length) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left"
      >
        <Icons.AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="flex-1 font-mono text-xs font-semibold text-amber-800 dark:text-amber-300">
          {isChinese
            ? `此方案有 ${items.length} 条提示`
            : `${items.length} thing${items.length > 1 ? "s" : ""} to know about this plan`}
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
                {isChinese ? (WARN_LABEL_ZH[w.kind] ?? w.kind) : (WARN_LABEL[w.kind] ?? w.kind)}
              </span>
              <span className="text-foreground/80 text-xs leading-snug">
                {warningMessage(w, language)}
              </span>
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

function TradeActionBadge({ action, language }: { action: string; language: string }) {
  const isSell = action === "sell";
  const label = isChineseLanguage(language) ? (isSell ? "卖出" : "买入") : isSell ? "Sell" : "Buy";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs font-semibold",
        isSell
          ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
          : "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      )}
    >
      {label}
    </span>
  );
}

function TradesTable({
  trades,
  currency,
  language,
}: {
  trades: SuggestedManualTrade[];
  currency: string;
  language: string;
}) {
  const isChinese = isChineseLanguage(language);
  const buys = trades.filter((t) => t.action === "buy");
  const sells = trades.filter((t) => t.action === "sell");
  const buyTotal = buys.reduce((s, t) => s + t.estimatedAmount, 0);

  return (
    <>
      <div className="divide-border divide-y md:hidden">
        {trades.map((t, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <TradeActionBadge action={t.action} language={language} />
                  <span className="text-foreground truncate font-mono text-sm font-semibold">
                    {t.symbol ?? (isChinese ? "交易" : "Trade")}
                  </span>
                </div>
                {t.name && (
                  <div className="text-muted-foreground mt-1 truncate text-xs">{t.name}</div>
                )}
                <div className="text-muted-foreground mt-1 font-mono text-xs">
                  {localizedCategoryName(language, t.categoryName)}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-foreground font-mono text-sm font-semibold tabular-nums">
                  {formatAmount(t.estimatedAmount, currency)}
                </div>
                <div className="text-muted-foreground mt-1 font-mono text-xs tabular-nums">
                  {tradeQuantityLabel(t.quantity)} {isChinese ? "股" : "shares"}
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 font-mono text-xs">
              <div>
                <div className="text-muted-foreground uppercase tracking-[0.14em]">
                  {isChinese ? "价格" : "Price"}
                </div>
                <div className="text-foreground mt-1 tabular-nums">
                  {t.estimatedPrice != null ? formatAmount(t.estimatedPrice, currency) : "—"}
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-muted-foreground uppercase tracking-[0.14em]">
                  {isChinese ? "原因" : "Reason"}
                </div>
                <div className="text-foreground mt-1 truncate" title={tradeReason(t, language)}>
                  {tradeReason(t, language)}
                </div>
              </div>
            </div>
          </div>
        ))}
        <div className="bg-muted/20 flex items-center justify-between gap-3 px-4 py-3 font-mono text-xs">
          <span className="text-muted-foreground">
            {tradeCountSummary(buys.length, sells.length, language)}
          </span>
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
                {isChinese ? "操作" : "Action"}
              </th>
              <th className="py-2.5 pr-3 text-left font-medium">
                {isChinese ? "代码" : "Ticker"}
              </th>
              <th className="py-2.5 pl-14 pr-3 text-left font-medium">
                {isChinese ? "分类" : "Category"}
              </th>
              <th className="py-2.5 pr-3 text-right font-medium">
                {isChinese ? "金额" : "Amount"}
              </th>
              <th className="py-2.5 pr-3 text-right font-medium">
                {isChinese ? "股数" : "Shares"}
              </th>
              <th className="py-2.5 pr-7 text-right font-medium">
                {isChinese ? "最新价" : "Last price"}
              </th>
              <th className="py-2.5 pl-10 pr-5 text-left font-medium">
                {isChinese ? "原因" : "Reason"}
              </th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i} className="border-border hover:bg-muted/30 h-12 border-b last:border-b-0">
                <td className="pl-5 pr-2">
                  <TradeActionBadge action={t.action} language={language} />
                </td>
                <td className="pr-3">
                  {t.symbol ? (
                    <>
                      <div className="text-foreground font-mono text-xs font-medium">
                        {t.symbol}
                      </div>
                      {t.name && (
                        <div className="text-muted-foreground truncate text-xs">{t.name}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-muted-foreground pl-14 pr-3 text-xs">
                  {localizedCategoryName(language, t.categoryName)}
                </td>
                <td className="text-foreground pr-3 text-right font-semibold tabular-nums">
                  {formatAmount(t.estimatedAmount, currency)}
                </td>
                <td className="text-muted-foreground pr-3 text-right tabular-nums">
                  {tradeQuantityLabel(t.quantity)}
                </td>
                <td className="text-muted-foreground pr-7 text-right tabular-nums">
                  {t.estimatedPrice != null ? formatAmount(t.estimatedPrice, currency) : "—"}
                </td>
                <td
                  className="text-muted-foreground max-w-0 truncate pl-10 pr-5 text-xs"
                  title={tradeReason(t, language)}
                >
                  {tradeReason(t, language)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-xs">
              <td colSpan={3} className="text-muted-foreground py-3 pl-5 font-mono">
                {tradeCountSummary(buys.length, sells.length, language)}
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
  const { language } = useI18n();
  const isChinese = isChineseLanguage(language);
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
      toast.error(isChinese ? "投资组合数据仍在加载" : "Portfolio data is still loading");
      return;
    }
    if (availableCashLimit <= 0 && !isSellMode) {
      toast.error(isChinese ? "当前范围内没有可用现金" : "No cash available in scope");
      return;
    }
    if (cash <= 0 && !isSellMode) {
      toast.error(isChinese ? "请输入有效现金金额" : "Enter a valid cash amount");
      return;
    }
    if (cash > availableCashLimit) {
      toast.error(isChinese ? "可投入现金超过可用现金" : "Cash to deploy exceeds available cash");
      return;
    }
    void planQuery.refetch().then((res) => {
      if (res.error) {
        toast.error(
          isChinese
            ? "计算方案失败。请调整输入后重试。"
            : `Failed to calculate plan: ${res.error.message}`,
        );
      }
    });
  }

  if (!profile) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-20 text-center">
        <Icons.Target className="text-muted-foreground h-10 w-10" />
        <div className="text-foreground text-sm font-semibold">
          {isChinese ? "未选择配置" : "No profile selected"}
        </div>
        <div className="text-muted-foreground max-w-sm text-sm">
          {isChinese ? "请选择目标配置以计算再平衡方案。" : "Select a target profile to calculate a rebalance plan."}
        </div>
      </div>
    );
  }

  const description =
    scenarioMode === "sell_to_rebalance"
      ? isChinese
        ? "卖出超配分类，用所得资金买入低配分类。现金保持不动，税务影响未估算。"
        : "Sell what you're overweight to buy what you're underweight. Your cash stays put. Tax impact is not estimated."
      : scenarioMode === "hybrid"
        ? isChinese
          ? "先投入现金；如果现金不足以缩小差距，再卖出超配分类。现金只能加仓，不能减少已有超配仓位。税务影响未估算。"
          : "Invest your cash first, then sell overweight sleeves only if cash alone can't close the gap. Cash can add to a holding but can't shrink one you already own too much of. Tax impact is not estimated."
        : isChinese
          ? "把新增现金投入低配分类。仅建议买入，不会卖出任何仓位。"
          : "Put your new cash to work in the sleeves you're light on. Buys only — nothing is sold.";

  const tolerance = driftToleranceRange(profile, driftReport, language);
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
        language={language}
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
                language={language}
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
                  mode={scenarioMode}
                  onReview={reviewTrades}
                  language={language}
                />
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {hasStalePlan && sourceReady && !isCalculating && (
        <div className="border-border bg-muted/40 text-muted-foreground rounded-lg border px-4 py-3 font-mono text-xs">
          {isChinese
            ? "投资组合数据已变化。请重新计算以刷新此方案。"
            : "Portfolio data changed. Recalculate to refresh this plan."}
        </div>
      )}

      {/* ── Plan results ── */}
      {plan && !isCalculating && (
        <>
          <Warnings items={plan.warnings} language={language} />

          {sleeveSummary.length > 0 && (
            <SleeveReshapeCard sleeves={sleeveSummary} mode={scenarioMode} language={language} />
          )}

          <Card ref={tradesRef}>
            <CardContent className="p-0">
              <div className="px-5 pb-2 pt-4">
                <h3 className="text-foreground font-mono text-sm font-semibold">
                  {isChinese ? "建议交易" : "Proposed trades"}
                </h3>
                <p className="text-muted-foreground mt-1 font-mono text-xs">
                  {(() => {
                    const buys = plan.trades.filter((t) => t.action === "buy").length;
                    const sells = plan.trades.filter((t) => t.action === "sell").length;
                    const cashTotals = planCashTotals(plan);
                    if (isChinese) {
                      return sells > 0
                        ? `${buys} 笔买入 · ${sells} 笔卖出 · ${formatAmount(cashTotals.newCashUsed, currency)} 新增现金`
                        : `${buys} 笔买入 · 已投入 ${formatAmount(plan.cashUsed, currency)}`;
                    }
                    return sells > 0
                      ? `${pluralize(buys, "buy")} · ${pluralize(sells, "sell")} · ${formatAmount(cashTotals.newCashUsed, currency)} new cash`
                      : `${pluralize(buys, "buy")} · ${formatAmount(plan.cashUsed, currency)} deployed`;
                  })()}
                </p>
              </div>
              {plan.trades.length > 0 ? (
                <div className="pb-1 pt-2">
                  <TradesTable trades={plan.trades} currency={currency} language={language} />
                </div>
              ) : (
                <p className="text-muted-foreground px-6 py-4 font-mono text-xs">
                  {isChinese
                    ? "暂无交易：所有分类已在容差范围内，或没有找到持仓。"
                    : "No trades — all sleeves are already within band or no holdings found."}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Footer */}
          <div className="border-border flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-muted-foreground font-mono text-xs leading-relaxed">
              {profile.name} · {isChinese ? "计算于" : "Calculated"}{" "}
              {new Date().toLocaleDateString(isChinese ? "zh-CN" : undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="min-w-0 justify-center"
                onClick={() => {
                  copyToText(plan, currency, language);
                  toast.success(isChinese ? "已复制到剪贴板" : "Copied to clipboard");
                }}
              >
                <Icons.Copy className="mr-1.5 h-4 w-4" />
                {isChinese ? "复制为文本" : "Copy as text"}
              </Button>
              <Button
                size="sm"
                className="min-w-0 justify-center"
                onClick={() => {
                  exportCsv(plan, currency, profile.name, language);
                  toast.success(isChinese ? "CSV 已下载" : "CSV downloaded");
                }}
              >
                <Icons.Download className="mr-1.5 h-4 w-4" />
                {isChinese ? "导出 CSV" : "Export CSV"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
