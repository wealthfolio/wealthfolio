import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Button,
  formatCurrencySymbol,
  Icons,
  Input,
  MoneyInput,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import { QuickCategorizePopover, type QuickCategorizeScope } from "./quick-categorize-popover";
import {
  canDistributeSplitCents,
  centsToAmount,
  distributeEvenlyCents,
  distributeRemainingCents,
  toCents,
} from "../lib/split-utils";
import type { TransactionRowVM } from "../lib/transactions-helpers";
import type { NewActivitySplit } from "../types/cash-activity";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";
const SPLIT_LINE_COLORS = ["#8b5cf6", "#3fa894", "#c68c2f", "#3b82f6", "#d95f78"];

interface SplitLineState {
  id: string;
  taxonomyId: string;
  categoryId: string;
  amount: number | undefined;
  note: string;
}

interface SplitTransactionSheetProps {
  open: boolean;
  row: TransactionRowVM | null;
  categories: Map<string, TaxonomyCategory>;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (activityId: string, splits: NewActivitySplit[]) => Promise<void>;
  onClear: (activityId: string) => Promise<void>;
}

function taxonomyForBucket(bucket: string | undefined): string | null {
  if (bucket === "spending") return SPENDING_TAXONOMY;
  if (bucket === "income") return INCOME_TAXONOMY;
  if (bucket === "saving") return SAVINGS_TAXONOMY;
  return null;
}

function scopeForTaxonomy(taxonomyId: string | null): QuickCategorizeScope {
  if (taxonomyId === INCOME_TAXONOMY) return "income";
  if (taxonomyId === SAVINGS_TAXONOMY) return "saving";
  return "expense";
}

function makeLine(taxonomyId: string, categoryId = "", amount?: number, note = ""): SplitLineState {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    taxonomyId,
    categoryId,
    amount,
    note,
  };
}

function categoryLabel(
  category: TaxonomyCategory | undefined,
  categories: Map<string, TaxonomyCategory>,
) {
  if (!category) return null;
  const parent = category.parentId ? categories.get(category.parentId) : null;
  return parent ? `${parent.name} / ${category.name}` : category.name;
}

function formatCents(cents: number) {
  const prefix = cents < 0 ? "-" : "";
  return `${prefix}${centsToAmount(Math.abs(cents)).toFixed(2)}`;
}

function fallbackLineColor(index: number) {
  return SPLIT_LINE_COLORS[index % SPLIT_LINE_COLORS.length];
}

function splitLineColor(category: TaxonomyCategory | undefined, index: number) {
  return category?.color || fallbackLineColor(index);
}

function linePercentage(lineCents: number, totalCents: number) {
  if (totalCents <= 0) return 0;
  return Math.round((Math.max(lineCents, 0) / totalCents) * 100);
}

export function SplitTransactionSheet({
  open,
  row,
  categories,
  isSaving,
  onOpenChange,
  onSave,
  onClear,
}: SplitTransactionSheetProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const activity = row?.activity ?? null;
  const taxonomyId = taxonomyForBucket(activity?.cashFlowBucket);
  const totalCents = toCents(activity?.amount);
  const totalAmount = Math.abs(totalCents) / 100;
  const currencySymbol = formatCurrencySymbol(activity?.currency);

  const [lines, setLines] = useState<SplitLineState[]>([]);
  const [expandedNoteLineIds, setExpandedNoteLineIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || !row || !taxonomyId) return;
    setExpandedNoteLineIds(new Set());
    const existing = (row.activity.splits ?? [])
      .filter((split) => split.taxonomyId === taxonomyId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    if (existing.length > 0) {
      setLines(
        existing.map((split) =>
          makeLine(
            split.taxonomyId,
            split.categoryId,
            Math.abs(Number(split.amount)),
            split.note ?? "",
          ),
        ),
      );
      return;
    }
    if (row.category) {
      setLines([makeLine(row.category.taxonomyId, row.category.id, totalAmount)]);
      return;
    }
    setLines([makeLine(taxonomyId, "", totalAmount)]);
  }, [open, row, taxonomyId, totalAmount]);

  const assignedCents = useMemo(
    () => lines.reduce((sum, line) => sum + toCents(line.amount), 0),
    [lines],
  );
  const totalAbsCents = Math.abs(totalCents);
  const remainingCents = totalAbsCents - assignedCents;
  const emptyAmountIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => toCents(line.amount) <= 0)
    .map(({ index }) => index);
  const hasInvalidLine = lines.some((line) => !line.categoryId || toCents(line.amount) <= 0);
  const canSave =
    !!activity && !!taxonomyId && lines.length > 0 && !hasInvalidLine && remainingCents === 0;
  const canDistribute = canDistributeSplitCents(
    totalAbsCents,
    assignedCents,
    emptyAmountIndexes.length,
    lines.length,
  );
  const allocationSegments = useMemo(() => {
    const lineSegments = lines
      .map((line, index) => {
        const amountCents = Math.max(toCents(line.amount), 0);
        const category = categories.get(line.categoryId);
        return {
          id: line.id,
          amountCents,
          color: splitLineColor(category, index),
        };
      })
      .filter((segment) => segment.amountCents > 0);
    const remainingPositiveCents = Math.max(remainingCents, 0);
    return remainingPositiveCents > 0
      ? [
          ...lineSegments,
          {
            id: "remaining",
            amountCents: remainingPositiveCents,
            color: "var(--muted)",
          },
        ]
      : lineSegments;
  }, [categories, lines, remainingCents]);
  const hasExistingSplits = (row?.splitCount ?? 0) > 0;

  const updateLine = (id: string, patch: Partial<SplitLineState>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const handleAddLine = () => {
    if (!taxonomyId) return;
    setLines((current) => [...current, makeLine(taxonomyId)]);
  };

  const handleRemoveLine = (id: string) => {
    setLines((current) =>
      current.length > 1 ? current.filter((line) => line.id !== id) : current,
    );
    setExpandedNoteLineIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const handleShowNote = (id: string) => {
    setExpandedNoteLineIds((current) => new Set(current).add(id));
  };

  const handleDistribute = () => {
    if (!canDistribute) return;
    if (remainingCents > 0) {
      const amounts = distributeRemainingCents(
        totalAbsCents,
        assignedCents,
        emptyAmountIndexes.length,
      );
      setLines((current) =>
        current.map((line, index) => {
          const emptyIndex = emptyAmountIndexes.indexOf(index);
          return emptyIndex >= 0 ? { ...line, amount: centsToAmount(amounts[emptyIndex]) } : line;
        }),
      );
      return;
    }

    const amounts = distributeEvenlyCents(totalAbsCents, lines.length);
    setLines((current) =>
      current.map((line, index) => ({ ...line, amount: centsToAmount(amounts[index]) })),
    );
  };

  const handleSave = async () => {
    if (!canSave || !activity || !taxonomyId) return;
    await onSave(
      activity.id,
      lines.map((line, index) => ({
        taxonomyId,
        categoryId: line.categoryId,
        amount: (line.amount ?? 0).toFixed(2),
        note: line.note.trim() || null,
        sortOrder: index,
      })),
    );
    onOpenChange(false);
  };

  const handleClear = async () => {
    if (!activity) return;
    await onClear(activity.id);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "flex w-full flex-col overflow-hidden",
          isMobile ? "rounded-t-4xl mx-1 h-[90vh] gap-0 p-0" : "sm:max-w-xl",
        )}
      >
        <SheetHeader className={cn(isMobile && "border-border border-b px-6 py-4 text-left")}>
          <SheetTitle>{t("spending:split.title")}</SheetTitle>
          <SheetDescription>
            {activity?.notes ?? t("spending:split.transactionFallback")} ·{" "}
            {activity?.currency ?? ""}
          </SheetDescription>
        </SheetHeader>

        <div className={cn("min-h-0 flex-1 overflow-y-auto", isMobile ? "px-4" : "px-1")}>
          <div className="space-y-4 py-4">
            <div className="bg-muted/50 flex items-center justify-between rounded-2xl px-4 py-4">
              <span className="text-muted-foreground text-sm">
                {t("spending:split.remainingOf", {
                  amount: `${currencySymbol}${formatCents(totalAbsCents)}`,
                })}
              </span>
              <span
                className={cn(
                  "font-mono text-lg font-semibold tabular-nums",
                  remainingCents === 0
                    ? "text-success"
                    : remainingCents < 0
                      ? "text-destructive"
                      : "text-foreground",
                )}
              >
                {formatCents(remainingCents)} {activity?.currency}
              </span>
            </div>

            <div className="flex h-4 overflow-hidden rounded-full">
              {allocationSegments.length > 0 ? (
                allocationSegments.map((segment, index) => (
                  <span
                    key={segment.id}
                    className={cn(index > 0 && "ml-1")}
                    style={{
                      flexBasis: 0,
                      flexGrow: segment.amountCents,
                      backgroundColor: segment.color,
                    }}
                    aria-hidden="true"
                  />
                ))
              ) : (
                <span className="bg-muted h-full w-full" aria-hidden="true" />
              )}
            </div>
          </div>

          <div className="border-border divide-border divide-y border-y">
            {lines.map((line, index) => {
              const category = categories.get(line.categoryId);
              const label = categoryLabel(category, categories);
              const color = splitLineColor(category, index);
              const amountCents = toCents(line.amount);
              const showNoteInput = line.note.trim().length > 0 || expandedNoteLineIds.has(line.id);
              return (
                <div key={line.id} className="py-2.5">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_96px_32px] items-start gap-2">
                    <div className="min-w-0">
                      <QuickCategorizePopover
                        scope={scopeForTaxonomy(taxonomyId)}
                        selectedCategoryId={line.categoryId || null}
                        onSelect={(nextTaxonomyId, categoryId) =>
                          updateLine(line.id, { taxonomyId: nextTaxonomyId, categoryId })
                        }
                        trigger={
                          <button
                            type="button"
                            className="hover:text-foreground flex h-7 min-w-0 max-w-full items-center gap-2 text-left transition-colors"
                          >
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: color }}
                              aria-hidden="true"
                            />
                            <span
                              className={cn(
                                "min-w-0 truncate text-sm font-medium",
                                !label && "text-muted-foreground",
                              )}
                            >
                              {label ?? t("spending:filters.category")}
                            </span>
                            <Icons.ChevronDown
                              className="text-muted-foreground h-3.5 w-3.5 shrink-0"
                              aria-hidden="true"
                            />
                          </button>
                        }
                      />

                      {showNoteInput ? (
                        <Input
                          value={line.note}
                          onChange={(event) => updateLine(line.id, { note: event.target.value })}
                          placeholder={t("spending:split.note")}
                          className="bg-muted/40 ml-5 mt-1 !h-7 rounded-md border-0 px-2 text-xs shadow-none md:text-xs"
                        />
                      ) : (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground ml-5 mt-1 inline-flex h-5 items-center gap-1.5 text-xs font-medium transition-colors"
                          onClick={() => handleShowNote(line.id)}
                        >
                          <Icons.Plus className="h-3 w-3" aria-hidden="true" />
                          {t("spending:split.noteLower")}
                        </button>
                      )}
                    </div>

                    <span className="bg-muted/60 text-muted-foreground inline-flex h-8 items-center rounded-md px-2 text-xs font-medium tabular-nums">
                      {linePercentage(amountCents, totalAbsCents)}%
                    </span>
                    <div className="relative w-24">
                      <span className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs">
                        {currencySymbol}
                      </span>
                      <MoneyInput
                        value={line.amount ?? 0}
                        onValueChange={(value: number | undefined) =>
                          updateLine(line.id, { amount: value ?? undefined })
                        }
                        placeholder="0.00"
                        className="bg-background hover:bg-muted !h-8 rounded-md px-2 pl-5 text-right text-sm shadow-none transition-colors focus-visible:ring-2 md:text-sm"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground h-8 w-8"
                      onClick={() => handleRemoveLine(line.id)}
                      disabled={lines.length <= 1}
                      aria-label={t("spending:split.removeLine", { number: index + 1 })}
                    >
                      <Icons.X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2 py-4">
            <Button type="button" variant="outline" size="sm" onClick={handleAddLine}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("spending:split.addLine")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDistribute}
              disabled={!canDistribute}
            >
              <Icons.SplitHorizontal className="mr-2 h-4 w-4" />
              {t("spending:split.distributeEvenly")}
            </Button>
          </div>
        </div>

        <SheetFooter
          className={cn(
            "border-t",
            isMobile
              ? "border-border px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]"
              : "gap-2 pt-4",
          )}
        >
          {isMobile ? (
            <div className="flex w-full flex-col gap-2">
              <Button type="button" onClick={handleSave} disabled={!canSave || isSaving}>
                {isSaving && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
                {t("common:save")}
              </Button>
              <div className="flex gap-2">
                {hasExistingSplits && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleClear}
                    disabled={isSaving}
                    className="flex-1"
                  >
                    {t("spending:split.clearSplit")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isSaving}
                  className="flex-1"
                >
                  {t("common:cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {hasExistingSplits && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClear}
                  disabled={isSaving}
                  className="mr-auto"
                >
                  {t("spending:split.clearSplit")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSaving}
              >
                {t("common:cancel")}
              </Button>
              <Button type="button" onClick={handleSave} disabled={!canSave || isSaving}>
                {isSaving && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
                {t("common:save")}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
