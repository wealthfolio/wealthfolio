import { updateToolResult } from "@/adapters";
import { TickerAvatar } from "@/components/ticker-avatar";
import { useReplaceAssetTaxonomyAssignments } from "@/hooks/use-taxonomies";
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
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useRuntimeContext } from "../../hooks/use-runtime-context";
import type {
  AssetClassificationAssignmentPreview,
  AssetClassificationResolvedAsset,
  PrepareAssetClassificationArgs,
  PrepareAssetClassificationOutput,
} from "../../types";
import {
  buildAssetClassificationApplyPlan,
  formatBasisPoints,
} from "./asset-classification-tool-utils";

type AssetClassificationToolUIContentProps = ToolCallMessagePartProps<
  PrepareAssetClassificationArgs,
  PrepareAssetClassificationOutput
>;

type UnknownRecord = Record<string, unknown>;

// Selection can be clicked while the streamed assistant message is still being persisted.
const TOOL_RESULT_PATCH_RETRY_DELAYS_MS = [500, 1500, 3000, 6000];

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

async function updateToolResultWithRetry(
  request: Parameters<typeof updateToolResult>[0],
  retryDelaysMs = TOOL_RESULT_PATCH_RETRY_DELAYS_MS,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await updateToolResult(request);
      return;
    } catch (error) {
      lastError = error;
      const retryDelay = retryDelaysMs[attempt];
      if (retryDelay === undefined) break;
      await delay(retryDelay);
    }
  }
  throw lastError;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeAssetClassificationResult(value: UnknownRecord): boolean {
  return (
    "assetQuery" in value ||
    "taxonomy" in value ||
    "resolvedAsset" in value ||
    "assetCandidates" in value ||
    "currentAssignments" in value ||
    "proposedAssignments" in value ||
    "draftStatus" in value
  );
}

function normalizeAssetClassificationResult(
  value: unknown,
): PrepareAssetClassificationOutput | undefined {
  if (!value) return undefined;

  if (typeof value === "string") {
    try {
      return normalizeAssetClassificationResult(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  if (!isRecord(value)) return undefined;

  if ("data" in value) {
    const normalized = normalizeAssetClassificationResult(value.data);
    if (normalized) return normalized;
  }

  if (looksLikeAssetClassificationResult(value)) {
    return value as unknown as PrepareAssetClassificationOutput;
  }

  return undefined;
}

function extractToolResultError(value: unknown, t: TFunction): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    try {
      return extractToolResultError(JSON.parse(value), t) ?? friendlyToolError(value, t);
    } catch {
      return friendlyToolError(value, t);
    }
  }

  if (!isRecord(value)) return null;

  if ("data" in value) {
    const dataError = extractToolResultError(value.data, t);
    if (dataError) return dataError;
  }

  if (typeof value.error === "string") return friendlyToolError(value.error, t);
  if (typeof value.message === "string") return friendlyToolError(value.message, t);
  if (typeof value.content === "string") return friendlyToolError(value.content, t);

  return null;
}

function cleanToolError(raw: string): string {
  return raw
    .replace(/^Toolset error:\s*/i, "")
    .replace(/ToolCallError:\s*/g, "")
    .replace(/^Tool execution failed:\s*/i, "")
    .replace(/^JsonError:\s*/i, "")
    .trim();
}

function friendlyToolError(raw: string, t: TFunction): string {
  const cleaned = cleanToolError(raw);
  const lower = cleaned.toLowerCase();

  if (
    lower.includes("__placeholder__") ||
    lower.includes("asset-scoped taxonomy") ||
    lower.includes("taxonomy filter")
  ) {
    return t("ai:assetClassification.matchTaxonomyError");
  }

  if (lower.includes("unknown") && lower.includes("category")) {
    return t("ai:assetClassification.unknownSliceError");
  }

  if (lower.includes("residual bucket") && lower.includes("cannot be mapped")) {
    return t("ai:assetClassification.residualBucketError");
  }

  if (lower.includes("does not belong to the selected taxonomy")) {
    return t("ai:assetClassification.notInTaxonomyError");
  }

  if (lower.includes("duplicate category")) {
    return t("ai:assetClassification.duplicateCategoryError");
  }

  if (lower.includes("ambiguous")) {
    return t("ai:assetClassification.ambiguousError");
  }

  return t("ai:assetClassification.genericError");
}

function AssetClassificationLoadingState() {
  const { t } = useTranslation();
  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardContent className="flex items-center gap-3 py-5">
        <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
          <Icons.Sparkles className="text-primary h-4 w-4 animate-pulse" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("ai:assetClassification.preparing")}</p>
        </div>
        <Icons.Spinner className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />
      </CardContent>
    </Card>
  );
}

function InlineToolError({ label }: { label: string }) {
  return (
    <div role="status" className="text-destructive flex items-start gap-2 px-1 text-sm font-medium">
      <Icons.AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="break-words">{label}</span>
    </div>
  );
}

function validatePreview(
  result: PrepareAssetClassificationOutput | undefined,
  t: TFunction,
): string[] {
  if (!result) return [t("ai:assetClassification.noDraftResult")];

  const issues: string[] = [];
  const proposedAssignments = result.proposedAssignments ?? [];
  const categoryIds = new Set<string>();
  for (const row of proposedAssignments) {
    if (row.weightBasisPoints < 0 || row.weightBasisPoints > 10000) {
      issues.push(t("ai:assetClassification.invalidWeight", { categoryName: row.categoryName }));
    }

    if (row.weightBasisPoints === 0) continue;

    if (categoryIds.has(row.categoryId)) {
      issues.push(
        t("ai:assetClassification.duplicateCategory", { categoryName: row.categoryName }),
      );
    }
    categoryIds.add(row.categoryId);
  }

  if (result.unallocatedBasisPoints < 0) {
    issues.push(t("ai:assetClassification.weightsExceed"));
  }

  const effectiveProposedAssignments = proposedAssignments.filter(
    (row) => row.weightBasisPoints > 0,
  );

  if (result.taxonomy?.isSingleSelect && effectiveProposedAssignments.length > 1) {
    issues.push(t("ai:assetClassification.singleSelectMultiple"));
  }

  const singleSelectRow = result.taxonomy?.isSingleSelect ? effectiveProposedAssignments[0] : null;
  if (singleSelectRow && singleSelectRow.weightBasisPoints !== 10000) {
    issues.push(t("ai:assetClassification.singleSelectFullWeight"));
  }

  return issues;
}

function validateEditedPreview(
  result: PrepareAssetClassificationOutput | undefined,
  proposedAssignments: AssetClassificationAssignmentPreview[],
  unallocatedBasisPoints: number,
  t: TFunction,
): string[] {
  if (!result) return [t("ai:assetClassification.noDraftResult")];

  return validatePreview(
    {
      ...result,
      proposedAssignments,
      unallocatedBasisPoints,
    },
    t,
  );
}

function basisPointsToPercentInput(weightBasisPoints: number): string {
  const percent = weightBasisPoints / 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
}

function percentInputToBasisPoints(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(10000, Math.max(0, Math.round(parsed * 100)));
}

function sumPositiveWeights(rows: AssetClassificationAssignmentPreview[]): number {
  return rows.reduce(
    (sum, row) => sum + (row.weightBasisPoints > 0 ? row.weightBasisPoints : 0),
    0,
  );
}

function DiffStat({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className="bg-background/70 min-w-[5rem] rounded-md border px-2 py-1.5">
      <div className={cn("text-sm font-semibold", className)}>{value}</div>
      <div className="text-muted-foreground text-[11px] leading-4">{label}</div>
    </div>
  );
}

interface ClassificationComparisonRow {
  categoryId: string;
  categoryName: string;
  categoryKey: string;
  categoryColor?: string | null;
  currentWeightBasisPoints: number;
  newWeightBasisPoints: number;
  status: "add" | "update" | "remove" | "same";
}

function buildComparisonRows(
  currentRows: AssetClassificationAssignmentPreview[],
  proposedRows: AssetClassificationAssignmentPreview[],
): ClassificationComparisonRow[] {
  const effectiveProposedRows = proposedRows.filter((row) => row.weightBasisPoints > 0);
  const currentByCategory = new Map(currentRows.map((row) => [row.categoryId, row]));
  const proposedByCategory = new Map(effectiveProposedRows.map((row) => [row.categoryId, row]));
  const rows: ClassificationComparisonRow[] = [];

  for (const proposed of effectiveProposedRows) {
    const current = currentByCategory.get(proposed.categoryId);
    const isSame =
      current?.weightBasisPoints === proposed.weightBasisPoints && current?.source === "ai";
    rows.push({
      categoryId: proposed.categoryId,
      categoryName: proposed.categoryName,
      categoryKey: proposed.categoryKey,
      categoryColor: proposed.categoryColor ?? current?.categoryColor,
      currentWeightBasisPoints: current?.weightBasisPoints ?? 0,
      newWeightBasisPoints: proposed.weightBasisPoints,
      status: current ? (isSame ? "same" : "update") : "add",
    });
  }

  for (const current of currentRows) {
    if (proposedByCategory.has(current.categoryId)) continue;
    rows.push({
      categoryId: current.categoryId,
      categoryName: current.categoryName,
      categoryKey: current.categoryKey,
      categoryColor: current.categoryColor,
      currentWeightBasisPoints: current.weightBasisPoints,
      newWeightBasisPoints: 0,
      status: "remove",
    });
  }

  return rows;
}

function ClassificationComparisonTable({
  currentRows,
  proposedRows,
  emptyLabel,
  disabled,
  draftPercentValues,
  onDraftPercentValueChange,
  onNewWeightChange,
}: {
  currentRows: AssetClassificationAssignmentPreview[];
  proposedRows: AssetClassificationAssignmentPreview[];
  emptyLabel: string;
  disabled: boolean;
  draftPercentValues: Record<string, string>;
  onDraftPercentValueChange: (categoryId: string, value: string) => void;
  onNewWeightChange: (row: ClassificationComparisonRow, weightBasisPoints: number) => void;
}) {
  const { t } = useTranslation();
  const rows = buildComparisonRows(currentRows, proposedRows);
  const currentTotalBasisPoints = currentRows.reduce((sum, row) => sum + row.weightBasisPoints, 0);
  const proposedTotalBasisPoints = rows.reduce(
    (sum, row) => sum + Math.max(row.newWeightBasisPoints, 0),
    0,
  );

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-muted-foreground text-xs font-medium">
        {t("ai:assetClassification.allocation")}
      </div>
      <div className="bg-background/70 overflow-hidden rounded-md border">
        <div className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_4.25rem_4.25rem] gap-2 border-b px-2.5 py-1.5 text-[11px] font-medium sm:grid-cols-[minmax(0,1fr)_5.25rem_5.25rem]">
          <div>{t("ai:assetClassification.section")}</div>
          <div className="text-right">{t("ai:assetClassification.current")}</div>
          <div className="text-right">{t("ai:assetClassification.new")}</div>
        </div>
        {rows.length === 0 ? (
          <div className="text-muted-foreground px-3 py-3 text-xs">{emptyLabel}</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.categoryId}
              className="grid grid-cols-[minmax(0,1fr)_4.25rem_4.25rem] items-center gap-2 border-b px-2.5 py-1.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_5.25rem_5.25rem]"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="bg-muted-foreground/40 size-2 shrink-0 rounded-full"
                  style={row.categoryColor ? { backgroundColor: row.categoryColor } : undefined}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium sm:text-sm">{row.categoryName}</div>
                </div>
              </div>
              <div className="text-right">
                <span
                  aria-label={t("ai:assetClassification.currentPercentLabel", {
                    categoryName: row.categoryName,
                  })}
                  className={cn(
                    "bg-muted/60 inline-flex min-w-[3.75rem] justify-end rounded-md px-1.5 py-0.5 text-xs font-medium sm:min-w-[4.5rem]",
                    row.currentWeightBasisPoints === 0 && "text-muted-foreground",
                  )}
                >
                  {formatBasisPoints(row.currentWeightBasisPoints)}
                </span>
              </div>
              <div className="text-right">
                <div
                  className={cn(
                    "bg-background relative inline-flex min-w-[3.75rem] items-center rounded-md border sm:min-w-[4.5rem]",
                    row.status === "add" && "text-success",
                    row.status === "update" && "text-primary",
                    row.status === "remove" && "text-destructive",
                    row.status === "same" && "text-muted-foreground",
                    disabled && "opacity-70",
                  )}
                >
                  <input
                    aria-label={t("ai:assetClassification.newPercentLabel", {
                      categoryName: row.categoryName,
                    })}
                    className="h-6 w-full bg-transparent pl-1.5 pr-4 text-right text-xs font-medium outline-none disabled:cursor-not-allowed"
                    disabled={disabled}
                    inputMode="decimal"
                    type="text"
                    value={
                      draftPercentValues[row.categoryId] ??
                      basisPointsToPercentInput(row.newWeightBasisPoints)
                    }
                    onBlur={(event) => {
                      const basisPoints = percentInputToBasisPoints(event.currentTarget.value);
                      onDraftPercentValueChange(
                        row.categoryId,
                        basisPointsToPercentInput(basisPoints ?? row.newWeightBasisPoints),
                      );
                    }}
                    onChange={(event) => {
                      const nextValue = event.currentTarget.value.replace(/,/g, "");
                      if (!/^\d*\.?\d*$/.test(nextValue)) return;

                      onDraftPercentValueChange(row.categoryId, nextValue);

                      const basisPoints = percentInputToBasisPoints(nextValue);
                      if (basisPoints === null) return;
                      onNewWeightChange(row, basisPoints);
                    }}
                  />
                  <span className="pointer-events-none absolute right-1.5 text-[10px]">%</span>
                </div>
              </div>
            </div>
          ))
        )}
        {rows.length > 0 ? (
          <div className="bg-muted/50 grid grid-cols-[minmax(0,1fr)_4.25rem_4.25rem] items-center gap-2 px-2.5 py-1.5 sm:grid-cols-[minmax(0,1fr)_5.25rem_5.25rem]">
            <div className="text-muted-foreground text-right text-xs font-medium">
              {t("ai:assetClassification.total")}
            </div>
            <div className="text-right text-sm font-semibold">
              {formatBasisPoints(currentTotalBasisPoints)}
            </div>
            <div className="text-primary text-right text-sm font-semibold">
              {formatBasisPoints(proposedTotalBasisPoints)}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatExistingAllocation(rows: AssetClassificationAssignmentPreview[], t: TFunction) {
  if (rows.length === 0) return t("ai:assetClassification.noExistingAllocation");

  const totalBasisPoints = rows.reduce((sum, row) => sum + row.weightBasisPoints, 0);
  return t("ai:assetClassification.existingAllocation", {
    count: rows.length,
    total: formatBasisPoints(totalBasisPoints),
  });
}

export function AssetClassificationToolUIContentImpl({
  result,
  status,
  toolCallId,
}: AssetClassificationToolUIContentProps) {
  const { t } = useTranslation();
  const runtime = useRuntimeContext();
  const threadId = runtime.currentThreadId;
  const replaceAssetTaxonomyAssignments = useReplaceAssetTaxonomyAssignments();
  const [localApplied, setLocalApplied] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [persistError, setPersistError] = useState(false);
  const [localSelectedAssetId, setLocalSelectedAssetId] = useState<string | null>(null);
  const [editedProposedAssignments, setEditedProposedAssignments] = useState<
    AssetClassificationAssignmentPreview[] | null
  >(null);
  const [draftPercentValues, setDraftPercentValues] = useState<Record<string, string>>({});
  const parsedResult = useMemo(() => normalizeAssetClassificationResult(result), [result]);
  const proposedAssignments = editedProposedAssignments ?? parsedResult?.proposedAssignments ?? [];
  const unallocated = 10000 - sumPositiveWeights(proposedAssignments);
  const validationIssues = useMemo(
    () => validateEditedPreview(parsedResult, proposedAssignments, unallocated, t),
    [parsedResult, proposedAssignments, unallocated, t],
  );

  if (status?.type === "running") return <AssetClassificationLoadingState />;

  if (status?.type === "incomplete") {
    return <InlineToolError label={t("ai:assetClassification.failedPrepareDraft")} />;
  }

  if (!result) return null;

  if (!parsedResult) {
    const toolError = extractToolResultError(result, t);
    return <InlineToolError label={toolError ?? t("ai:assetClassification.couldNotReadDraft")} />;
  }

  const resolvedAsset = parsedResult.resolvedAsset ?? null;
  const assetCandidates = parsedResult.assetCandidates ?? [];
  const candidateCurrentAssignments = parsedResult.candidateCurrentAssignments ?? [];
  const selectedAssetId =
    localSelectedAssetId ??
    parsedResult.selectedAssetId ??
    parsedResult.selectedAsset?.assetId ??
    resolvedAsset?.assetId ??
    null;
  const selectedAsset =
    resolvedAsset ??
    assetCandidates.find((candidate) => candidate.assetId === selectedAssetId) ??
    (parsedResult.selectedAsset?.assetId === selectedAssetId ? parsedResult.selectedAsset : null) ??
    null;
  const selectedCandidateAssignments = candidateCurrentAssignments.find(
    (candidate) => candidate.assetId === selectedAssetId,
  );
  const currentAssignments = resolvedAsset
    ? (parsedResult.currentAssignments ?? [])
    : (selectedCandidateAssignments?.currentAssignments ?? []);
  const plan = buildAssetClassificationApplyPlan(currentAssignments, proposedAssignments);
  const isApplied = localApplied || parsedResult.draftStatus === "applied";
  const isSubmitting = replaceAssetTaxonomyAssignments.isPending;
  const isValid = validationIssues.length === 0;
  const canConfirm =
    Boolean(selectedAsset) && !isApplied && !isSubmitting && isValid && plan.hasChanges;
  const appliedAt = parsedResult.appliedAt
    ? new Date(parsedResult.appliedAt).toLocaleString()
    : null;
  const appliedCategoryCount = proposedAssignments.filter(
    (assignment) => assignment.weightBasisPoints > 0,
  ).length;

  const handleDraftPercentValueChange = (categoryId: string, value: string) => {
    setDraftPercentValues((current) => ({
      ...current,
      [categoryId]: value,
    }));
  };

  const handleNewWeightChange = (row: ClassificationComparisonRow, weightBasisPoints: number) => {
    setEditedProposedAssignments((current) => {
      const base = current ?? parsedResult.proposedAssignments ?? [];
      const existing = base.find((assignment) => assignment.categoryId === row.categoryId);
      const nextAssignment: AssetClassificationAssignmentPreview = {
        assignmentId: existing?.assignmentId ?? null,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        categoryKey: row.categoryKey,
        categoryColor: row.categoryColor,
        weightBasisPoints,
        source: "ai",
        sourceLabel: existing?.sourceLabel ?? row.categoryName,
      };

      if (existing) {
        return base.map((assignment) =>
          assignment.categoryId === row.categoryId ? nextAssignment : assignment,
        );
      }

      return [...base, nextAssignment];
    });
  };

  const handleSelectAsset = (candidate: AssetClassificationResolvedAsset) => {
    setLocalSelectedAssetId(candidate.assetId);

    if (!threadId || !toolCallId) {
      return;
    }

    void updateToolResultWithRetry({
      threadId,
      toolCallId,
      resultPatch: {
        draftStatus: "assetSelected",
        selectedAssetId: candidate.assetId,
        selectedAsset: candidate,
        selectedAt: new Date().toISOString(),
      },
    }).catch((error) => {
      console.warn("Failed to persist asset selection:", error);
    });
  };

  if (!selectedAsset && assetCandidates.length === 0) {
    return <InlineToolError label={t("ai:assetClassification.noResolvedAsset")} />;
  }

  const handleConfirm = async () => {
    if (!canConfirm || !selectedAsset) return;
    setApplyError(null);
    setPersistError(false);

    try {
      await replaceAssetTaxonomyAssignments.mutateAsync({
        assetId: selectedAsset.assetId,
        taxonomyId: parsedResult.taxonomy.taxonomyId,
        assignments: proposedAssignments
          .filter((assignment) => assignment.weightBasisPoints > 0)
          .map((assignment) => ({
            assetId: selectedAsset.assetId,
            taxonomyId: parsedResult.taxonomy.taxonomyId,
            categoryId: assignment.categoryId,
            weight: assignment.weightBasisPoints,
            source: "ai",
          })),
      });
    } catch (error) {
      setApplyError(
        error instanceof Error ? error.message : t("ai:assetClassification.failedApply"),
      );
      return;
    }

    const appliedAt = new Date().toISOString();
    setLocalApplied(true);

    if (!threadId || !toolCallId) {
      setPersistError(true);
      return;
    }

    try {
      await updateToolResultWithRetry({
        threadId,
        toolCallId,
        resultPatch: {
          draftStatus: "applied",
          appliedAt,
          appliedChanges: plan.changes,
          changes: plan.changes,
          proposedAssignments,
          unallocatedBasisPoints: unallocated,
          selectedAssetId: selectedAsset.assetId,
          selectedAsset,
        },
      });
    } catch (error) {
      setPersistError(true);
      console.error("Failed to update asset classification tool result:", error);
    }
  };

  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">
              {selectedAsset?.label ||
                t("ai:assetClassification.classificationDraft", {
                  query: parsedResult.assetQuery,
                })}
            </CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {parsedResult.taxonomy.name}
              {selectedAsset ? ` · ${selectedAsset.currency}` : ""}
              {selectedAsset?.exchangeMic ? ` · ${selectedAsset.exchangeMic}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Badge variant={isApplied ? "default" : "secondary"} className="shrink-0">
              {isApplied ? t("ai:assetClassification.applied") : t("ai:assetClassification.draft")}
            </Badge>
            <Badge
              variant={!selectedAsset ? "secondary" : isValid ? "outline" : "destructive"}
              className="shrink-0"
            >
              {!selectedAsset
                ? t("ai:assetClassification.needsAsset")
                : isValid
                  ? t("ai:assetClassification.valid")
                  : t("ai:assetClassification.invalid")}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!resolvedAsset && assetCandidates.length > 0 ? (
          <div className="space-y-2">
            <div className="text-muted-foreground text-xs font-medium">
              {t("ai:assetClassification.asset")}
            </div>
            <div className="grid gap-2">
              {assetCandidates.map((candidate) => {
                const isSelected = selectedAssetId === candidate.assetId;
                const candidateAssignments =
                  candidateCurrentAssignments.find(
                    (assignments) => assignments.assetId === candidate.assetId,
                  )?.currentAssignments ?? [];
                const avatarSymbol = candidate.displayCode || candidate.symbol || candidate.label;
                const subtitle = [
                  candidate.exchangeMic,
                  candidate.currency,
                  formatExistingAllocation(candidateAssignments, t),
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <button
                    key={candidate.assetId}
                    type="button"
                    onClick={() => handleSelectAsset(candidate)}
                    disabled={isApplied}
                    className={cn(
                      "bg-background/70 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      isSelected && "border-primary/50 bg-primary/5",
                    )}
                  >
                    <TickerAvatar symbol={avatarSymbol} className="size-8 shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{candidate.label}</div>
                      <div className="text-muted-foreground mt-0.5 truncate text-xs">
                        {subtitle}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full border",
                        isSelected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted/60 text-muted-foreground",
                      )}
                    >
                      {isSelected ? <Icons.Check className="h-4 w-4" /> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <DiffStat
            label={t("ai:assetClassification.add")}
            value={plan.changes.addCount}
            className="text-success"
          />
          <DiffStat
            label={t("ai:assetClassification.update")}
            value={plan.changes.updateCount}
            className="text-primary"
          />
          <DiffStat
            label={t("ai:assetClassification.remove")}
            value={plan.changes.removeCount}
            className="text-destructive"
          />
          <DiffStat label={t("ai:assetClassification.same")} value={plan.changes.unchangedCount} />
          <DiffStat
            label={t("ai:assetClassification.unallocated")}
            value={formatBasisPoints(Math.max(unallocated, 0))}
            className={unallocated > 0 ? "text-warning" : undefined}
          />
        </div>

        <ClassificationComparisonTable
          currentRows={currentAssignments}
          proposedRows={proposedAssignments}
          emptyLabel={
            selectedAsset
              ? t("ai:assetClassification.noAllocationRows")
              : t("ai:assetClassification.chooseAsset")
          }
          disabled={isApplied || isSubmitting}
          draftPercentValues={draftPercentValues}
          onDraftPercentValueChange={handleDraftPercentValueChange}
          onNewWeightChange={handleNewWeightChange}
        />

        {validationIssues.length > 0 ? (
          <Alert variant="error">
            <Icons.AlertCircle className="h-4 w-4" />
            <AlertTitle>{t("ai:assetClassification.invalidDraft")}</AlertTitle>
            <AlertDescription className="space-y-1 text-xs">
              {validationIssues.map((issue) => (
                <div key={issue}>{issue}</div>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}

        {applyError ? (
          <Alert variant="error">
            <Icons.AlertCircle className="h-4 w-4" />
            <AlertTitle>{t("ai:assetClassification.failedApplyTitle")}</AlertTitle>
            <AlertDescription className="break-words text-xs">{applyError}</AlertDescription>
          </Alert>
        ) : null}

        {persistError ? (
          <p className="text-destructive text-xs">{t("ai:assetClassification.chatNotUpdated")}</p>
        ) : null}

        {isApplied ? (
          <div className="border-success/30 bg-success/10 flex items-center gap-3 rounded-md border px-3 py-2">
            <div className="bg-success/20 text-success flex h-7 w-7 shrink-0 items-center justify-center rounded-full">
              <Icons.Check className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-success text-sm font-medium">
                {t("ai:assetClassification.categoriesClassified", { count: appliedCategoryCount })}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("ai:assetClassification.allocationsSaved", {
                  asset: selectedAsset?.label ?? t("ai:assetClassification.yourAsset"),
                })}
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-muted-foreground min-w-0 text-xs">
            {isApplied && appliedAt
              ? t("ai:assetClassification.appliedAt", { date: appliedAt })
              : plan.hasChanges
                ? t("ai:assetClassification.changesSummary", {
                    removals: plan.removals.length,
                    writes: plan.upserts.length,
                  })
                : t("ai:assetClassification.noChanges")}
          </div>
          <Button size="sm" onClick={handleConfirm} disabled={!canConfirm}>
            {isSubmitting ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : isApplied ? (
              <Icons.Check className="mr-2 h-4 w-4" />
            ) : null}
            {isApplied ? t("ai:assetClassification.applied") : t("ai:assetClassification.confirm")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export const AssetClassificationToolUIContent = memo(AssetClassificationToolUIContentImpl);

export const AssetClassificationToolUI = makeAssistantToolUI<
  PrepareAssetClassificationArgs,
  PrepareAssetClassificationOutput
>({
  toolName: "prepare_asset_classification",
  render: (props) => <AssetClassificationToolUIContent key={props.toolCallId} {...props} />,
});
