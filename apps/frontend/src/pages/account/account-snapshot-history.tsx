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
      toast.success("Snapshot deleted");
      setDeletingSnapshot(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete snapshot");
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
          <h3 className="text-lg font-bold">Snapshot History</h3>
          <p className="text-muted-foreground text-sm">
            Review saved holdings and cash balances by date.
          </p>
        </div>
        {canEditSnapshots && onAddSnapshot && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onAddSnapshot}
                  aria-label="Add snapshot"
                >
                  <Icons.Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Add snapshot</p>
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
              <p className="font-medium">No snapshots yet</p>
              <p className="text-muted-foreground text-sm">
                Snapshot history will appear once holdings are saved or imported.
              </p>
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
                    {formatSnapshotSource(snapshot.source)}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-xs">
                  {formatSnapshotSummary(snapshot, account.currency)}
                </p>
              </div>
              {canManageSnapshot(snapshot) && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={`Edit snapshot from ${formatDate(snapshot.snapshotDate)}`}
                    onClick={() => setEditingDate(snapshot.snapshotDate)}
                  >
                    <Icons.Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive size-8"
                    aria-label={`Delete snapshot from ${formatDate(snapshot.snapshotDate)}`}
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
                <TableHead>Date</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Positions</TableHead>
                <TableHead className="text-right">Cash</TableHead>
                <TableHead className="w-[96px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orderedSnapshots.map((snapshot) => (
                <TableRow key={snapshot.id}>
                  <TableCell className="font-medium">{formatDate(snapshot.snapshotDate)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      {formatSnapshotSource(snapshot.source)}
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
                          aria-label={`Edit snapshot from ${formatDate(snapshot.snapshotDate)}`}
                          onClick={() => setEditingDate(snapshot.snapshotDate)}
                        >
                          <Icons.Pencil className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive size-8"
                          aria-label={`Delete snapshot from ${formatDate(snapshot.snapshotDate)}`}
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
              <SheetTitle>Update Snapshot</SheetTitle>
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
            <AlertDialogTitle>Delete Snapshot</AlertDialogTitle>
            <AlertDialogDescription>
              Delete the snapshot from{" "}
              {deletingSnapshot ? formatDate(deletingSnapshot.snapshotDate) : ""}? This removes the
              positions and cash balances saved for that date.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSnapshot}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function formatSnapshotSource(source: string): string {
  switch (source) {
    case "MANUAL_ENTRY":
      return "Manual";
    case "CSV_IMPORT":
      return "CSV";
    case "BROKER_IMPORTED":
      return "Broker";
    case "CALCULATED":
      return "Calculated";
    case "SYNTHETIC":
      return "Synthetic";
    default:
      return source;
  }
}

function formatSnapshotSummary(snapshot: SnapshotInfo, accountCurrency: string): string {
  const positionLabel = snapshot.positionCount === 1 ? "position" : "positions";
  return `${snapshot.positionCount} ${positionLabel}, ${formatAmount(
    snapshot.cashTotalAccountCurrency,
    accountCurrency,
  )} cash`;
}

export default AccountSnapshotHistory;
