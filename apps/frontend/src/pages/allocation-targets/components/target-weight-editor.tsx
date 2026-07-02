import { useRef, useState } from "react";
import type { AppLanguage } from "@/i18n/languages";
import { translateClassificationLabel } from "@/i18n/ui-text";
import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui";
import type { BandType, TaxonomyCategory } from "@/lib/types";
import { allocationTargetColor } from "./allocation-target-colors";

export interface WeightDraft {
  categoryId: string;
  targetBps: number; // 0–10000
  isLocked: boolean;
  isUserSet?: boolean; // user explicitly set this value — don't auto-redistribute it
}

interface TargetWeightEditorProps {
  categories: TaxonomyCategory[];
  weights: WeightDraft[];
  currentAllocation?: Record<string, number>; // categoryId → pct 0-100
  categoryLabel?: string;
  bandType: BandType;
  driftBandBps: number;
  relativeFactorBps: number;
  language: AppLanguage;
  onChange: (weights: WeightDraft[]) => void;
}

function isFixed(weight: WeightDraft, changedId: string): boolean {
  return weight.categoryId === changedId || weight.isLocked || !!weight.isUserSet;
}

function redistribute(weights: WeightDraft[], changedId: string, newBps: number): WeightDraft[] {
  const bps = Math.max(0, Math.min(10000, newBps));
  const updated = weights.map((n) =>
    n.categoryId === changedId ? { ...n, targetBps: bps, isUserSet: true } : n,
  );

  const fixedTotal = updated.reduce((s, n) => (isFixed(n, changedId) ? s + n.targetBps : s), 0);
  const remaining = 10000 - fixedTotal;
  const flexible = updated.filter((n) => !isFixed(n, changedId));

  if (flexible.length === 0) return updated;
  if (remaining <= 0) {
    return updated.map((n) => (!isFixed(n, changedId) ? { ...n, targetBps: 0 } : n));
  }

  const flexTotal = flexible.reduce((s, n) => s + n.targetBps, 0);

  if (flexTotal === 0) {
    const perCat = Math.floor(remaining / flexible.length);
    let leftover = remaining - perCat * flexible.length;
    return updated.map((n) => {
      if (isFixed(n, changedId)) return n;
      const extra = leftover-- > 0 ? 1 : 0;
      return { ...n, targetBps: perCat + extra };
    });
  }

  // Proportional redistribution among flexible (non-fixed) weights.
  let distributed = 0;
  const result = updated.map((n) => {
    if (isFixed(n, changedId)) return n;
    const share = Math.round((n.targetBps / flexTotal) * remaining);
    distributed += share;
    return { ...n, targetBps: share };
  });
  // Fix rounding error on largest flexible weight.
  const diff = remaining - distributed;
  if (diff !== 0) {
    let largestIdx = -1;
    let largestBps = -1;
    result.forEach((n, i) => {
      if (!isFixed(n, changedId) && n.targetBps > largestBps) {
        largestBps = n.targetBps;
        largestIdx = i;
      }
    });
    if (largestIdx >= 0)
      result[largestIdx] = {
        ...result[largestIdx],
        targetBps: result[largestIdx].targetBps + diff,
      };
  }
  return result;
}

function effectiveBandPct(
  targetBps: number,
  bandType: BandType,
  driftBandBps: number,
  relativeFactorBps: number,
): number {
  if (bandType === "absolute") return driftBandBps / 100;
  const relative = (targetBps * relativeFactorBps) / 10_000 / 100;
  return Math.max(relative, driftBandBps / 100);
}

function driftTone(
  drift: number,
  bandPct: number,
  isChinese: boolean,
): { label: string; className: string } {
  if (Math.abs(drift) <= bandPct) {
    return {
      label: isChinese ? "目标内" : "On target",
      className: "bg-muted text-muted-foreground",
    };
  }
  if (drift > 0) {
    return {
      label: isChinese ? `高于目标 +${drift.toFixed(1)}%` : `Over +${drift.toFixed(1)}%`,
      className: "bg-[#eadbd3] text-[#8a5b45]",
    };
  }
  return {
    label: isChinese ? `低于目标 ${drift.toFixed(1)}%` : `Under ${drift.toFixed(1)}%`,
    className: "bg-[#dfe8dc] text-[#4f6544]",
  };
}

export function TargetWeightEditor({
  categories,
  weights,
  currentAllocation = {},
  categoryLabel = "Asset class",
  bandType,
  driftBandBps,
  relativeFactorBps,
  language,
  onChange,
}: TargetWeightEditorProps) {
  const isChinese = language === "zh-CN";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [liveBps, setLiveBps] = useState<number | null>(null);
  const skipBlurCommitRef = useRef(false);

  // Preview weights: redistribute live while user is typing, so other rows update in real-time.
  const previewWeights =
    editingId !== null && liveBps !== null ? redistribute(weights, editingId, liveBps) : weights;

  const totalBps = previewWeights.reduce((s, n) => s + n.targetBps, 0);
  const isValid = totalBps === 10000;

  function getWeightBps(categoryId: string): number {
    return previewWeights.find((n) => n.categoryId === categoryId)?.targetBps ?? 0;
  }
  function getIsLocked(categoryId: string): boolean {
    return weights.find((n) => n.categoryId === categoryId)?.isLocked ?? false;
  }

  function startEdit(categoryId: string) {
    if (getIsLocked(categoryId)) return;
    skipBlurCommitRef.current = false;
    setEditingId(categoryId);
    setLiveBps(null);
    setEditValue((getWeightBps(categoryId) / 100).toFixed(1));
  }

  function commitEdit(categoryId: string) {
    skipBlurCommitRef.current = false;
    const pct = parseFloat(editValue);
    const bps = isNaN(pct) ? 0 : Math.round(Math.min(100, Math.max(0, pct)) * 100);
    onChange(redistribute(weights, categoryId, bps));
    setEditingId(null);
    setLiveBps(null);
  }

  function toggleLock(categoryId: string) {
    onChange(
      weights.map((n) => (n.categoryId === categoryId ? { ...n, isLocked: !n.isLocked } : n)),
    );
  }

  const rows = categories.map((cat, index) => {
    const bps = getWeightBps(cat.id);
    const currentPct = currentAllocation[cat.id] ?? 0;
    const targetPct = bps / 100;
    const drift = currentPct - targetPct;
    const bandPct = effectiveBandPct(bps, bandType, driftBandBps, relativeFactorBps);
    return {
      cat,
      bps,
      currentPct,
      targetPct,
      drift,
      bandPct,
      color: allocationTargetColor(cat.id, cat.name, index),
      isLocked: getIsLocked(cat.id),
      isEditing: editingId === cat.id,
    };
  });

  const biggestMove = [...rows]
    .filter((row) => Math.abs(row.drift) > row.bandPct)
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))[0];

  return (
    <div className="space-y-1 overflow-x-auto">
      <div className="min-w-[58rem]">
        {/* Column headers */}
        <div className="text-muted-foreground grid grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_4.25rem_5rem_6rem_28px] gap-4 border-b px-1 pb-2 text-[10px] font-medium uppercase tracking-wider">
          <span>{categoryLabel}</span>
          <span>{isChinese ? "当前与目标" : "Today vs target"}</span>
          <span className="text-right">{isChinese ? "当前" : "Current"}</span>
          <span className="text-right">{isChinese ? "目标" : "Target"}</span>
          <span className="text-right">{isChinese ? "偏离" : "Drift"}</span>
          <span />
        </div>

        {/* Category rows */}
        <div className="divide-y">
          {rows.map((row) => {
            const tone = driftTone(row.drift, row.bandPct, isChinese);
            return (
              <div
                key={row.cat.id}
                className="hover:bg-muted/30 group grid grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_4.25rem_5rem_6rem_28px] items-center gap-4 rounded px-1 py-3"
              >
                {/* Name */}
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: row.color }}
                  />
                  <span className="text-foreground truncate text-[13px] font-medium">
                    {translateClassificationLabel(language, row.cat.name)}
                  </span>
                </div>

                {/* Today vs target */}
                <div className="bg-muted/60 relative h-2 rounded-full">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, Math.max(0, row.currentPct))}%`,
                      background: row.color,
                      opacity: 0.58,
                    }}
                  />
                  <span
                    className="bg-foreground absolute top-1/2 h-5 w-px -translate-y-1/2 rounded-full"
                    style={{ left: `calc(${Math.min(100, Math.max(0, row.targetPct))}% - 1px)` }}
                  />
                </div>

                {/* Current % */}
                <span className="text-muted-foreground text-right text-[12px] tabular-nums">
                  {row.currentPct > 0 ? `${row.currentPct.toFixed(1)}%` : "—"}
                </span>

                {/* Target input */}
                <div className="flex items-center justify-end gap-0.5">
                  {row.isEditing ? (
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={editValue}
                      autoFocus
                      onChange={(e) => {
                        setEditValue(e.target.value);
                        const pct = parseFloat(e.target.value);
                        if (!isNaN(pct)) {
                          setLiveBps(Math.round(Math.min(100, Math.max(0, pct)) * 100));
                        }
                      }}
                      onBlur={() => {
                        if (skipBlurCommitRef.current) {
                          skipBlurCommitRef.current = false;
                          return;
                        }
                        commitEdit(row.cat.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(row.cat.id);
                        if (e.key === "Escape") {
                          skipBlurCommitRef.current = true;
                          setEditingId(null);
                          setLiveBps(null);
                        }
                      }}
                      className="border-primary bg-background focus:ring-primary w-12 rounded border px-1.5 py-1 text-right text-[13px] tabular-nums [appearance:textfield] focus:outline-none focus:ring-1 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEdit(row.cat.id)}
                      disabled={row.isLocked}
                      title={
                        row.isLocked
                          ? isChinese
                            ? "已锁定"
                            : "Locked"
                          : isChinese
                            ? "编辑目标"
                            : "Edit target"
                      }
                      className={cn(
                        "bg-background/45 inline-flex h-7 w-14 items-center justify-end rounded-md border px-2 text-right text-[13px] tabular-nums transition-colors",
                        row.isLocked
                          ? "border-border/40 text-muted-foreground cursor-not-allowed opacity-60"
                          : "border-border/70 text-foreground hover:border-foreground/45 hover:bg-muted/40 cursor-text",
                        row.bps > 0 ? "text-foreground font-medium" : "text-muted-foreground",
                      )}
                    >
                      {row.targetPct.toFixed(1)}
                    </button>
                  )}
                  <span className="text-muted-foreground text-[12px]">%</span>
                </div>

                {/* Drift */}
                <span
                  className={cn(
                    "justify-self-end rounded-md px-2 py-1 text-[11px] font-medium tabular-nums",
                    tone.className,
                  )}
                >
                  {tone.label}
                </span>

                {/* Lock */}
                <button
                  type="button"
                  onClick={() => toggleLock(row.cat.id)}
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded transition-colors",
                    row.isLocked
                      ? "text-foreground"
                      : "text-muted-foreground/40 hover:text-foreground opacity-0 group-hover:opacity-100",
                  )}
                  title={row.isLocked ? (isChinese ? "解锁" : "Unlock") : isChinese ? "锁定" : "Lock"}
                >
                  {row.isLocked ? (
                    <Icons.Lock className="h-3.5 w-3.5" />
                  ) : (
                    <Icons.LockOpen className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Total row */}
        <div className="border-t pt-3">
          <div className="grid grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)_4.25rem_5rem_6rem_28px] gap-4 px-1">
            <span className="text-[13px] font-medium">{isChinese ? "合计" : "Total"}</span>
            <span />
            <span />
            <span
              className={cn(
                "text-right text-[14px] font-semibold tabular-nums",
                isValid ? "text-green-700 dark:text-green-400" : "text-destructive",
              )}
            >
              {(totalBps / 100).toFixed(1)}%{isValid && " ✓"}
            </span>
            <span />
            <span />
          </div>
          {!isValid && (
            <p className="text-destructive mt-0.5 px-1 text-[11px]">
              {totalBps < 10000
                ? isChinese
                  ? `${((10000 - totalBps) / 100).toFixed(1)}% 未分配`
                  : `${((10000 - totalBps) / 100).toFixed(1)}% unallocated`
                : isChinese
                  ? `${((totalBps - 10000) / 100).toFixed(1)}% 超出 100%`
                  : `${((totalBps - 10000) / 100).toFixed(1)}% over 100%`}
            </p>
          )}
        </div>
        {biggestMove && (
          <p className="text-muted-foreground border-t px-1 pt-3 text-[12px]">
            {isChinese ? "最大调整：" : "Biggest move:"}{" "}
            <span className="text-foreground font-medium">
              {biggestMove.drift > 0
                ? isChinese
                  ? "减持"
                  : "trim"
                : isChinese
                  ? "增持"
                  : "add"}{" "}
              {translateClassificationLabel(language, biggestMove.cat.name)}{" "}
              {Math.abs(biggestMove.drift).toFixed(1)}%
            </span>
            .
          </p>
        )}
      </div>
    </div>
  );
}
