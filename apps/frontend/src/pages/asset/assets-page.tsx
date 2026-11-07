import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { HoldingsScopeNotice } from "@/components/holdings-scope-notice";
import { useIsCompactTableViewport } from "@/hooks/use-platform";
import { useSyncMarketDataMutation } from "@/hooks/use-sync-market-data";
import { useSettingsContext } from "@/lib/settings-provider";
import type { LatestQuoteSnapshot } from "@/lib/types";
import { SettingsHeader } from "../settings/settings-header";
import { AssetEditSheet } from "./asset-edit-sheet";
import { isExpiredOptionAsset, ParsedAsset, toParsedAsset } from "./asset-utils";
import { AssetsTable } from "./assets-table";
import { AssetsTableMobile } from "./assets-table-mobile";
import { CreateSecurityDialog } from "./create-security-dialog";
import { useAssetManagement } from "./hooks/use-asset-management";
import { useAssets } from "./hooks/use-assets";
import { useLatestQuotes } from "./hooks/use-latest-quotes";

const NO_QUOTES: Record<string, LatestQuoteSnapshot> = {};

export default function AssetsPage() {
  const { t } = useTranslation();
  const { assets, isLoading } = useAssets();
  const { createAssetMutation, deleteAssetMutation } = useAssetManagement();
  const refetchQuotesMutation = useSyncMarketDataMutation(true);
  const updateQuotesMutation = useSyncMarketDataMutation(false);
  const isCompactTableViewport = useIsCompactTableViewport();
  const holdingsQuery = useHoldings({ type: "all" });
  const { holdings } = holdingsQuery;
  const { settings } = useSettingsContext();
  const appTimezone = settings?.timezone?.trim() || undefined;

  const heldAssetIds = useMemo(() => {
    if (!holdingsQuery.isComplete) return null;
    const ids = new Set<string>();
    for (const h of holdings) {
      if (h.instrument?.id) {
        ids.add(h.instrument.id);
      }
    }
    return ids;
  }, [holdings, holdingsQuery.isComplete]);

  const parsedAssets = useMemo(() => assets.map(toParsedAsset), [assets]);
  const visibleAssets = useMemo(
    () => parsedAssets.filter((asset) => !isExpiredOptionAsset(asset, appTimezone)),
    [parsedAssets, appTimezone],
  );
  const assetIds = useMemo(() => visibleAssets.map((asset) => asset.id), [visibleAssets]);
  const { data: latestQuotes = NO_QUOTES, isLoading: isQuotesLoading } = useLatestQuotes(assetIds);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<ParsedAsset | null>(null);
  const [assetPendingDelete, setAssetPendingDelete] = useState<ParsedAsset | null>(null);
  const [assetPendingRefetch, setAssetPendingRefetch] = useState<ParsedAsset | null>(null);

  // The tables build their columns from these. New functions on each render (every
  // holdings refetch) would remount the rows and close an open row menu.
  const { mutate: updateQuotes } = updateQuotesMutation;
  const updateAssetQuotes = useCallback(
    (asset: ParsedAsset) => updateQuotes([asset.id]),
    [updateQuotes],
  );

  const handleDelete = async () => {
    if (!assetPendingDelete) return;
    await deleteAssetMutation.mutateAsync(assetPendingDelete.id);
    setAssetPendingDelete(null);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings:nav.items.securities")}
        text={t("asset:securities.subtitle")}
        actionsInline
      >
        <>
          <Button
            size="icon"
            className="sm:hidden"
            onClick={() => setCreateDialogOpen(true)}
            aria-label={t("asset:securities.add_security")}
          >
            <Icons.Plus className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            className="hidden sm:inline-flex"
            onClick={() => setCreateDialogOpen(true)}
          >
            <Icons.Plus className="me-2 h-4 w-4" />
            {t("asset:securities.add_security")}
          </Button>
        </>
      </SettingsHeader>
      <Separator />
      <HoldingsScopeNotice {...holdingsQuery} />
      <div className="w-full">
        {isCompactTableViewport ? (
          <AssetsTableMobile
            assets={visibleAssets}
            latestQuotes={latestQuotes}
            heldAssetIds={heldAssetIds}
            isLoading={isLoading || isQuotesLoading}
            onEdit={setEditingAsset}
            onDelete={setAssetPendingDelete}
            onUpdateQuotes={updateAssetQuotes}
            onRefetchQuotes={setAssetPendingRefetch}
            isUpdatingQuotes={updateQuotesMutation.isPending}
            isRefetchingQuotes={refetchQuotesMutation.isPending}
          />
        ) : (
          <AssetsTable
            assets={visibleAssets}
            latestQuotes={latestQuotes}
            heldAssetIds={heldAssetIds}
            isLoading={isLoading || isQuotesLoading}
            onEdit={setEditingAsset}
            onDelete={setAssetPendingDelete}
            onUpdateQuotes={updateAssetQuotes}
            onRefetchQuotes={setAssetPendingRefetch}
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
            <AlertDialogTitle>{t("asset:securities.delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {assetPendingDelete
                ? t("asset:securities.delete_description_named", {
                    name:
                      assetPendingDelete.displayCode ??
                      assetPendingDelete.name ??
                      t("asset:securities.delete_fallback_name"),
                  })
                : t("asset:securities.delete_description_generic")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteAssetMutation.isPending}
              variant="destructive"
            >
              {deleteAssetMutation.isPending ? t("asset:securities.deleting") : t("common:delete")}
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
          // Closes once the save itself ends: React Query skips callbacks passed
          // to mutate() while a phone screen is out of sight, which left the
          // dialog open, ready to create the security a second time.
          void createAssetMutation.mutateAsync(payload).then(
            () => setCreateDialogOpen(false),
            // The mutation reports the error; the dialog stays open to try again.
            () => undefined,
          );
        }}
        isPending={createAssetMutation.isPending}
      />
    </div>
  );
}
