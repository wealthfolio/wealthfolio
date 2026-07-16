import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

import { Link } from "react-router-dom";
import { useSettingsContext } from "@/lib/settings-provider";

import { useRuntimeContext } from "../../hooks/use-runtime-context";
import { useChatImportSession } from "../../hooks/use-chat-import-session";
import type { ImportCsvArgs, ImportCsvMappingOutput } from "../../types";

import { ChatReviewGrid } from "./chat-review-grid";
import { MappingBadgeStrip } from "./mapping-badge-strip";

// ─────────────────────────────────────────────────────────────────────────────
// Result normalizer — accept both camelCase (serde) and snake_case fallbacks.
// ─────────────────────────────────────────────────────────────────────────────

type RawResult = Record<string, unknown> | string | null | undefined;

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined) return obj[key] as T;
  }
  return undefined;
}

interface NormalizeResult {
  mapping: ImportCsvMappingOutput | null;
  errorMessage: string | null;
}

/** Strip rig's error chain prefix ("Toolset error: ToolCallError: ...") to
 *  surface just the actionable message. */
function cleanErrorMessage(raw: string): string {
  return raw
    .replace(/^Toolset error:\s*/i, "")
    .replace(/ToolCallError:\s*/g, "")
    .replace(/^Tool execution failed:\s*/i, "")
    .replace(/^JsonError:\s*/i, "")
    .trim();
}

function normalizeMappingResult(raw: RawResult, csvContent: string): NormalizeResult {
  if (!raw) return { mapping: null, errorMessage: null };

  // Rig wraps tool errors as plain strings — surface them directly.
  if (typeof raw === "string") {
    try {
      return normalizeMappingResult(JSON.parse(raw), csvContent);
    } catch {
      return { mapping: null, errorMessage: cleanErrorMessage(raw) };
    }
  }
  if (typeof raw !== "object") {
    return { mapping: null, errorMessage: cleanErrorMessage(String(raw)) };
  }

  const obj = raw;

  // Check for error envelope: { error: "..." }
  if ("error" in obj && typeof obj.error === "string") {
    return { mapping: null, errorMessage: cleanErrorMessage(obj.error) };
  }

  // Unwrap { data: ... } envelope if present.
  if ("data" in obj && typeof obj.data === "object" && obj.data !== null) {
    return normalizeMappingResult(obj.data as Record<string, unknown>, csvContent);
  }

  const appliedMapping = pick<Record<string, unknown>>(obj, "appliedMapping", "applied_mapping");
  const parseConfig = pick<Record<string, unknown>>(obj, "parseConfig", "parse_config");
  if (!appliedMapping) {
    return { mapping: null, errorMessage: null };
  }

  return {
    errorMessage: null,
    mapping: {
      csvContent,
      appliedMapping: appliedMapping as ImportCsvMappingOutput["appliedMapping"],
      parseConfig: (parseConfig ?? {}) as ImportCsvMappingOutput["parseConfig"],
      accountId: pick<string>(obj, "accountId", "account_id") ?? null,
      detectedHeaders: pick<string[]>(obj, "detectedHeaders", "detected_headers") ?? [],
      sampleRows: pick<string[][]>(obj, "sampleRows", "sample_rows") ?? [],
      totalRows: pick<number>(obj, "totalRows", "total_rows") ?? 0,
      mappingConfidence:
        pick<ImportCsvMappingOutput["mappingConfidence"]>(
          obj,
          "mappingConfidence",
          "mapping_confidence",
        ) ?? "MEDIUM",
      availableAccounts:
        pick<ImportCsvMappingOutput["availableAccounts"]>(
          obj,
          "availableAccounts",
          "available_accounts",
        ) ?? [],
      usedSavedProfile: pick<boolean>(obj, "usedSavedProfile", "used_saved_profile") ?? false,
      submitted: pick<boolean>(obj, "submitted"),
      importedCount: pick<number>(obj, "importedCount", "imported_count"),
      importRunId: pick<string>(obj, "importRunId", "import_run_id"),
      submittedAt: pick<string>(obj, "submittedAt", "submitted_at"),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / Success / Error shells
// ─────────────────────────────────────────────────────────────────────────────

function LoadingCard() {
  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-32 w-full" />
      </CardContent>
    </Card>
  );
}

function SuccessCard({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <Card className="bg-muted/40 border-success/30">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Icons.CheckCircle className="text-success h-5 w-5" />
          <CardTitle className="text-base">{t("ai:importCsv.importComplete")}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          {t("ai:importCsv.importedActivities", { count })}
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/activities">
            <Icons.ExternalLink className="mr-2 h-4 w-4" />
            {t("ai:importCsv.viewActivities")}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function ErrorCard({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="py-4">
        <p className="text-destructive text-sm font-medium">{t("ai:importCsv.importFailed")}</p>
        <p className="text-muted-foreground mt-1 text-xs">{message}</p>
      </CardContent>
    </Card>
  );
}

function StaleImportCard({ mapping }: { mapping: ImportCsvMappingOutput }) {
  const { t } = useTranslation();
  const fieldCount = Object.keys(mapping.appliedMapping?.fieldMappings ?? {}).length;
  const account = mapping.availableAccounts.find((item) => item.id === mapping.accountId);
  return (
    <Card className="bg-muted/40 border-muted-foreground/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Icons.FileSpreadsheet className="text-muted-foreground h-5 w-5" />
          <CardTitle className="text-base">
            {t("ai:importCsv.summary", { count: mapping.totalRows })}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-muted-foreground text-sm">
          {fieldCount > 0 ? t("ai:importCsv.mappedColumns", { count: fieldCount }) : ""}
          {account ? t("ai:importCsv.targetAccount", { name: account.name }) : ""}
          {t("ai:importCsv.fileUnavailable")}
        </p>
        <p className="text-muted-foreground text-xs">{t("ai:importCsv.attachAgain")}</p>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Session tracking — module-level Set resets on page reload but persists
// across thread switches within the same page session. Used to distinguish
// "tool call that just completed (initialize)" from "reloaded from DB (stale)".
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LIVE_IMPORT_CSV_CACHE_ENTRIES = 10;
const MAX_LIVE_IMPORT_CSV_CACHE_BYTES = 100 * 1024 * 1024;

const liveToolCalls = new Set<string>();
const liveCsvContentByToolCall = new Map<string, string>();

function getLiveCsvContentBytes(): number {
  let bytes = 0;
  for (const content of liveCsvContentByToolCall.values()) {
    bytes += content.length;
  }
  return bytes;
}

function evictOldestLiveImportSession(): boolean {
  const oldestToolCallId =
    liveToolCalls.values().next().value ?? liveCsvContentByToolCall.keys().next().value;
  if (!oldestToolCallId) return false;

  liveToolCalls.delete(oldestToolCallId);
  liveCsvContentByToolCall.delete(oldestToolCallId);
  return true;
}

function pruneLiveImportSessionCache() {
  while (
    liveToolCalls.size > MAX_LIVE_IMPORT_CSV_CACHE_ENTRIES ||
    liveCsvContentByToolCall.size > MAX_LIVE_IMPORT_CSV_CACHE_ENTRIES ||
    getLiveCsvContentBytes() > MAX_LIVE_IMPORT_CSV_CACHE_BYTES
  ) {
    if (!evictOldestLiveImportSession()) break;
  }
}

function rememberLiveToolCall(toolCallId: string) {
  liveToolCalls.delete(toolCallId);
  liveToolCalls.add(toolCallId);
  pruneLiveImportSessionCache();
}

function rememberSessionCsvContent(toolCallId: string, content: string) {
  liveCsvContentByToolCall.delete(toolCallId);
  liveCsvContentByToolCall.set(toolCallId, content);
  rememberLiveToolCall(toolCallId);
}

function isRedactedCsvContent(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.toLowerCase().includes("redacted") &&
    value.toLowerCase().includes("session")
  );
}

function getSessionCsvContent(toolCallId: string | undefined, value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() && !isRedactedCsvContent(value)) {
    if (toolCallId) {
      rememberSessionCsvContent(toolCallId, value);
    }
    return value;
  }

  return toolCallId ? liveCsvContentByToolCall.get(toolCallId) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

type ImportCsvToolUIContentProps = ToolCallMessagePartProps<ImportCsvArgs, unknown>;

function ImportCsvToolUIContentImpl({
  args,
  result,
  status,
  toolCallId,
}: ImportCsvToolUIContentProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const runtime = useRuntimeContext();
  const threadId = runtime.currentThreadId;

  // csvContent lives in live tool args only. Persisted tool args are redacted,
  // so keep an in-memory copy for this page session.
  const rawCsvContent = (args as Record<string, unknown>)?.csvContent;
  const csvContent = getSessionCsvContent(toolCallId, rawCsvContent);

  const { mapping, errorMessage: normalizeError } = useMemo(
    () => normalizeMappingResult(result as RawResult, csvContent ?? ""),
    [result, csvContent],
  );

  // Track which tool calls went through "running" status in this page
  // session. On page reload the Set resets — we won't find the toolCallId,
  // so we show the stale card. During a live session, we add the ID when
  // status is "running" and it persists across thread switches.
  if (toolCallId && status?.type === "running") {
    rememberLiveToolCall(toolCallId);
  }
  const hasCsvContent = !!mapping?.csvContent;
  const isSubmitted = mapping?.submitted ?? false;
  const isLive = !!toolCallId && liveToolCalls.has(toolCallId);
  const canReviewImport = isLive && hasCsvContent;
  const shouldInitSession = canReviewImport || isSubmitted;

  const session = useChatImportSession({
    mapping: shouldInitSession ? mapping : null,
    threadId,
    toolCallId,
    submittedFromResult: mapping?.submitted ?? false,
    submittedCountFromResult: mapping?.importedCount,
  });

  if (!result || (!mapping && status?.type === "running")) {
    return <LoadingCard />;
  }
  if (status?.type === "incomplete") {
    return <ErrorCard message={t("ai:importCsv.requestInterrupted")} />;
  }
  if (!mapping) {
    return <ErrorCard message={normalizeError || t("ai:importCsv.noMapping")} />;
  }
  if (isSubmitted || session.submitted) {
    return <SuccessCard count={session.importedCount || mapping.importedCount || 0} />;
  }
  // Historical imports can keep tool metadata but lose session-only CSV content.
  // Without the CSV body we cannot rebuild the editable review grid.
  if (!canReviewImport) {
    return <StaleImportCard mapping={mapping} />;
  }
  if (session.status === "initializing") {
    return <LoadingCard />;
  }
  if (session.status === "error" && session.error && session.drafts.length === 0) {
    return <ErrorCard message={session.error} />;
  }

  return (
    <Card className="bg-muted/40 border-primary/10">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icons.FileSpreadsheet className="text-primary h-5 w-5" />
            <CardTitle className="text-base">
              {t("ai:importCsv.importTitle", { count: mapping.totalRows })}
            </CardTitle>
          </div>
          <Select value={session.accountId || ""} onValueChange={session.setAccountId}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder={t("ai:importCsv.selectTargetAccount")} />
            </SelectTrigger>
            <SelectContent>
              {mapping.availableAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name} ({account.currency})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <MappingBadgeStrip mapping={mapping} baseCurrency={baseCurrency} />

        {session.error && session.drafts.length > 0 && (
          <div className="border-destructive/50 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Icons.AlertCircle className="h-4 w-4 shrink-0" />
            <span>{session.error}</span>
          </div>
        )}

        <ChatReviewGrid
          filteredDrafts={session.filteredDrafts}
          stats={session.stats}
          filter={session.filter}
          onFilterChange={session.setFilter}
          onDraftUpdate={session.editDraft}
          onBulkSkip={session.bulkSkip}
          onBulkUnskip={session.bulkUnskip}
          onBulkForceImport={session.bulkForceImport}
          importProfile={session.importProfile}
        />

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <div className="text-muted-foreground text-xs">
            {t("ai:importCsv.statsSummary", {
              valid: session.stats.valid,
              warning: session.stats.warning,
              errors: session.stats.errors,
              duplicates: session.stats.duplicates,
            })}
          </div>
          <div className="flex items-center gap-2">
            {session.status === "ready" && session.error && (
              <Button variant="outline" size="sm" onClick={session.revalidate}>
                {t("ai:importCsv.revalidate")}
              </Button>
            )}
            <Button
              onClick={session.confirm}
              disabled={!session.canConfirm || session.isSubmitting}
            >
              {session.isSubmitting ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Icons.Download className="mr-2 h-4 w-4" />
              )}
              {t("ai:importCsv.import", { count: session.stats.toImport })}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const ImportCsvToolUIContent = memo(ImportCsvToolUIContentImpl);

export const ImportCsvToolUI = makeAssistantToolUI<ImportCsvArgs, unknown>({
  toolName: "import_csv",
  render: (props) => {
    // Key on toolCallId so React unmounts/remounts when switching threads.
    return <ImportCsvToolUIContent key={props.toolCallId} {...props} />;
  },
});
