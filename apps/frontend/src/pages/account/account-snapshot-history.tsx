import { deleteSnapshot, getSnapshots } from "@/adapters";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, SnapshotInfo } from "@/lib/types";
import { formatAmount, formatDate } from "@/lib/utils";
import { HoldingsEditMode } from "@/pages/holdings/components/holdings-edit-mode";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";

interface AccountSnapshotHistoryProps {
  account: Account;
  canEditSnapshots: boolean;
  onAddSnapshot?: () => void;
}

export function AccountSnapshotHistory({
  account,
  canEditSnapshots,
  onAddSnapshot,
}: AccountSnapshotHistoryProps) {
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
    return snapshots
      .filter((snapshot) => snapshot.source !== "SYNTHETIC")
      .sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
  }, [snapshots]);

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
      await deleteSnapshot(account.id, deletingSnapshot.snapshotDate);
      invalidateSnapshotQueries(deletingSnapshot.snapshotDate);
      toast.success(t("account:snapshot.deleted"));
      setDeletingSnapshot(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("account:snapshot.delete_failed"));
    } finally {
      setIsDeleting(false);
    }
  };

  const canManageSnapshot = (snapshot: SnapshotInfo) =>
    canEditSnapshots && snapshot.source !== "CALCULATED" && snapshot.source !== "SYNTHETIC";

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
              className="flex items-center gap-3 rounded-lg border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">
                    {formatDate(snapshot.snapshotDate)}
                  </p>
                  <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                    {formatSnapshotSource(snapshot.source, t)}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-xs">
                  {formatSnapshotSummary(snapshot, account.currency, t)}
                </p>
              </div>
              {canManageSnapshot(snapshot) && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t("account:snapshot.edit_aria", {
                      date: formatDate(snapshot.snapshotDate),
                    })}
                    onClick={() => setEditingDate(snapshot.snapshotDate)}
                  >
                    <Icons.Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive size-8"
                    aria-label={t("account:snapshot.delete_aria", {
                      date: formatDate(snapshot.snapshotDate),
                    })}
                    onClick={() => setDeletingSnapshot(snapshot)}
                  >
                    <Icons.Trash className="size-4" />
                  </Button>
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
                <TableHead className="w-[96px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orderedSnapshots.map((snapshot) => (
                <TableRow key={snapshot.id}>
                  <TableCell className="font-medium">{formatDate(snapshot.snapshotDate)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      {formatSnapshotSource(snapshot.source, t)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{snapshot.positionCount}</TableCell>
                  <TableCell className="text-right">
                    {formatAmount(snapshot.cashTotalAccountCurrency, account.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManageSnapshot(snapshot) && (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={t("account:snapshot.edit_aria", {
                            date: formatDate(snapshot.snapshotDate),
                          })}
                          onClick={() => setEditingDate(snapshot.snapshotDate)}
                        >
                          <Icons.Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive size-8"
                          aria-label={t("account:snapshot.delete_aria", {
                            date: formatDate(snapshot.snapshotDate),
                          })}
                          onClick={() => setDeletingSnapshot(snapshot)}
                        >
                          <Icons.Trash className="size-4" />
                        </Button>
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
                date: deletingSnapshot ? formatDate(deletingSnapshot.snapshotDate) : "",
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
    case "SYNTHETIC":
      return t("account:snapshot.source_synthetic");
    default:
      return source;
  }
}

function formatSnapshotSummary(
  snapshot: SnapshotInfo,
  accountCurrency: string,
  t: TFunction,
): string {
  return t("account:snapshot.summary", {
    count: snapshot.positionCount,
    cash: formatAmount(snapshot.cashTotalAccountCurrency, accountCurrency),
  });
}

export default AccountSnapshotHistory;
