import { updateToolResult } from "@/adapters";
import { useBulkAssignCategories } from "@/features/spending/hooks/use-cash-activities";
import { QuickCategorizePopover } from "@/features/spending/components/quick-categorize-popover";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeContext } from "../../hooks/use-runtime-context";
import type {
  ProposeCategoriesArgs,
  ProposeCategoriesOutput,
  ProposeCategoryOption,
  ProposeCategoryProposal,
} from "../../types";
import { createActivityAmountFormatter, formatActivityAmount, formatActivityDate } from "./shared";

type CategorizationProposalsToolUIContentProps = ToolCallMessagePartProps<
  ProposeCategoriesArgs,
  ProposeCategoriesOutput
>;

interface RowDraft {
  activityId: string;
  activityDate: string;
  amount: number;
  currency: string;
  notes: string | null;
  taxonomyId: string;
  categoryId: string;
  categoryPath: string;
  categoryColor: string;
  confidence: number;
  source: string;
  explanation: string;
  selected: boolean;
}

function confidencePillClass(confidence: number): string {
  if (confidence >= 0.85) return "bg-success/15 text-success border-success/30";
  if (confidence >= 0.6) return "bg-warning/15 text-warning border-warning/30";
  return "bg-muted text-muted-foreground border-border";
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function ProposalsLoadingState() {
  const { t } = useTranslation();
  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardContent className="flex items-center gap-3 py-5">
        <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
          <Icons.Sparkles className="text-primary h-4 w-4 animate-pulse" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("ai:categorization.categorizing")}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t("ai:categorization.categorizingHint")}
          </p>
        </div>
        <Icons.Spinner className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />
      </CardContent>
    </Card>
  );
}

function CategorizationProposalsContentImpl({
  result,
  status,
  toolCallId,
}: CategorizationProposalsToolUIContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const runtime = useRuntimeContext();
  const threadId = runtime.currentThreadId;
  const amountFormatter = useMemo(() => createActivityAmountFormatter(), []);
  const bulkAssign = useBulkAssignCategories();

  const isLoading = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";

  const categoryColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const tax of result?.taxonomies ?? []) {
      for (const cat of tax.categories) {
        map.set(cat.categoryId, cat.color);
      }
    }
    return map;
  }, [result?.taxonomies]);

  const categoryPathMap = useMemo(() => {
    const map = new Map<string, ProposeCategoryOption & { taxonomyId: string }>();
    for (const tax of result?.taxonomies ?? []) {
      for (const cat of tax.categories) {
        map.set(cat.categoryId, { ...cat, taxonomyId: tax.taxonomyId });
      }
    }
    return map;
  }, [result?.taxonomies]);

  const initialRows = useMemo<RowDraft[]>(() => {
    if (!result) return [];
    return (result.proposals ?? []).map((p: ProposeCategoryProposal) => ({
      activityId: p.activityId,
      activityDate: p.activityDate,
      amount: p.amount,
      currency: p.currency,
      notes: p.notes,
      taxonomyId: p.taxonomyId,
      categoryId: p.categoryId,
      categoryPath: p.categoryPath,
      categoryColor: categoryColorMap.get(p.categoryId) ?? "#94a3b8",
      confidence: p.confidence,
      source: p.source,
      explanation: p.explanation,
      selected: p.confidence >= 0.6,
    }));
  }, [result, categoryColorMap]);

  const [rows, setRows] = useState<RowDraft[]>(initialRows);
  const [pickedUnproposedIds, setPickedUnproposedIds] = useState<Set<string>>(new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [localAppliedCount, setLocalAppliedCount] = useState<number | null>(null);

  useEffect(() => {
    setRows(initialRows);
    setPickedUnproposedIds(new Set());
  }, [initialRows]);

  const visibleUnproposed = useMemo(
    () => (result?.unproposed ?? []).filter((row) => !pickedUnproposedIds.has(row.activityId)),
    [result?.unproposed, pickedUnproposedIds],
  );

  const isSubmitted = localSubmitted || result?.submitted === true;
  const selectedCount = rows.filter((r) => r.selected).length;
  const isSubmitting = bulkAssign.isPending;
  const canSubmit = !isSubmitted && !isSubmitting && selectedCount > 0;
  const appliedCount = localAppliedCount ?? result?.appliedCount ?? 0;

  if (isLoading) return <ProposalsLoadingState />;

  if (isIncomplete) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">
            {t("ai:categorization.failedLoad")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">
            {t("ai:categorization.noProposals")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const summary = result.summary ?? {
    total: (result.proposals?.length ?? 0) + (result.unproposed?.length ?? 0),
    proposed: result.proposals?.length ?? 0,
    unproposed: result.unproposed?.length ?? 0,
    avgConfidence:
      (result.proposals?.length ?? 0) > 0
        ? result.proposals.reduce((acc, p) => acc + (p.confidence ?? 0), 0) /
          result.proposals.length
        : 0,
  };

  const toggleRow = (activityId: string) => {
    setRows((prev) =>
      prev.map((r) => (r.activityId === activityId ? { ...r, selected: !r.selected } : r)),
    );
  };

  const updateRowCategory = (activityId: string, taxonomyId: string, categoryId: string) => {
    const cat = categoryPathMap.get(categoryId);
    setRows((prev) =>
      prev.map((r) =>
        r.activityId === activityId
          ? {
              ...r,
              taxonomyId,
              categoryId,
              categoryPath: cat?.path ?? r.categoryPath,
              categoryColor: cat?.color ?? r.categoryColor,
              source: "manual",
              explanation: t("ai:categorization.editedByUser"),
              confidence: 1,
              selected: true,
            }
          : r,
      ),
    );
  };

  const handleAcceptAll = () => setRows((prev) => prev.map((r) => ({ ...r, selected: true })));
  const handleAcceptHighConfidence = () =>
    setRows((prev) => prev.map((r) => ({ ...r, selected: r.confidence >= 0.85 })));
  const handleRejectAll = () => setRows((prev) => prev.map((r) => ({ ...r, selected: false })));

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitError(null);

    const accepted = rows.filter((r) => r.selected);
    try {
      const applied = await bulkAssign.mutateAsync(
        accepted.map((r) => ({
          activityId: r.activityId,
          taxonomyId: r.taxonomyId,
          categoryId: r.categoryId,
        })),
      );

      setLocalSubmitted(true);
      setLocalAppliedCount(applied.length);

      if (threadId && toolCallId) {
        try {
          await updateToolResult({
            threadId,
            toolCallId,
            resultPatch: {
              submitted: true,
              draftStatus: "applied",
              appliedCount: applied.length,
              submittedAt: new Date().toISOString(),
            },
          });
        } catch (error) {
          console.error("Failed to persist categorization tool state:", error);
        }
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("ai:categorization.failedApply"));
    }
  };

  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">{t("ai:categorization.title")}</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("ai:categorization.summary", {
                proposed: summary.proposed,
                unproposed: summary.unproposed,
                confidence: Math.round((summary.avgConfidence ?? 0) * 100),
              })}
            </p>
          </div>
          <Badge variant="outline" className="text-xs">
            {t("ai:categorization.selected", { count: selectedCount })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-0 pb-3">
        {!isSubmitted && rows.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-6">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                checked={
                  selectedCount === 0
                    ? false
                    : selectedCount === rows.length
                      ? true
                      : "indeterminate"
                }
                onCheckedChange={(checked) =>
                  checked === true ? handleAcceptAll() : handleRejectAll()
                }
                aria-label={t("ai:categorization.selectAllRows")}
              />
              <span className="text-muted-foreground">
                {t("ai:categorization.selectAll", {
                  selected: selectedCount,
                  total: rows.length,
                })}
              </span>
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={handleAcceptHighConfidence}
              disabled={isSubmitting}
            >
              {t("ai:categorization.selectHighConfidence")}
            </Button>
          </div>
        )}

        <div className="max-h-[420px] overflow-y-auto px-2">
          {rows.length === 0 && visibleUnproposed.length === 0 && (
            <p className="text-muted-foreground px-4 py-6 text-center text-xs">
              {(result.taxonomies?.length ?? 0) === 0
                ? t("ai:categorization.noTaxonomies")
                : t("ai:categorization.noTransactions")}
            </p>
          )}

          {rows.map((row) => (
            <div
              key={row.activityId}
              className={cn(
                "hover:bg-background/50 flex items-center gap-3 rounded-md px-4 py-2 text-xs",
                row.selected && "bg-background/40",
              )}
            >
              <Checkbox
                checked={row.selected}
                onCheckedChange={() => toggleRow(row.activityId)}
                disabled={isSubmitted}
                aria-label={t("ai:categorization.selectRow")}
              />
              <span className="text-muted-foreground w-24 whitespace-nowrap tabular-nums">
                {formatActivityDate(row.activityDate)}
              </span>
              <span className="w-24 text-right tabular-nums">
                {formatActivityAmount(
                  row.amount,
                  amountFormatter,
                  isBalanceHidden,
                  row.currency || baseCurrency,
                )}
              </span>
              <span className="flex-1 truncate" title={row.notes ?? ""}>
                {row.notes ?? (
                  <span className="text-muted-foreground italic">
                    {t("ai:categorization.noNotes")}
                  </span>
                )}
              </span>
              <QuickCategorizePopover
                trigger={
                  <button
                    type="button"
                    className="hover:bg-muted/70 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
                    disabled={isSubmitted}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: row.categoryColor }}
                    />
                    <span className="max-w-[180px] truncate">{row.categoryPath}</span>
                  </button>
                }
                selectedCategoryId={row.categoryId}
                scope="both"
                onSelect={(taxonomyId, categoryId) =>
                  updateRowCategory(row.activityId, taxonomyId, categoryId)
                }
              />
              <Badge
                variant="outline"
                className={cn("text-[10px] uppercase", confidencePillClass(row.confidence))}
                title={row.explanation}
              >
                {confidenceLabel(row.confidence)}
              </Badge>
            </div>
          ))}

          {visibleUnproposed.length > 0 && (
            <div className="mt-3 border-t pt-2">
              <p className="text-muted-foreground px-4 pb-1 text-[11px] uppercase tracking-wide">
                {t("ai:categorization.needsManualChoice", { count: visibleUnproposed.length })}
              </p>
              {visibleUnproposed.map((row) => (
                <div
                  key={row.activityId}
                  className="hover:bg-background/40 flex items-center gap-3 rounded-md px-4 py-2 text-xs"
                >
                  <span className="w-5" />
                  <span className="text-muted-foreground w-24 whitespace-nowrap tabular-nums">
                    {formatActivityDate(row.activityDate)}
                  </span>
                  <span className="w-24 text-right tabular-nums">
                    {formatActivityAmount(
                      row.amount,
                      amountFormatter,
                      isBalanceHidden,
                      row.currency || baseCurrency,
                    )}
                  </span>
                  <span className="flex-1 truncate" title={row.notes ?? ""}>
                    {row.notes ?? (
                      <span className="text-muted-foreground italic">
                        {t("ai:categorization.noNotes")}
                      </span>
                    )}
                  </span>
                  <QuickCategorizePopover
                    trigger={
                      <button
                        type="button"
                        className="text-muted-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px]"
                      >
                        <Icons.Plus className="h-3 w-3" />
                        {t("ai:categorization.pickCategory")}
                      </button>
                    }
                    scope="both"
                    onSelect={(taxonomyId, categoryId) => {
                      const cat = categoryPathMap.get(categoryId);
                      setPickedUnproposedIds((prev) => {
                        const next = new Set(prev);
                        next.add(row.activityId);
                        return next;
                      });
                      setRows((prev) => [
                        ...prev,
                        {
                          activityId: row.activityId,
                          activityDate: row.activityDate,
                          amount: row.amount,
                          currency: row.currency,
                          notes: row.notes,
                          taxonomyId,
                          categoryId,
                          categoryPath: cat?.path ?? "",
                          categoryColor: cat?.color ?? "#94a3b8",
                          confidence: 1,
                          source: "manual",
                          explanation: t("ai:categorization.pickedManually"),
                          selected: true,
                        },
                      ]);
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {submitError && (
          <div className="mx-6">
            <Alert variant="error">
              <Icons.AlertCircle className="h-4 w-4" />
              <AlertTitle>{t("ai:categorization.failedApplyTitle")}</AlertTitle>
              <AlertDescription className="break-words text-xs">{submitError}</AlertDescription>
            </Alert>
          </div>
        )}

        {isSubmitted && (
          <div className="px-6">
            <div className="border-success/30 bg-success/10 flex items-center gap-3 rounded-md border px-3 py-2">
              <div className="bg-success/20 text-success flex h-7 w-7 shrink-0 items-center justify-center rounded-full">
                <Icons.Check className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-success text-sm font-medium">
                  {t("ai:categorization.transactionsCategorized", { count: appliedCount })}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("ai:categorization.categoriesSaved")}
                </p>
              </div>
            </div>
          </div>
        )}

        {!isSubmitted && rows.length > 0 && (
          <div className="flex items-center justify-end px-6 pt-1">
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {isSubmitting ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Icons.Check className="mr-2 h-4 w-4" />
              )}
              {selectedCount > 0
                ? t("ai:categorization.applySelected", { count: selectedCount })
                : t("ai:categorization.apply")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const CategorizationProposalsContent = memo(CategorizationProposalsContentImpl);

export const CategorizationProposalsToolUI = makeAssistantToolUI<
  ProposeCategoriesArgs,
  ProposeCategoriesOutput
>({
  toolName: "propose_transaction_categories",
  render: (props) => {
    return <CategorizationProposalsContent {...props} />;
  },
});
