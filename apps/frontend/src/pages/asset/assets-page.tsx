import { useMemo, useState } from "react";

import { Separator } from "@wealthfolio/ui";
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
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { RefreshQuotesConfirmDialog } from "./refresh-quotes-confirm-dialog";

import { useHoldings } from "@/hooks/use-holdings";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useSyncMarketDataMutation } from "@/hooks/use-sync-market-data";
import { useSettingsContext } from "@/lib/settings-provider";
import { SettingsHeader } from "../settings/settings-header";
import { AssetEditSheet } from "./asset-edit-sheet";
import { isExpiredOptionAsset, ParsedAsset, toParsedAsset } from "./asset-utils";
import { AssetsTable } from "./assets-table";
import { AssetsTableMobile } from "./assets-table-mobile";
import { CreateSecurityDialog } from "./create-security-dialog";
import { useAssetManagement } from "./hooks/use-asset-management";
import { useAssets } from "./hooks/use-assets";
import { useLatestQuotes } from "./hooks/use-latest-quotes";

export default function AssetsPage() {
  const { assets, isLoading } = useAssets();
  const { createAssetMutation, deleteAssetMutation } = useAssetManagement();
  const refetchQuotesMutation = useSyncMarketDataMutation(true);
  const updateQuotesMutation = useSyncMarketDataMutation(false);
  const isMobileViewport = useIsMobileViewport();
  const { holdings } = useHoldings({ type: "all" });
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;

  const heldAssetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const h of holdings) {
      if (h.instrument?.id) {
        ids.add(h.instrument.id);
      }
    }
    return ids;
  }, [holdings]);

  const parsedAssets = useMemo(() => assets.map(toParsedAsset), [assets]);
  const visibleAssets = useMemo(
    () => parsedAssets.filter((asset) => !isExpiredOptionAsset(asset, appTimezone)),
    [parsedAssets, appTimezone],
  );
  const assetIds = useMemo(() => visibleAssets.map((asset) => asset.id), [visibleAssets]);
  const { data: latestQuotes = {}, isLoading: isQuotesLoading } = useLatestQuotes(assetIds);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<ParsedAsset | null>(null);
  const [assetPendingDelete, setAssetPendingDelete] = useState<ParsedAsset | null>(null);
  const [assetPendingRefetch, setAssetPendingRefetch] = useState<ParsedAsset | null>(null);

  const handleDelete = async () => {
    if (!assetPendingDelete) return;
    await deleteAssetMutation.mutateAsync(assetPendingDelete.id);
    setAssetPendingDelete(null);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading="Securities"
        text="Browse and manage the securities available in your portfolio."
      >
        <Button onClick={() => setCreateDialogOpen(true)} size="sm">
          <Icons.Plus className="mr-2 h-4 w-4" />
          Add Security
        </Button>
      </SettingsHeader>
      <Separator />
      <div className="w-full">
        {isMobileViewport ? (
          <AssetsTableMobile
            assets={visibleAssets}
            latestQuotes={latestQuotes}
            heldAssetIds={heldAssetIds}
            isLoading={isLoading || isQuotesLoading}
            onEdit={(asset) => setEditingAsset(asset)}
            onDelete={(asset) => setAssetPendingDelete(asset)}
            onUpdateQuotes={(asset) => updateQuotesMutation.mutate([asset.id])}
            onRefetchQuotes={(asset) => setAssetPendingRefetch(asset)}
            isUpdatingQuotes={updateQuotesMutation.isPending}
            isRefetchingQuotes={refetchQuotesMutation.isPending}
          />
        ) : (
          <AssetsTable
            assets={visibleAssets}
            latestQuotes={latestQuotes}
            heldAssetIds={heldAssetIds}
            isLoading={isLoading || isQuotesLoading}
            onEdit={(asset) => setEditingAsset(asset)}
            onDelete={(asset) => setAssetPendingDelete(asset)}
            onUpdateQuotes={(asset) => updateQuotesMutation.mutate([asset.id])}
            onRefetchQuotes={(asset) => setAssetPendingRefetch(asset)}
            isUpdatingQuotes={updateQuotesMutation.isPending}
            isRefetchingQuotes={refetchQuotesMutation.isPending}
          />
        )}
      </div>

      <AssetEditSheet
        asset={editingAsset}
        latestQuote={editingAsset ? (latestQuotes[editingAsset.id]?.quote ?? null) : null}
        open={!!editingAsset}
        onOpenChange={(open) => {
          if (!open) {
            setEditingAsset(null);
          }
        }}
      />

      <AlertDialog
        open={!!assetPendingDelete}
        onOpenChange={(open) => {
          if (!open) {
            setAssetPendingDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete security</AlertDialogTitle>
            <AlertDialogDescription>
              {assetPendingDelete
                ? `Are you sure you want to delete ${assetPendingDelete.displayCode ?? assetPendingDelete.name ?? "this security"}? This will also remove its related quote and cannot be undone.`
                : "Are you sure you want to delete this security? This will also remove related quotes and cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteAssetMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 dark:text-foreground"
            >
              {deleteAssetMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RefreshQuotesConfirmDialog
        open={!!assetPendingRefetch}
        onOpenChange={(open) => {
          if (!open) setAssetPendingRefetch(null);
        }}
        onConfirm={() => {
          if (assetPendingRefetch) {
            refetchQuotesMutation.mutate([assetPendingRefetch.id]);
          }
          setAssetPendingRefetch(null);
        }}
        assetName={assetPendingRefetch?.displayCode ?? assetPendingRefetch?.name ?? undefined}
      />

      <CreateSecurityDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={(payload) => {
          createAssetMutation.mutate(payload, {
            onSuccess: () => setCreateDialogOpen(false),
          });
        }}
        isPending={createAssetMutation.isPending}
      />
    </div>
  );
}
