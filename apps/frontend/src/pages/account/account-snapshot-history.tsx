import { deleteSnapshot, getSnapshots } from "@/adapters";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, SnapshotInfo } from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { HoldingsEditMode } from "@/pages/holdings/components/holdings-edit-mode";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAmountFormatting, type FormattingApi, useDateFormatting } from "@wealthfolio/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@wealthfolio/ui/components/ui/tooltip";
import type { TFunction } from "i18next";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface AccountSnapshotHistoryProps {
  account: Account;
  canEditSnapshots: boolean;
  onAddSnapshot?: () => void;
  highlightedSnapshotDate?: string;
  highlightedSnapshotId?: string;
  invalidSnapshotContext?: boolean;
  onInvalidSnapshotRemediated?: () => void;
}

export function AccountSnapshotHistory({
  account,
  canEditSnapshots,
  onAddSnapshot,
  highlightedSnapshotDate,
  highlightedSnapshotId,
  invalidSnapshotContext = false,
  onInvalidSnapshotRemediated,
}: AccountSnapshotHistoryProps) {
  const dateFormatting = useDateFormatting();
  const formatting = useAmountFormatting();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useIsMobileViewport();
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [deletingSnapshot, setDeletingSnapshot] = useState<SnapshotInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const { data: snapshots = [], isLoading } = useQuery<SnapshotInfo[], Error>({
    queryKey: QueryKeys.snapshots(account.id),
    queryFn: () => getSnapshots(account.id),
    enabled: !!account.id,
  });

  const orderedSnapshots = useMemo(() => {
    return [...snapshots].sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
  }, [snapshots]);

  const hasHighlightedInvalidSnapshot =
    invalidSnapshotContext &&
    (!!highlightedSnapshotId || !!highlightedSnapshotDate) &&
    orderedSnapshots.some((snapshot) =>
      highlightedSnapshotId
        ? snapshot.id === highlightedSnapshotId
        : snapshot.snapshotDate === highlightedSnapshotDate,
    );

  const highlightedSnapshotRef = useCallback(
    (node: HTMLElement | null) => {
      if (node && invalidSnapshotContext && (highlightedSnapshotId || highlightedSnapshotDate)) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    [highlightedSnapshotDate, highlightedSnapshotId, invalidSnapshotContext],
  );

  const invalidateSnapshotQueries = (date?: string) => {
    queryClient.invalidateQueries({ queryKey: QueryKeys.snapshots(account.id) });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS, account.id] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS_SIMPLE_PERFORMANCE] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_HISTORY] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_SUMMARY] });
    queryClient.invalidateQueries({ queryKey: QueryKeys.valuationHistory(account.id) });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HISTORY_VALUATION] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.latestValuations] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.CURRENT_VALUATION] });
    if (date) {
      queryClient.invalidateQueries({ queryKey: QueryKeys.snapshotHoldings(account.id, date) });
    }
  };

  const handleEditClose = () => {
    invalidateSnapshotQueries(editingDate ?? undefined);
    setEditingDate(null);
  };

  const handleDeleteSnapshot = async () => {
    if (!deletingSnapshot) return;
    setIsDeleting(true);
    try {
      await deleteSnapshot(account.id, deletingSnapshot.snapshotDate, deletingSnapshot.id);
      invalidateSnapshotQueries(deletingSnapshot.snapshotDate);
      if (isHighlightedInvalidSnapshot(deletingSnapshot)) {
        onInvalidSnapshotRemediated?.();
      }
      toast.success(t("account:snapshot.deleted"));
      setDeletingSnapshot(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("account:snapshot.delete_failed"));
    } finally {
      setIsDeleting(false);
    }
  };

  const canEditSnapshot = (snapshot: SnapshotInfo) =>
    canEditSnapshots && snapshot.isDateValid && snapshot.source !== "CALCULATED";
  const isHighlightedInvalidSnapshot = (snapshot: SnapshotInfo) =>
    hasHighlightedInvalidSnapshot &&
    (highlightedSnapshotId
      ? snapshot.id === highlightedSnapshotId
      : snapshot.snapshotDate === highlightedSnapshotDate);
  const canDeleteSnapshot = (snapshot: SnapshotInfo) =>
    isHighlightedInvalidSnapshot(snapshot) ||
    (snapshot.source !== "CALCULATED" && canEditSnapshots);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Icons.Spinner className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">{t("account:snapshot.history_title")}</h3>
          <p className="text-muted-foreground text-sm">{t("account:snapshot.history_desc")}</p>
        </div>
        {canEditSnapshots && onAddSnapshot && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onAddSnapshot}
                  aria-label={t("account:snapshot.add")}
                >
                  <Icons.Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t("account:snapshot.add")}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {hasHighlightedInvalidSnapshot && (
        <div className="border-destructive/40 bg-destructive/5 rounded-md border px-4 py-3 text-sm">
          <p className="font-medium">{t("account:snapshot.invalid_date_title")}</p>
          <p className="text-muted-foreground mt-1">{t("account:snapshot.invalid_date_desc")}</p>
        </div>
      )}

      {orderedSnapshots.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <div className="space-y-3 text-center">
            <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-full">
              <Icons.History className="text-muted-foreground size-5" />
            </div>
            <div>
              <p className="font-medium">{t("account:snapshot.empty_title")}</p>
              <p className="text-muted-foreground text-sm">{t("account:snapshot.empty_desc")}</p>
            </div>
          </div>
        </div>
      ) : isMobile ? (
        <div className="space-y-2">
          {orderedSnapshots.map((snapshot) => (
            <div
              key={snapshot.id}
              id={`snapshot-${snapshot.snapshotDate}`}
              ref={isHighlightedInvalidSnapshot(snapshot) ? highlightedSnapshotRef : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5",
                isHighlightedInvalidSnapshot(snapshot) &&
                  "border-destructive bg-destructive/5 ring-destructive/20 ring-2",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">
                    {formatDate(snapshot.snapshotDate, dateFormatting)}
                  </p>
                  <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                    {formatSnapshotSource(snapshot.source, t)}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-xs">
                  {formatSnapshotSummary(snapshot, account.currency, t, formatting)}
                </p>
              </div>
              {(canEditSnapshot(snapshot) || canDeleteSnapshot(snapshot)) && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {canEditSnapshot(snapshot) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label={t("account:snapshot.edit_aria", {
                        date: formatDate(snapshot.snapshotDate, dateFormatting),
                      })}
                      onClick={() => setEditingDate(snapshot.snapshotDate)}
                    >
                      <Icons.Pencil className="size-4" />
                    </Button>
                  )}
                  {canDeleteSnapshot(snapshot) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive size-8"
                      aria-label={t("account:snapshot.delete_aria", {
                        date: formatDate(snapshot.snapshotDate, dateFormatting),
                      })}
                      onClick={() => setDeletingSnapshot(snapshot)}
                    >
                      <Icons.Trash className="size-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("common:date")}</TableHead>
                <TableHead>{t("account:snapshot.header_source")}</TableHead>
                <TableHead className="text-right">
                  {t("account:snapshot.header_positions")}
                </TableHead>
                <TableHead className="text-right">{t("account:snapshot.header_cash")}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orderedSnapshots.map((snapshot) => (
                <TableRow
                  key={snapshot.id}
                  id={`snapshot-${snapshot.snapshotDate}`}
                  ref={isHighlightedInvalidSnapshot(snapshot) ? highlightedSnapshotRef : undefined}
                  className={cn(
                    isHighlightedInvalidSnapshot(snapshot) &&
                      "bg-destructive/5 ring-destructive/20 ring-2 ring-inset",
                  )}
                >
                  <TableCell className="font-medium">
                    {formatDate(snapshot.snapshotDate, dateFormatting)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      {formatSnapshotSource(snapshot.source, t)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{snapshot.positionCount}</TableCell>
                  <TableCell className="text-right">
                    {formatting.formatAmount(snapshot.cashTotalAccountCurrency, account.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {(canEditSnapshot(snapshot) || canDeleteSnapshot(snapshot)) && (
                      <div className="flex items-center justify-end gap-1">
                        {canEditSnapshot(snapshot) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={t("account:snapshot.edit_aria", {
                              date: formatDate(snapshot.snapshotDate, dateFormatting),
                            })}
                            onClick={() => setEditingDate(snapshot.snapshotDate)}
                          >
                            <Icons.Pencil className="size-4" />
                          </Button>
                        )}
                        {canDeleteSnapshot(snapshot) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive size-8"
                            aria-label={t("account:snapshot.delete_aria", {
                              date: formatDate(snapshot.snapshotDate, dateFormatting),
                            })}
                            onClick={() => setDeletingSnapshot(snapshot)}
                          >
                            <Icons.Trash className="size-4" />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editingDate && (
        <Sheet open={!!editingDate} onOpenChange={() => handleEditClose()}>
          <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-2xl">
            <SheetHeader className="border-b px-6 py-4">
              <SheetTitle>{t("account:snapshot.update_title")}</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-hidden px-6">
              <HoldingsEditMode
                holdings={[]}
                account={account}
                isLoading={false}
                onClose={handleEditClose}
                existingSnapshotDate={editingDate}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      <AlertDialog open={!!deletingSnapshot} onOpenChange={() => setDeletingSnapshot(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("account:snapshot.delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("account:snapshot.delete_desc", {
                date: deletingSnapshot
                  ? formatDate(deletingSnapshot.snapshotDate, dateFormatting)
                  : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSnapshot}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t("account:snapshot.deleting") : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function formatSnapshotSource(source: string, t: TFunction): string {
  switch (source) {
    case "MANUAL_ENTRY":
      return t("account:snapshot.source_manual");
    case "CSV_IMPORT":
      return t("account:snapshot.source_csv");
    case "BROKER_IMPORTED":
      return t("account:snapshot.source_broker");
    case "CALCULATED":
      return t("account:snapshot.source_calculated");
    default:
      return source;
  }
}

function formatSnapshotSummary(
  snapshot: SnapshotInfo,
  accountCurrency: string,
  t: TFunction,
  formatting: Pick<FormattingApi, "formatAmount">,
): string {
  return t("account:snapshot.summary", {
    count: snapshot.positionCount,
    cash: formatting.formatAmount(snapshot.cashTotalAccountCurrency, accountCurrency),
  });
}

export default AccountSnapshotHistory;
