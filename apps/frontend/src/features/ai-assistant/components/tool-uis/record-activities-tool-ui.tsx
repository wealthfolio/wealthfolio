import { saveActivities, updateToolResult } from "@/adapters";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useSettingsContext } from "@/lib/settings-provider";
import { cn } from "@/lib/utils";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useRuntimeContext } from "../../hooks/use-runtime-context";
import type {
  RecordActivitiesArgs,
  RecordActivitiesOutput,
  RecordActivitiesSubmissionStatus,
} from "../../types";
import {
  buildRecordActivitiesCreatePayload,
  mapRecordActivitiesSubmission,
  normalizeRecordActivitiesResult,
} from "./record-activities-tool-utils";
import {
  createActivityAmountFormatter,
  createActivityQuantityFormatter,
  formatActivityAmount,
  formatActivityDate,
  formatActivityQuantity,
  formatActivityType,
  getActivityTypeBadge,
} from "./shared";

type RecordActivitiesToolUIContentProps = ToolCallMessagePartProps<
  RecordActivitiesArgs,
  RecordActivitiesOutput
>;

interface RowStatusBadge {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
  className: string;
}

function countStatuses(statuses: RecordActivitiesSubmissionStatus[]): {
  createdCount: number;
  errorCount: number;
} {
  return {
    createdCount: statuses.filter((entry) => entry.status === "submitted").length,
    errorCount: statuses.filter((entry) => entry.status === "error").length,
  };
}

function RecordActivitiesLoadingSkeleton() {
  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-24" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-0 pb-0">
        <div className="px-6">
          <Skeleton className="h-8 w-full" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              {Array.from({ length: 9 }).map((_, i) => (
                <TableHead key={i}>
                  <Skeleton className="h-3 w-12" />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 4 }).map((_, row) => (
              <TableRow key={row}>
                {Array.from({ length: 9 }).map((_, col) => (
                  <TableCell key={col}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function getRowStatusBadge(
  status: RecordActivitiesSubmissionStatus | undefined,
  isValid: boolean,
  t: TFunction,
): RowStatusBadge {
  if (status?.status === "submitted") {
    return {
      label: t("ai:recordActivities.submitted"),
      variant: "default",
      className: "",
    };
  }
  if (status?.status === "error") {
    return { label: t("ai:recordActivities.error"), variant: "destructive", className: "" };
  }
  if (isValid) {
    return { label: t("ai:recordActivities.ready"), variant: "outline", className: "" };
  }
  return { label: t("ai:recordActivities.invalid"), variant: "secondary", className: "" };
}

function RecordActivitiesToolUIContentImpl({
  result,
  status,
  toolCallId,
}: RecordActivitiesToolUIContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { isBalanceHidden } = useBalancePrivacy();
  const runtime = useRuntimeContext();
  const threadId = runtime.currentThreadId;
  const parsed = useMemo(
    () => normalizeRecordActivitiesResult(result, baseCurrency),
    [baseCurrency, result],
  );
  const amountFormatter = useMemo(() => createActivityAmountFormatter(), []);
  const quantityFormatter = useMemo(() => createActivityQuantityFormatter(), []);

  const [localStatuses, setLocalStatuses] = useState<RecordActivitiesSubmissionStatus[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSummary, setSubmitSummary] = useState<{
    createdCount: number;
    errorCount: number;
  } | null>(null);

  const isLoading = status?.type === "running";
  const isIncomplete = status?.type === "incomplete";

  const mergedStatuses = useMemo(() => {
    const map = new Map<number, RecordActivitiesSubmissionStatus>();
    for (const row of parsed?.rowStatuses ?? []) map.set(row.rowIndex, row);
    for (const row of localStatuses) map.set(row.rowIndex, row);
    return map;
  }, [localStatuses, parsed?.rowStatuses]);

  const rows = parsed?.drafts ?? [];
  const pendingValidRows = rows.filter((row) => {
    if (!row.validation.isValid) return false;
    return mergedStatuses.get(row.rowIndex)?.status !== "submitted";
  });
  const canSubmit = pendingValidRows.length > 0 && !isSubmitting;

  const totalRows = parsed?.validation.totalRows ?? rows.length;
  const validRows =
    parsed?.validation.validRows ?? rows.filter((row) => row.validation.isValid).length;
  const errorRows =
    parsed?.validation.errorRows ?? rows.filter((row) => !row.validation.isValid).length;

  if (isLoading) return <RecordActivitiesLoadingSkeleton />;

  if (isIncomplete) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">
            {t("ai:recordActivities.failedPrepare")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!parsed) {
    return (
      <Card className="border-destructive/30 bg-destructive/5">
        <CardContent className="py-4">
          <p className="text-destructive text-sm font-medium">
            {t("ai:recordActivities.noBatchDraft")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const { creates, rowIndexByTempId } = buildRecordActivitiesCreatePayload(pendingValidRows);
      if (creates.length === 0) {
        setSubmitError(t("ai:recordActivities.noValidRows"));
        return;
      }

      const saveResult = await saveActivities({
        creates,
        updates: [],
        deleteIds: [],
      });

      const submission = mapRecordActivitiesSubmission(saveResult, rowIndexByTempId);
      const mergedMap = new Map<number, RecordActivitiesSubmissionStatus>(mergedStatuses);
      for (const statusEntry of submission.rowStatuses) {
        mergedMap.set(statusEntry.rowIndex, statusEntry);
      }
      const mergedRowStatuses = [...mergedMap.values()].sort((a, b) => a.rowIndex - b.rowIndex);
      setLocalStatuses(mergedRowStatuses);
      setSubmitSummary({
        createdCount: submission.createdCount,
        errorCount: submission.errorCount,
      });

      const remainingValidRows = rows.filter((row) => {
        if (!row.validation.isValid) return false;
        return mergedMap.get(row.rowIndex)?.status !== "submitted";
      }).length;
      const mergedStatusSummary = countStatuses(mergedRowStatuses);

      if (threadId && toolCallId) {
        try {
          await updateToolResult({
            threadId,
            toolCallId,
            resultPatch: {
              submitted: remainingValidRows === 0,
              createdCount: mergedStatusSummary.createdCount,
              errorCount: mergedStatusSummary.errorCount,
              rowStatuses: mergedRowStatuses,
              submittedAt: new Date().toISOString(),
            },
          });
        } catch (error) {
          console.error("Failed to persist record_activities tool state:", error);
        }
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("ai:recordActivities.failedSave"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const persistedSummary = {
    createdCount: parsed.createdCount ?? 0,
    errorCount: parsed.errorCount ?? 0,
  };

  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium">
              {t("ai:recordActivities.batchPreview")}
            </CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("ai:recordActivities.reviewHint")}
            </p>
          </div>
          <Badge variant="outline" className="text-xs">
            {t("ai:recordActivities.readyCount", { count: validRows })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-0 pb-3">
        <div className="grid grid-cols-2 gap-2 px-6 text-xs md:grid-cols-4">
          <div className="rounded-md border px-2 py-1">
            {t("ai:recordActivities.rows", { count: totalRows })}
          </div>
          <div className="rounded-md border px-2 py-1">
            {t("ai:recordActivities.valid", { count: validRows })}
          </div>
          <div className="rounded-md border px-2 py-1">
            {t("ai:recordActivities.errors", { count: errorRows })}
          </div>
          <div className="rounded-md border px-2 py-1">
            {t("ai:recordActivities.willCreate", { count: pendingValidRows.length })}
          </div>
        </div>

        <div className="max-h-[360px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-xs">{t("ai:recordActivities.date")}</TableHead>
                <TableHead className="text-xs">{t("ai:recordActivities.type")}</TableHead>
                <TableHead className="text-xs">{t("ai:recordActivities.symbol")}</TableHead>
                <TableHead className="text-right text-xs">{t("ai:recordActivities.qty")}</TableHead>
                <TableHead className="text-right text-xs">
                  {t("ai:recordActivities.price")}
                </TableHead>
                <TableHead className="text-right text-xs">
                  {t("ai:recordActivities.amount")}
                </TableHead>
                <TableHead className="text-right text-xs">{t("ai:recordActivities.fee")}</TableHead>
                <TableHead className="text-xs">{t("ai:recordActivities.account")}</TableHead>
                <TableHead className="pr-4 text-xs">{t("ai:recordActivities.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const activityBadge = getActivityTypeBadge(row.draft.activityType);
                const statusEntry = mergedStatuses.get(row.rowIndex);
                const rowStatusBadge = getRowStatusBadge(statusEntry, row.validation.isValid, t);
                return (
                  <TableRow key={row.rowIndex} className="text-xs">
                    <TableCell className="py-2 pl-4 tabular-nums">
                      {formatActivityDate(row.draft.activityDate)}
                    </TableCell>
                    <TableCell className="py-2">
                      <Badge
                        variant={activityBadge.variant}
                        className={cn("text-[10px] uppercase", activityBadge.className)}
                      >
                        {formatActivityType(row.draft.activityType)}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-2">{row.draft.symbol ?? "-"}</TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {formatActivityQuantity(
                        row.draft.quantity,
                        quantityFormatter,
                        isBalanceHidden,
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {formatActivityAmount(
                        row.draft.unitPrice,
                        amountFormatter,
                        isBalanceHidden,
                        row.draft.currency,
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {formatActivityAmount(
                        row.draft.amount,
                        amountFormatter,
                        isBalanceHidden,
                        row.draft.currency,
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {formatActivityAmount(
                        row.draft.fee,
                        amountFormatter,
                        isBalanceHidden,
                        row.draft.currency,
                      )}
                    </TableCell>
                    <TableCell className="py-2">
                      {row.draft.accountName ?? row.draft.accountId ?? "-"}
                    </TableCell>
                    <TableCell className="py-2 pr-4">
                      <div className="space-y-1">
                        <Badge
                          variant={rowStatusBadge.variant}
                          className={cn("text-[10px] uppercase", rowStatusBadge.className)}
                        >
                          {rowStatusBadge.label}
                        </Badge>
                        {statusEntry?.error && (
                          <p className="text-destructive max-w-[180px] truncate text-[10px]">
                            {statusEntry.error}
                          </p>
                        )}
                        {!statusEntry?.error &&
                          row.errors[0] &&
                          statusEntry?.status !== "submitted" && (
                            <p className="text-muted-foreground max-w-[180px] truncate text-[10px]">
                              {row.errors[0]}
                            </p>
                          )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {submitError && (
          <div className="border-destructive/50 bg-destructive/10 text-destructive mx-6 flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
            <Icons.AlertCircle className="h-4 w-4 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        {(submitSummary || parsed.submittedAt) && (
          <div className="text-muted-foreground px-6 text-xs">
            {t("ai:recordActivities.createdSummary", {
              created: (submitSummary?.createdCount ?? persistedSummary.createdCount) || 0,
              errors: (submitSummary?.errorCount ?? persistedSummary.errorCount) || 0,
            })}
          </div>
        )}

        <div className="flex items-center justify-end px-6 pt-1">
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.Check className="mr-2 h-4 w-4" />
            )}
            {pendingValidRows.length > 0
              ? t("ai:recordActivities.confirmActivities", { count: pendingValidRows.length })
              : t("ai:recordActivities.confirmActivitiesEmpty")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const RecordActivitiesToolUIContent = memo(RecordActivitiesToolUIContentImpl);

export const RecordActivitiesToolUI = makeAssistantToolUI<
  RecordActivitiesArgs,
  RecordActivitiesOutput
>({
  toolName: "record_activities",
  render: (props) => {
    return <RecordActivitiesToolUIContent {...props} />;
  },
});
