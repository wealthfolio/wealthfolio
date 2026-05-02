import {
  getAssetHoldings,
  getSnapshots,
  getSnapshotByDate,
  deleteSnapshot,
  saveManualHoldings,
} from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, Holding, SnapshotInfo } from "@/lib/types";
import { formatDate } from "@/lib/utils";
import { AmountDisplay, GainAmount, GainPercent, QuantityDisplay } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui/components/ui/table";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { HoldingsEditMode } from "@/pages/holdings/components/holdings-edit-mode";

interface AssetAccountHoldingsProps {
  assetId: string;
  baseCurrency: string;
  instrumentType?: string | null;
}

function quantityLabel(instrumentType?: string | null): string {
  switch (instrumentType) {
    case "BOND":
      return "bonds";
    case "OPTION":
      return "contracts";
    case "METAL":
      return "units";
    default:
      return "shares";
  }
}

/** Returns true if any HOLDINGS-mode account has actual non-calculated snapshots */
export function useHasManualSnapshots(assetId: string): boolean {
  const { accounts } = useAccounts();
  const { data: assetHoldings = [] } = useQuery<Holding[]>({
    queryKey: [QueryKeys.ASSET_HOLDINGS, assetId],
    queryFn: () => getAssetHoldings(assetId),
    enabled: !!assetId,
  });

  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const holdingsModeAccountIds = useMemo(() => {
    return assetHoldings
      .map((h) => h.accountId)
      .filter((accountId) => accountsMap.get(accountId)?.trackingMode === "HOLDINGS");
  }, [assetHoldings, accountsMap]);

  const snapshotQueries = useQueries({
    queries: holdingsModeAccountIds.map((accountId) => ({
      queryKey: QueryKeys.snapshots(accountId),
      queryFn: () => getSnapshots(accountId),
      enabled: !!accountId,
    })),
  });

  return useMemo(() => {
    return snapshotQueries.some((q) =>
      (q.data ?? []).some((snap) => snap.source !== "CALCULATED" && snap.source !== "SYNTHETIC"),
    );
  }, [snapshotQueries]);
}

/** Holdings table - per-account breakdown for an asset */
export function AssetAccountHoldings({
  assetId,
  baseCurrency,
  instrumentType,
}: AssetAccountHoldingsProps) {
  const { isBalanceHidden } = useBalancePrivacy();
  const { accounts } = useAccounts();
  const isMobile = useIsMobileViewport();

  const { data: assetHoldings = [], isLoading } = useQuery<Holding[]>({
    queryKey: [QueryKeys.ASSET_HOLDINGS, assetId],
    queryFn: () => getAssetHoldings(assetId),
    enabled: !!assetId,
  });

  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  if (isLoading || assetHoldings.length === 0) return null;

  if (isMobile) {
    return (
      <div className="space-y-2">
        {assetHoldings.map((h) => {
          const account = accountsMap.get(h.accountId);
          const gainAmount = h.totalGain?.local ?? 0;
          const gainPct = h.totalGainPct ?? 0;
          const currency = h.localCurrency ?? baseCurrency;
          return (
            <div key={h.accountId} className="flex items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{account?.name ?? h.accountId}</p>
                  {account?.trackingMode === "HOLDINGS" && (
                    <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                      Manual
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground text-xs">
                  <QuantityDisplay value={h.quantity} isHidden={isBalanceHidden} />{" "}
                  {quantityLabel(instrumentType)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <AmountDisplay
                  value={h.marketValue.local}
                  currency={currency}
                  isHidden={isBalanceHidden}
                  className="text-sm"
                />
                <div className="flex items-center justify-end gap-1">
                  <GainAmount
                    value={gainAmount}
                    currency={currency}
                    displayCurrency={false}
                    className="text-xs"
                  />
                  <GainPercent value={gainPct} className="text-xs" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader className="bg-muted/50">
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead className="text-right capitalize">{quantityLabel(instrumentType)}</TableHead>
            <TableHead className="text-right">Market Value</TableHead>
            <TableHead className="text-right">Cost Basis</TableHead>
            <TableHead className="text-right">Gain/Loss</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {assetHoldings.map((h) => {
            const account = accountsMap.get(h.accountId);
            const gainAmount = h.totalGain?.local ?? 0;
            const gainPct = h.totalGainPct ?? 0;
            return (
              <TableRow key={h.accountId}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {account?.name ?? h.accountId}
                    {account?.trackingMode === "HOLDINGS" && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        Manual
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <QuantityDisplay value={h.quantity} isHidden={isBalanceHidden} />
                </TableCell>
                <TableCell className="text-right">
                  <AmountDisplay
                    value={h.marketValue.local}
                    currency={h.localCurrency ?? baseCurrency}
                    isHidden={isBalanceHidden}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <AmountDisplay
                    value={h.costBasis?.local ?? 0}
                    currency={h.localCurrency ?? baseCurrency}
                    isHidden={isBalanceHidden}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <GainAmount
                      value={gainAmount}
                      currency={h.localCurrency ?? baseCurrency}
                      displayCurrency={false}
                    />
                    <GainPercent value={gainPct} variant="badge" />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

interface EnrichedSnapshot extends SnapshotInfo {
  accountId: string;
  accountName: string;
  quantity: number;
  avgCost: number;
  currency: string;
  isDetailLoading: boolean;
}

/** Snapshot history with edit/delete - lazy-loaded when tab is active */
export function AssetSnapshotHistory({
  assetId,
  baseCurrency,
  instrumentType,
}: {
  assetId: string;
  baseCurrency: string;
  instrumentType?: string | null;
}) {
  const { isBalanceHidden } = useBalancePrivacy();
  const queryClient = useQueryClient();
  const { accounts } = useAccounts();
  const isMobile = useIsMobileViewport();

  const { data: assetHoldings = [] } = useQuery<Holding[]>({
    queryKey: [QueryKeys.ASSET_HOLDINGS, assetId],
    queryFn: () => getAssetHoldings(assetId),
    enabled: !!assetId,
  });

  const accountsMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const holdingsModeAccountIds = useMemo(() => {
    return assetHoldings
      .map((h) => h.accountId)
      .filter((accountId) => accountsMap.get(accountId)?.trackingMode === "HOLDINGS");
  }, [assetHoldings, accountsMap]);

  const snapshotQueries = useQueries({
    queries: holdingsModeAccountIds.map((accountId) => ({
      queryKey: QueryKeys.snapshots(accountId),
      queryFn: () => getSnapshots(accountId),
      enabled: !!accountId,
    })),
  });

  const allSnapshots = useMemo(() => {
    const result: (SnapshotInfo & { accountId: string; accountName: string })[] = [];
    holdingsModeAccountIds.forEach((accountId, idx) => {
      const snapshots = snapshotQueries[idx]?.data ?? [];
      const accountName = accountsMap.get(accountId)?.name ?? accountId;
      for (const snap of snapshots) {
        if (snap.source === "CALCULATED" || snap.source === "SYNTHETIC") continue;
        result.push({ ...snap, accountId, accountName });
      }
    });
    result.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
    return result;
  }, [holdingsModeAccountIds, snapshotQueries, accountsMap]);

  // Fetch detailed holdings per snapshot to get avgCost for this asset
  const detailQueries = useQueries({
    queries: allSnapshots.map((snap) => ({
      queryKey: QueryKeys.snapshotHoldings(snap.accountId, snap.snapshotDate),
      queryFn: () => getSnapshotByDate(snap.accountId, snap.snapshotDate),
      enabled: !!snap.accountId,
    })),
  });

  const enrichedSnapshots: EnrichedSnapshot[] = useMemo(() => {
    return allSnapshots.map((snap, idx) => {
      const holdings = detailQueries[idx]?.data ?? [];
      const assetHolding = holdings.find(
        (h) => h.instrument?.id === assetId || h.instrument?.symbol === assetId,
      );
      const quantity = assetHolding?.quantity ?? 0;
      const costBasis = assetHolding?.costBasis?.local ?? 0;
      const avgCost = quantity > 0 ? costBasis / quantity : 0;
      const currency = assetHolding?.localCurrency ?? baseCurrency;
      return {
        ...snap,
        quantity,
        avgCost,
        currency,
        isDetailLoading: detailQueries[idx]?.isLoading ?? false,
      };
    });
  }, [allSnapshots, detailQueries, assetId, baseCurrency]);

  const [editingSnapshot, setEditingSnapshot] = useState<{
    account: Account;
    date: string;
    holdings: Holding[];
  } | null>(null);

  const [deletingSnapshot, setDeletingSnapshot] = useState<{
    accountId: string;
    date: string;
    accountName: string;
    positionCount: number;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleEditSnapshot = useCallback(
    (accountId: string, date: string) => {
      const account = accountsMap.get(accountId);
      if (!account) return;
      const accountHoldings = assetHoldings.filter((h) => h.accountId === accountId);
      setEditingSnapshot({ account, date, holdings: accountHoldings });
    },
    [accountsMap, assetHoldings],
  );

  const handleRemovePosition = useCallback(async () => {
    if (!deletingSnapshot) return;
    setIsDeleting(true);
    try {
      // Fetch full snapshot to get all positions and cash balances
      const snapshotHoldings = await getSnapshotByDate(
        deletingSnapshot.accountId,
        deletingSnapshot.date,
      );

      // Split into positions (non-cash) and cash balances
      const positions = snapshotHoldings.filter((h) => h.holdingType !== "cash");
      const remaining = positions.filter(
        (h) => h.instrument?.id !== assetId && h.instrument?.symbol !== assetId,
      );

      // Rebuild cash balances from cash holdings
      const cashBalances: Record<string, string> = {};
      for (const h of snapshotHoldings) {
        if (h.holdingType === "cash" && h.quantity > 0) {
          cashBalances[h.localCurrency] = String(h.quantity);
        }
      }

      if (remaining.length === 0 && Object.keys(cashBalances).length === 0) {
        // Nothing left — delete the entire snapshot
        await deleteSnapshot(deletingSnapshot.accountId, deletingSnapshot.date);
      } else {
        // Re-save with remaining positions
        const holdingInputs = remaining.map((h) => ({
          assetId: h.instrument?.id,
          symbol: h.instrument?.symbol ?? "",
          quantity: String(h.quantity),
          currency: h.localCurrency,
          averageCost:
            h.costBasis?.local && h.quantity > 0
              ? String(h.costBasis.local / h.quantity)
              : undefined,
        }));
        await saveManualHoldings(
          deletingSnapshot.accountId,
          holdingInputs,
          cashBalances,
          deletingSnapshot.date,
        );
      }

      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_HOLDINGS, assetId] });
      queryClient.invalidateQueries({
        queryKey: QueryKeys.snapshots(deletingSnapshot.accountId),
      });
      queryClient.invalidateQueries({
        queryKey: QueryKeys.snapshotHoldings(deletingSnapshot.accountId, deletingSnapshot.date),
      });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDING] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_HISTORY] });
      queryClient.invalidateQueries({ queryKey: [QueryKeys.PERFORMANCE_SUMMARY] });
    } finally {
      setIsDeleting(false);
      setDeletingSnapshot(null);
    }
  }, [deletingSnapshot, queryClient, assetId]);

  const handleEditClose = useCallback(() => {
    setEditingSnapshot(null);
    queryClient.invalidateQueries({ queryKey: [QueryKeys.ASSET_HOLDINGS, assetId] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
    queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDING] });
  }, [queryClient, assetId]);

  if (allSnapshots.length === 0) return null;

  return (
    <>
      {isMobile ? (
        <div className="space-y-2">
          {enrichedSnapshots.map((snap) => (
            <div
              key={`${snap.accountId}-${snap.snapshotDate}`}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{formatDate(snap.snapshotDate)}</p>
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <span className="truncate">{snap.accountName}</span>
                  <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                    {formatSource(snap.source)}
                  </Badge>
                </div>
              </div>
              <div className="shrink-0 text-right">
                {snap.isDetailLoading ? (
                  <div className="text-muted-foreground text-xs">...</div>
                ) : snap.quantity > 0 ? (
                  <>
                    <p className="text-sm">
                      <QuantityDisplay value={snap.quantity} isHidden={isBalanceHidden} />
                    </p>
                    <p className="text-muted-foreground text-xs">
                      @{" "}
                      <AmountDisplay
                        value={snap.avgCost}
                        currency={snap.currency}
                        isHidden={isBalanceHidden}
                      />
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground text-xs">-</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleEditSnapshot(snap.accountId, snap.snapshotDate)}
                >
                  <Icons.Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive h-7 w-7"
                  onClick={() =>
                    setDeletingSnapshot({
                      accountId: snap.accountId,
                      date: snap.snapshotDate,
                      accountName: snap.accountName,
                      positionCount: snap.positionCount,
                    })
                  }
                >
                  <Icons.Trash className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right capitalize">
                  {quantityLabel(instrumentType)}
                </TableHead>
                <TableHead className="text-right">Avg Cost</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {enrichedSnapshots.map((snap) => (
                <TableRow key={`${snap.accountId}-${snap.snapshotDate}`}>
                  <TableCell className="font-medium">{formatDate(snap.snapshotDate)}</TableCell>
                  <TableCell>{snap.accountName}</TableCell>
                  <TableCell className="text-right">
                    {snap.isDetailLoading ? (
                      <span className="text-muted-foreground">...</span>
                    ) : snap.quantity > 0 ? (
                      <QuantityDisplay value={snap.quantity} isHidden={isBalanceHidden} />
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {snap.isDetailLoading ? (
                      <span className="text-muted-foreground">...</span>
                    ) : snap.avgCost > 0 ? (
                      <AmountDisplay
                        value={snap.avgCost}
                        currency={snap.currency}
                        isHidden={isBalanceHidden}
                      />
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      {formatSource(snap.source)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleEditSnapshot(snap.accountId, snap.snapshotDate)}
                      >
                        <Icons.Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-7 w-7"
                        onClick={() =>
                          setDeletingSnapshot({
                            accountId: snap.accountId,
                            date: snap.snapshotDate,
                            accountName: snap.accountName,
                            positionCount: snap.positionCount,
                          })
                        }
                      >
                        <Icons.Trash className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editingSnapshot && (
        <Sheet open={!!editingSnapshot} onOpenChange={() => handleEditClose()}>
          <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-2xl">
            <SheetHeader className="border-b px-6 py-4">
              <SheetTitle>Update Holdings</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-hidden px-6">
              <HoldingsEditMode
                holdings={editingSnapshot.holdings}
                account={editingSnapshot.account}
                isLoading={false}
                onClose={handleEditClose}
                existingSnapshotDate={editingSnapshot.date}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      <AlertDialog open={!!deletingSnapshot} onOpenChange={() => setDeletingSnapshot(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Position</AlertDialogTitle>
            <AlertDialogDescription>
              Remove this asset from the {deletingSnapshot?.accountName} snapshot on{" "}
              {deletingSnapshot?.date ? formatDate(deletingSnapshot.date) : ""}? The other positions
              in the snapshot will be kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemovePosition}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function formatSource(source: string): string {
  switch (source) {
    case "MANUAL_ENTRY":
      return "Manual";
    case "CSV_IMPORT":
      return "CSV";
    case "BROKER_IMPORTED":
      return "Broker";
    default:
      return source;
  }
}
