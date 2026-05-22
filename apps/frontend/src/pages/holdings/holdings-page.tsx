import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { EmptyPlaceholder } from "@wealthfolio/ui";
import { useCallback, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { SwipablePage, SwipablePageView } from "@/components/page";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { useAccounts } from "@/hooks/use-accounts";
import { useHoldings } from "@/hooks/use-holdings";
import { usePortfolios } from "@/hooks/use-portfolios";
import {
  useAlternativeHoldings,
  useDeleteAlternativeAsset,
  useLinkLiability,
  useUnlinkLiability,
} from "@/hooks/use-alternative-assets";
import { usePersistentState } from "@/hooks/use-persistent-state";
import {
  PORTFOLIO_ACCOUNT_ID,
  HOLDING_CATEGORY_FILTERS,
  apiKindToAlternativeAssetKind,
} from "@/lib/constants";
import {
  Account,
  AccountScope,
  HoldingType,
  AlternativeAssetHolding,
  AlternativeAssetKind,
} from "@/lib/types";
import { canAddHoldings } from "@/lib/activity-restrictions";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { HoldingsMobileFilterSheet } from "./components/holdings-mobile-filter-sheet";
import { HoldingsTable } from "./components/holdings-table";
import { HoldingsTableMobile } from "./components/holdings-table-mobile";
import { AlternativeHoldingsTable } from "./components/alternative-holdings-table";
import { AlternativeHoldingsListMobile } from "./components/alternative-holdings-list-mobile";
import { HoldingsEditMode } from "./components/holdings-edit-mode";
import {
  AlternativeAssetQuickAddModal,
  AssetDetailsSheet,
  UpdateValuationModal,
  type AssetDetailsSheetAsset,
  type LinkableAsset,
  type LinkedLiability,
} from "@/pages/asset/alternative-assets";
import { updateAlternativeAssetMetadata } from "@/adapters";
import { ClassificationSheet } from "@/components/classification/classification-sheet";
import { useUpdatePortfolioMutation } from "@/hooks/use-calculate-portfolio";
import { useQueryClient } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";

export const HoldingsPage = () => {
  const isMobileViewport = useIsMobileViewport();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentTab = searchParams.get("tab") ?? "investments";
  const queryClient = useQueryClient();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const [accountFilter, setAccountScope] = useState<AccountScope>({ type: "all" });

  // Keep selectedAccount for edit/add functionality when a specific account is selected.
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const { holdings, isLoading } = useHoldings(accountFilter);
  const { accounts, isLoading: isAccountsLoading } = useAccounts();
  const { data: portfolios = [] } = usePortfolios();
  const { data: alternativeHoldings, isLoading: isAlternativeHoldingsLoading } =
    useAlternativeHoldings();

  // Mobile filter state
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const [isAlternativeAssetModalOpen, setIsAlternativeAssetModalOpen] = useState(false);
  const [sortBy, setSortBy] = usePersistentState<"symbol" | "marketValue">(
    "holdings-sort-by",
    "marketValue",
  );
  const [showTotalReturn, setShowTotalReturn] = usePersistentState<boolean>(
    "holdings-show-total-return",
    true,
  );

  // Alternative asset action state
  const [editAsset, setEditAsset] = useState<AssetDetailsSheetAsset | null>(null);
  const [updateValueAsset, setUpdateValueAsset] = useState<AlternativeAssetHolding | null>(null);
  const [isSavingDetails, setIsSavingDetails] = useState(false);

  // Delete mutation
  const { mutate: deleteAsset, isPending: isDeleting } = useDeleteAlternativeAsset();

  // Linking mutations
  const linkLiabilityMutation = useLinkLiability();
  const unlinkLiabilityMutation = useUnlinkLiability();

  // State for chained liability creation (when creating property with mortgage checkbox)
  const [pendingLiabilityLink, setPendingLiabilityLink] = useState<string | null>(null);
  const [pendingLiabilityType, setPendingLiabilityType] = useState<string | undefined>(undefined);
  const [pendingOriginationDate, setPendingOriginationDate] = useState<Date | undefined>(undefined);
  const [pendingMortgageName, setPendingMortgageName] = useState<string | undefined>(undefined);

  // Classification sheet state
  const [classifyAsset, setClassifyAsset] = useState<{
    id: string;
    symbol: string;
    name?: string;
  } | null>(null);

  // Edit mode state for HOLDINGS-mode accounts
  const [isEditMode, setIsEditMode] = useState(false);

  // Action palette state
  const [isActionPaletteOpen, setIsActionPaletteOpen] = useState(false);
  const [modalDefaultKind, setModalDefaultKind] = useState<AlternativeAssetKind | undefined>(
    undefined,
  );
  const updatePortfolioMutation = useUpdatePortfolioMutation();

  const handleAccountScopeChange = useCallback(
    (filter: AccountScope) => {
      setAccountScope(filter);
      setIsEditMode(false);
      setSelectedAccount(
        filter.type === "account"
          ? (accounts.find((account) => account.id === filter.accountId) ?? null)
          : null,
      );
    },
    [accounts],
  );

  // Check if the selected account supports manual holdings editing
  const canEditHoldings = useMemo(() => {
    if (!selectedAccount || selectedAccount.id === PORTFOLIO_ACCOUNT_ID) {
      return false;
    }
    return canAddHoldings(selectedAccount);
  }, [selectedAccount]);

  // Handler to convert AlternativeAssetHolding to AssetDetailsSheetAsset for editing
  const handleEditAsset = useCallback((holding: AlternativeAssetHolding) => {
    const assetForSheet: AssetDetailsSheetAsset = {
      id: holding.id,
      name: holding.name,
      kind: apiKindToAlternativeAssetKind(holding.kind),
      currency: holding.currency,
      metadata: holding.metadata,
    };
    setEditAsset(assetForSheet);
  }, []);

  // Handler to save asset details
  const handleSaveAssetDetails = useCallback(
    async (assetId: string, metadata: Record<string, string>, name?: string) => {
      setIsSavingDetails(true);
      try {
        await updateAlternativeAssetMetadata(assetId, metadata, name);
        // Invalidate queries to refresh the list
        queryClient.invalidateQueries({ queryKey: [QueryKeys.ALTERNATIVE_HOLDINGS] });
        queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH] });
      } finally {
        setIsSavingDetails(false);
      }
    },
    [queryClient],
  );

  // Handler to delete an asset
  const handleDeleteAsset = useCallback(
    (holding: AlternativeAssetHolding) => {
      deleteAsset(holding.id);
    },
    [deleteAsset],
  );

  // Handler to view value history for an asset
  const handleViewHistory = useCallback(
    (holding: AlternativeAssetHolding) => {
      navigate(`/holdings/${encodeURIComponent(holding.id)}?tab=history`);
    },
    [navigate],
  );

  // Handler to navigate to asset detail page
  const handleRowClick = useCallback(
    (holding: AlternativeAssetHolding) => {
      navigate(`/holdings/${encodeURIComponent(holding.id)}`);
    },
    [navigate],
  );

  // Get the investments filter config
  const investmentsFilter = useMemo(() => {
    return HOLDING_CATEGORY_FILTERS.find((f) => f.id === "investments");
  }, []);

  // Filter alternative holdings for assets (non-liability)
  const assetsHoldings = useMemo(() => {
    if (!alternativeHoldings) return [];
    return alternativeHoldings.filter((h) => h.kind !== "liability");
  }, [alternativeHoldings]);

  // Filter alternative holdings for liabilities
  const liabilitiesHoldings = useMemo(() => {
    if (!alternativeHoldings) return [];
    return alternativeHoldings.filter((h) => h.kind === "liability");
  }, [alternativeHoldings]);

  // Linkable assets for liability creation/editing (properties and vehicles)
  const linkableAssets: LinkableAsset[] = useMemo(() => {
    return assetsHoldings
      .filter((h) => h.kind === "property" || h.kind === "vehicle")
      .map((h) => ({ id: h.id, name: h.name }));
  }, [assetsHoldings]);

  // Get linked liabilities for a property (mortgages that have linked_asset_id matching the property)
  const getLinkedLiabilities = useCallback(
    (propertyId: string): LinkedLiability[] => {
      return liabilitiesHoldings
        .filter((h) => {
          const metadata = h.metadata as Record<string, unknown> | null | undefined;
          const linkedAssetId = metadata?.linked_asset_id;
          return linkedAssetId === propertyId;
        })
        .map((h) => ({
          id: h.id,
          name: h.name,
          balance: h.marketValue,
        }));
    },
    [liabilitiesHoldings],
  );

  // Get available (unlinked) mortgages for linking to a property
  const getAvailableMortgages = useCallback(
    (excludePropertyId?: string): LinkedLiability[] => {
      return liabilitiesHoldings
        .filter((h) => {
          const metadata = h.metadata as Record<string, unknown> | null | undefined;
          const liabilityType = metadata?.liability_type;
          const linkedAssetId = metadata?.linked_asset_id;
          // Only mortgages that are not linked to any asset (or linked to this property for re-linking)
          return (
            liabilityType === "mortgage" && (!linkedAssetId || linkedAssetId === excludePropertyId)
          );
        })
        .map((h) => ({
          id: h.id,
          name: h.name,
          balance: h.marketValue,
        }));
    },
    [liabilitiesHoldings],
  );

  // Get the name of the asset linked to a liability
  const getLinkedAssetName = useCallback(
    (liabilityMetadata?: Record<string, unknown>): string | undefined => {
      const linkedAssetId = liabilityMetadata?.linked_asset_id as string | undefined;
      if (!linkedAssetId) return undefined;
      const linkedAsset = assetsHoldings.find((h) => h.id === linkedAssetId);
      return linkedAsset?.name;
    },
    [assetsHoldings],
  );

  // Handler for chained liability creation (called when property is created with mortgage checkbox)
  const handleOpenLiabilityQuickAdd = useCallback(
    (propertyId: string, purchaseDate?: Date, propertyName?: string) => {
      setPendingLiabilityLink(propertyId);
      setPendingLiabilityType("mortgage");
      setPendingOriginationDate(purchaseDate);
      setPendingMortgageName(propertyName ? `${propertyName} Mortgage` : undefined);
      setModalDefaultKind(AlternativeAssetKind.LIABILITY);
      setIsAlternativeAssetModalOpen(true);
    },
    [],
  );

  // Handler for linking a mortgage to a property
  const handleLinkMortgage = useCallback(
    async (mortgageId: string) => {
      if (!editAsset) return;
      await linkLiabilityMutation.mutateAsync({
        liabilityId: mortgageId,
        targetAssetId: editAsset.id,
      });
    },
    [editAsset, linkLiabilityMutation],
  );

  // Handler for unlinking a mortgage from a property
  const handleUnlinkMortgage = useCallback(
    async (mortgageId: string) => {
      await unlinkLiabilityMutation.mutateAsync(mortgageId);
    },
    [unlinkLiabilityMutation],
  );

  // Process investment holdings
  const { nonCashHoldings, filteredHoldings, availableTypeOptions } = useMemo(() => {
    const nonCash =
      holdings?.filter((holding) => holding.holdingType?.toLowerCase() !== HoldingType.CASH) ?? [];

    let filtered = nonCash;
    if (investmentsFilter?.assetKinds) {
      const allowedKinds = investmentsFilter.assetKinds as readonly string[];
      filtered = nonCash.filter((holding) => {
        return holding.assetKind && allowedKinds.includes(holding.assetKind);
      });
    }

    // Build available type options from taxonomy classifications
    const typeSet = new Set<string>();
    const typeOptions: { value: string; label: string }[] = [];
    for (const h of filtered) {
      const name = h.instrument?.classifications?.assetType?.name;
      if (name && !typeSet.has(name)) {
        typeSet.add(name);
        typeOptions.push({ value: name, label: name });
      }
    }

    if (selectedTypes.length > 0) {
      filtered = filtered.filter((holding) => {
        const assetType = holding.instrument?.classifications?.assetType?.name;
        return assetType && selectedTypes.includes(assetType);
      });
    }

    return {
      nonCashHoldings: nonCash,
      filteredHoldings: filtered,
      availableTypeOptions: typeOptions,
    };
  }, [holdings, selectedTypes, investmentsFilter]);

  // Combined loading state
  const isDataLoading = isLoading || isAccountsLoading || isAlternativeHoldingsLoading;

  // Empty state checks
  const hasNoInvestments = !isDataLoading && (!nonCashHoldings || nonCashHoldings.length === 0);
  const hasNoAssets = !isDataLoading && assetsHoldings.length === 0;
  const hasNoLiabilities = !isDataLoading && liabilitiesHoldings.length === 0;

  // Investments content
  const investmentsContent = (
    <>
      {/* Edit Mode for HOLDINGS-mode accounts */}
      {isEditMode && selectedAccount && canEditHoldings ? (
        <HoldingsEditMode
          holdings={holdings ?? []}
          account={selectedAccount}
          isLoading={isDataLoading}
          onClose={() => setIsEditMode(false)}
        />
      ) : hasNoInvestments ? (
        <div className="flex items-center justify-center py-16">
          <EmptyPlaceholder
            icon={<Icons.TrendingUp className="text-muted-foreground h-10 w-10" />}
            title="No holdings yet"
            description={
              canEditHoldings
                ? "Get started by updating your holdings or importing from a CSV file."
                : "Get started by adding your first transaction or quickly import your existing holdings from a CSV file."
            }
          >
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              {canEditHoldings ? (
                <>
                  <Button size="default" onClick={() => setIsEditMode(true)}>
                    <Icons.Pencil className="mr-2 h-4 w-4" />
                    Update Holdings
                  </Button>
                  <Button size="default" variant="outline" onClick={() => navigate("/import")}>
                    <Icons.Import className="mr-2 h-4 w-4" />
                    Import from CSV
                  </Button>
                </>
              ) : (
                <>
                  <Button size="default" onClick={() => navigate("/activities/manage")}>
                    <Icons.Plus className="mr-2 h-4 w-4" />
                    Add Transaction
                  </Button>
                  <Button size="default" variant="outline" onClick={() => navigate("/import")}>
                    <Icons.Import className="mr-2 h-4 w-4" />
                    Import from CSV
                  </Button>
                </>
              )}
            </div>
          </EmptyPlaceholder>
        </div>
      ) : (
        <>
          {/* Desktop View */}
          <div className="hidden md:block">
            <HoldingsTable
              holdings={filteredHoldings ?? []}
              isLoading={isDataLoading}
              showTotalReturn={showTotalReturn}
              setShowTotalReturn={setShowTotalReturn}
              onClassify={(holding) =>
                setClassifyAsset({
                  id: holding.instrument?.id ?? holding.id,
                  symbol: holding.instrument?.symbol ?? holding.id,
                  name: holding.instrument?.name ?? undefined,
                })
              }
            />
          </div>

          {/* Mobile View */}
          <div className="block md:hidden">
            <HoldingsTableMobile
              holdings={nonCashHoldings ?? []}
              isLoading={isDataLoading}
              selectedTypes={selectedTypes}
              setSelectedTypes={setSelectedTypes}
              accountFilter={accountFilter}
              onAccountScopeChange={handleAccountScopeChange}
              accounts={accounts ?? []}
              portfolios={portfolios}
              showSearch={true}
              showFilterButton={false}
              sortBy={sortBy}
              showTotalReturn={showTotalReturn}
              typeOptions={availableTypeOptions}
            />
          </div>
        </>
      )}
    </>
  );

  // Personal Assets content
  const assetsContent = (
    <>
      {hasNoAssets ? (
        <div className="flex items-center justify-center py-16">
          <EmptyPlaceholder
            icon={<Icons.Wallet className="text-muted-foreground h-10 w-10" />}
            title="No assets yet"
            description="Add your first property, vehicle, collectible, or other asset."
          >
            <Button size="default" onClick={() => setIsAlternativeAssetModalOpen(true)}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add Asset
            </Button>
          </EmptyPlaceholder>
        </div>
      ) : (
        <>
          {/* Desktop View */}
          <div className="hidden md:block">
            <AlternativeHoldingsTable
              holdings={assetsHoldings}
              isLoading={isDataLoading}
              emptyTitle="No assets"
              emptyDescription="Add your first asset using the button above."
              onEdit={handleEditAsset}
              onUpdateValue={setUpdateValueAsset}
              onViewHistory={handleViewHistory}
              onDelete={handleDeleteAsset}
              onRowClick={handleRowClick}
              isDeleting={isDeleting}
            />
          </div>
          {/* Mobile View */}
          <div className="block md:hidden">
            <AlternativeHoldingsListMobile
              holdings={assetsHoldings}
              isLoading={isDataLoading}
              onRowClick={handleRowClick}
            />
          </div>
        </>
      )}
    </>
  );

  // Liabilities content
  const liabilitiesContent = (
    <>
      {hasNoLiabilities ? (
        <div className="flex items-center justify-center py-16">
          <EmptyPlaceholder
            icon={<Icons.CreditCard className="text-muted-foreground h-10 w-10" />}
            title="No liabilities yet"
            description="Track your mortgages, loans, and other debts."
          >
            <Button size="default" onClick={() => setIsAlternativeAssetModalOpen(true)}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              Add Liability
            </Button>
          </EmptyPlaceholder>
        </div>
      ) : (
        <>
          {/* Desktop View */}
          <div className="hidden md:block">
            <AlternativeHoldingsTable
              holdings={liabilitiesHoldings}
              isLoading={isDataLoading}
              emptyTitle="No liabilities"
              emptyDescription="Add your first liability using the button above."
              onEdit={handleEditAsset}
              onUpdateValue={setUpdateValueAsset}
              onViewHistory={handleViewHistory}
              onDelete={handleDeleteAsset}
              onRowClick={handleRowClick}
              isDeleting={isDeleting}
            />
          </div>
          {/* Mobile View */}
          <div className="block md:hidden">
            <AlternativeHoldingsListMobile
              holdings={liabilitiesHoldings}
              isLoading={isDataLoading}
              onRowClick={handleRowClick}
            />
          </div>
        </>
      )}
    </>
  );

  // Action palette groups
  const actionPaletteGroups: ActionPaletteGroup[] = useMemo(
    () => [
      {
        items: [
          {
            icon: Icons.Wallet,
            label: "Add Asset",
            onClick: () => {
              setModalDefaultKind(undefined);
              setIsAlternativeAssetModalOpen(true);
            },
          },
          {
            icon: Icons.CreditCard,
            label: "Add Liability",
            onClick: () => {
              setModalDefaultKind(AlternativeAssetKind.LIABILITY);
              setIsAlternativeAssetModalOpen(true);
            },
          },
          {
            icon: Icons.Plus,
            label: "Add Activity",
            onClick: () => navigate("/activities/manage"),
          },
          {
            icon: Icons.Refresh,
            label: "Update Prices",
            onClick: () => updatePortfolioMutation.mutate(),
          },
        ],
      },
    ],
    [navigate, updatePortfolioMutation],
  );

  // Shared actions for header
  const sharedActions = useMemo(
    () => (
      <>
        {isMobileViewport && currentTab === "investments" ? (
          <Button
            size="icon-sm"
            variant="outline"
            className="h-9 w-9 rounded-full"
            onClick={() => setIsFilterSheetOpen(true)}
            aria-label="Open holdings filters"
          >
            <Icons.ListFilter className="h-4 w-4" />
          </Button>
        ) : (
          <AccountScopeSelector value={accountFilter} onChange={handleAccountScopeChange} />
        )}
        {/* Show Update button for HOLDINGS-mode manual accounts (only on investments tab) */}
        {canEditHoldings && !isEditMode && currentTab === "investments" && (
          <Button size="sm" variant="outline" onClick={() => setIsEditMode(true)}>
            <Icons.Pencil className="mr-2 h-4 w-4" />
            Update
          </Button>
        )}
        <ActionPalette
          open={isActionPaletteOpen}
          onOpenChange={setIsActionPaletteOpen}
          groups={actionPaletteGroups}
        />
      </>
    ),
    [
      isMobileViewport,
      setIsFilterSheetOpen,
      accountFilter,
      handleAccountScopeChange,
      canEditHoldings,
      isEditMode,
      currentTab,
      isActionPaletteOpen,
      actionPaletteGroups,
    ],
  );

  // Define the swipeable views
  const views: SwipablePageView[] = useMemo(
    () => [
      {
        value: "investments",
        label: "Investments",
        icon: Icons.TrendingUp,
        content: investmentsContent,
        actions: sharedActions,
      },
      {
        value: "assets",
        label: "Assets",
        icon: Icons.Wallet,
        content: assetsContent,
        actions: sharedActions,
      },
      {
        value: "liabilities",
        label: "Liabilities",
        icon: Icons.CreditCard,
        content: liabilitiesContent,
        actions: sharedActions,
      },
    ],
    [investmentsContent, assetsContent, liabilitiesContent, sharedActions],
  );

  // Determine defaultKind for modal - explicit state takes precedence, then fall back to current tab
  const getDefaultKindForModal = (): AlternativeAssetKind | undefined => {
    if (modalDefaultKind !== undefined) return modalDefaultKind;
    if (currentTab === "liabilities") return AlternativeAssetKind.LIABILITY;
    return undefined;
  };

  return (
    <>
      <SwipablePage views={views} defaultView="investments" />

      {/* Mobile Filter Sheet */}
      <HoldingsMobileFilterSheet
        open={isFilterSheetOpen}
        onOpenChange={setIsFilterSheetOpen}
        accountFilter={accountFilter}
        onAccountScopeChange={handleAccountScopeChange}
        accounts={accounts ?? []}
        portfolios={portfolios}
        selectedTypes={selectedTypes}
        setSelectedTypes={setSelectedTypes}
        sortBy={sortBy}
        setSortBy={setSortBy}
        showTotalReturn={showTotalReturn}
        setShowTotalReturn={setShowTotalReturn}
        typeOptions={availableTypeOptions}
      />

      {/* Alternative Asset Quick Add Modal */}
      <AlternativeAssetQuickAddModal
        open={isAlternativeAssetModalOpen}
        onOpenChange={(open) => {
          setIsAlternativeAssetModalOpen(open);
          if (!open) {
            setModalDefaultKind(undefined);
            setPendingLiabilityLink(null);
            setPendingLiabilityType(undefined);
            setPendingOriginationDate(undefined);
            setPendingMortgageName(undefined);
          }
        }}
        defaultKind={getDefaultKindForModal()}
        linkableAssets={linkableAssets}
        linkedAssetId={pendingLiabilityLink ?? undefined}
        defaultLiabilityType={pendingLiabilityType}
        defaultOriginationDate={pendingOriginationDate}
        defaultName={pendingMortgageName}
        onOpenLiabilityQuickAdd={handleOpenLiabilityQuickAdd}
      />

      {/* Asset Details Sheet (Edit) */}
      <AssetDetailsSheet
        open={editAsset !== null}
        onOpenChange={(open) => !open && setEditAsset(null)}
        asset={editAsset}
        onSave={handleSaveAssetDetails}
        isSaving={isSavingDetails}
        linkableAssets={linkableAssets}
        linkedAssetName={getLinkedAssetName(editAsset?.metadata)}
        linkedLiabilities={editAsset ? getLinkedLiabilities(editAsset.id) : []}
        availableMortgages={editAsset ? getAvailableMortgages(editAsset.id) : []}
        onLinkMortgage={handleLinkMortgage}
        onUnlinkMortgage={handleUnlinkMortgage}
      />

      {/* Update Valuation Modal */}
      <UpdateValuationModal
        open={updateValueAsset !== null}
        onOpenChange={(open) => !open && setUpdateValueAsset(null)}
        assetId={updateValueAsset?.id ?? ""}
        assetName={updateValueAsset?.name ?? ""}
        currentValue={updateValueAsset?.marketValue ?? "0"}
        lastUpdatedDate={updateValueAsset?.valuationDate?.split("T")[0] ?? ""}
        currency={updateValueAsset?.currency ?? baseCurrency}
      />

      {/* Classification Sheet */}
      <ClassificationSheet
        open={!!classifyAsset}
        onOpenChange={(open) => !open && setClassifyAsset(null)}
        assetId={classifyAsset?.id ?? ""}
        assetSymbol={classifyAsset?.symbol}
        assetName={classifyAsset?.name}
      />
    </>
  );
};

export default HoldingsPage;
