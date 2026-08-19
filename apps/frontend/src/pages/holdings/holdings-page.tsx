import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { EmptyPlaceholder } from "@wealthfolio/ui";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { SwipablePage, SwipablePageView } from "@/components/page";
import { AccountScopeSelector } from "@/components/account-filter-selector";
import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { useAccounts } from "@/hooks/use-accounts";
import { useHoldingsWithClosedProbe } from "@/hooks/use-holdings";
import { usePortfolios } from "@/hooks/use-portfolios";
import {
  useAlternativeHoldings,
  useDeleteAlternativeAsset,
  useLinkLiability,
  useUnlinkLiability,
} from "@/hooks/use-alternative-assets";
import { usePersistentState } from "@/hooks/use-persistent-state";
import {
  AccountPurpose,
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
import { HoldingsTable } from "./components/holdings-table";
import { HoldingsTableMobile } from "./components/holdings-table-mobile";
import { AlternativeHoldingsTable } from "./components/alternative-holdings-table";
import { AlternativeHoldingsListMobile } from "./components/alternative-holdings-list-mobile";
import { HoldingsEditMode } from "./components/holdings-edit-mode";
import {
  DEFAULT_HOLDINGS_VISIBILITY,
  HOLDINGS_VISIBILITY_STORAGE_KEY,
  filterHoldingsByVisibility,
  getEffectiveHoldingsVisibility,
  isClosedPosition,
  type HoldingsVisibilityFilter,
} from "./components/holdings-visibility";
import {
  filterHoldingsByType,
  getHoldingTypeFilterOption,
  getHoldingTypeFilterValue,
  getHoldingTypeTranslationKey,
} from "./components/holdings-type-filter";
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
  const { t } = useTranslation();
  const isMobileViewport = useIsMobileViewport();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get("tab") ?? "investments";
  // Health-center deep-links (e.g. /holdings?filter=negative|unclassified).
  const healthFilter = searchParams.get("filter");
  const healthContext = searchParams.get("healthContext");
  const queryClient = useQueryClient();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const [visibilityFilters, setVisibilityFilters] = usePersistentState<HoldingsVisibilityFilter[]>(
    HOLDINGS_VISIBILITY_STORAGE_KEY,
    [...DEFAULT_HOLDINGS_VISIBILITY],
  );

  const [accountFilter, setAccountScope] = useState<AccountScope>({ type: "all" });

  // Keep selectedAccount for edit/add functionality when a specific account is selected.
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const showClosedPositions = selectedAccount?.trackingMode !== "HOLDINGS";
  const effectiveVisibilityFilters = useMemo(
    () => getEffectiveHoldingsVisibility(visibilityFilters, showClosedPositions),
    [showClosedPositions, visibilityFilters],
  );
  const handleVisibilityFiltersChange = useCallback(
    (nextFilters: HoldingsVisibilityFilter[]) => {
      setVisibilityFilters(getEffectiveHoldingsVisibility(nextFilters, showClosedPositions));
    },
    [setVisibilityFilters, showClosedPositions],
  );

  const includeClosed = effectiveVisibilityFilters.includes("closed");
  const { holdings, isLoading, hasHiddenClosedPositions } = useHoldingsWithClosedProbe(
    accountFilter,
    {
      includeClosed,
      probeClosedWhenEmpty: showClosedPositions,
    },
  );
  const { accounts, isLoading: isAccountsLoading } = useAccounts({
    accountPurpose: AccountPurpose.HOLDINGS,
  });
  const { data: portfolios = [] } = usePortfolios();
  const { data: alternativeHoldings, isLoading: isAlternativeHoldingsLoading } =
    useAlternativeHoldings();

  // Mobile filter state
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [isAlternativeAssetModalOpen, setIsAlternativeAssetModalOpen] = useState(false);
  const [sortBy, setSortBy] = usePersistentState<"symbol" | "marketValue">(
    "holdings-sort-by",
    "marketValue",
  );
  const [performanceMode, setPerformanceMode] = usePersistentState<"daily" | "pnl" | "return">(
    "holdings-performance-mode",
    "pnl",
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

  const clearHealthContext = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("filter");
        next.delete("healthContext");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // Check if the selected account supports manual holdings editing
  const canEditHoldings = useMemo(() => {
    if (!selectedAccount) {
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
  const { filteredHoldings, availableTypeOptions } = useMemo(() => {
    const allHoldings = holdings ?? [];

    let scopedHoldings = allHoldings;
    if (investmentsFilter?.assetKinds) {
      const allowedKinds = investmentsFilter.assetKinds as readonly string[];
      scopedHoldings = allHoldings.filter((holding) => {
        return (
          holding.holdingType?.toLowerCase() === HoldingType.CASH ||
          (holding.assetKind && allowedKinds.includes(holding.assetKind))
        );
      });
    }

    // Build available type options from taxonomy classifications
    const typeSet = new Set<string>();
    const typeOptions: { value: string; label: string }[] = [];
    for (const h of scopedHoldings) {
      const option = getHoldingTypeFilterOption(h, t("holdings:cash"));
      if (option && !typeSet.has(option.value)) {
        typeSet.add(option.value);
        typeOptions.push({
          value: option.value,
          label: t(getHoldingTypeTranslationKey(option.value), {
            defaultValue: option.fallbackLabel,
          }),
        });
      }
    }

    let filtered = filterHoldingsByVisibility(scopedHoldings, effectiveVisibilityFilters);
    filtered = filterHoldingsByType(filtered, selectedTypes);

    // Health-center deep-link filters.
    if (healthFilter === "negative") {
      filtered = filtered.filter((holding) => holding.quantity < 0);
    } else if (healthFilter === "unclassified") {
      filtered = filtered.filter((holding) => !getHoldingTypeFilterValue(holding));
    }

    return {
      filteredHoldings: filtered,
      availableTypeOptions: typeOptions,
    };
  }, [holdings, effectiveVisibilityFilters, selectedTypes, investmentsFilter, healthFilter, t]);

  // Combined loading state
  const isDataLoading = isLoading || isAccountsLoading || isAlternativeHoldingsLoading;
  const hasHiddenInvestmentPositions =
    hasHiddenClosedPositions || (holdings.length > 0 && filteredHoldings.length === 0);

  // Empty state checks
  const hasNoInvestments = !isDataLoading && holdings.length === 0 && !hasHiddenClosedPositions;
  const hasNoAssets = !isDataLoading && assetsHoldings.length === 0;
  const hasNoLiabilities = !isDataLoading && liabilitiesHoldings.length === 0;
  const hasMobileInvestmentsToolbar =
    isMobileViewport && currentTab === "investments" && !hasNoInvestments;

  // Action palette groups
  const actionPaletteGroups: ActionPaletteGroup[] = useMemo(
    () => [
      {
        items: [
          {
            icon: Icons.Wallet,
            label: t("holdings:add_asset"),
            onClick: () => {
              setModalDefaultKind(undefined);
              setIsAlternativeAssetModalOpen(true);
            },
          },
          {
            icon: Icons.CreditCard,
            label: t("holdings:add_liability"),
            onClick: () => {
              setModalDefaultKind(AlternativeAssetKind.LIABILITY);
              setIsAlternativeAssetModalOpen(true);
            },
          },
          {
            icon: Icons.Plus,
            label: t("holdings:add_activity"),
            onClick: () => navigate("/activities/manage"),
          },
          {
            icon: Icons.Refresh,
            label: t("holdings:update_prices"),
            onClick: () => updatePortfolioMutation.mutate(),
          },
        ],
      },
    ],
    [navigate, updatePortfolioMutation, t],
  );

  // Investments content
  const investmentsContent = (
    <>
      {(healthFilter || healthContext === "holding") && (
        <div className="border-border bg-muted/30 mb-4 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icons.Info className="text-muted-foreground h-4 w-4 shrink-0" />
            <p className="text-sm">{t("holdings:health_filter_active")}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={clearHealthContext}>
            {t("common:clear")}
          </Button>
        </div>
      )}

      {/* Edit Mode for HOLDINGS-mode accounts */}
      {isEditMode && selectedAccount && canEditHoldings ? (
        <HoldingsEditMode
          holdings={(holdings ?? []).filter((holding) => !isClosedPosition(holding))}
          account={selectedAccount}
          isLoading={isDataLoading}
          onClose={() => setIsEditMode(false)}
        />
      ) : hasNoInvestments ? (
        <div className="flex items-center justify-center py-16">
          <EmptyPlaceholder
            icon={<Icons.TrendingUp className="text-muted-foreground h-10 w-10" />}
            title={t("holdings:empty_no_holdings_yet")}
            description={
              canEditHoldings
                ? t("holdings:empty_get_started_manual")
                : t("holdings:empty_get_started_transaction")
            }
          >
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              {canEditHoldings ? (
                <>
                  <Button size="default" onClick={() => setIsEditMode(true)}>
                    <Icons.Pencil className="mr-2 h-4 w-4" />
                    {t("holdings:update_holdings")}
                  </Button>
                  <Button size="default" variant="outline" onClick={() => navigate("/import")}>
                    <Icons.Import className="mr-2 h-4 w-4" />
                    {t("holdings:import_from_csv")}
                  </Button>
                </>
              ) : (
                <>
                  <Button size="default" onClick={() => navigate("/activities/manage")}>
                    <Icons.Plus className="mr-2 h-4 w-4" />
                    {t("holdings:add_transaction")}
                  </Button>
                  <Button size="default" variant="outline" onClick={() => navigate("/import")}>
                    <Icons.Import className="mr-2 h-4 w-4" />
                    {t("holdings:import_from_csv")}
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
              visibilityFilters={effectiveVisibilityFilters}
              setVisibilityFilters={handleVisibilityFiltersChange}
              showClosedPositions={showClosedPositions}
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
              holdings={filteredHoldings ?? []}
              isLoading={isDataLoading}
              selectedTypes={selectedTypes}
              setSelectedTypes={setSelectedTypes}
              accountFilter={accountFilter}
              onAccountScopeChange={handleAccountScopeChange}
              accounts={accounts ?? []}
              portfolios={portfolios}
              showSearch={true}
              showFilterButton={true}
              sortBy={sortBy}
              setSortBy={setSortBy}
              performanceMode={performanceMode}
              setPerformanceMode={setPerformanceMode}
              typeOptions={availableTypeOptions}
              visibilityFilters={effectiveVisibilityFilters}
              setVisibilityFilters={handleVisibilityFiltersChange}
              showClosedPositions={showClosedPositions}
              hasHiddenPositions={hasHiddenInvestmentPositions}
              toolbarActions={
                isMobileViewport && currentTab === "investments" ? (
                  <ActionPalette
                    open={isActionPaletteOpen}
                    onOpenChange={setIsActionPaletteOpen}
                    groups={actionPaletteGroups}
                    trigger={
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-10 shrink-0 rounded-full"
                        aria-label={t("holdings:open_actions")}
                      >
                        <Icons.DotsThreeVertical className="h-5 w-5" weight="fill" />
                      </Button>
                    }
                  />
                ) : undefined
              }
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
            title={t("holdings:empty_no_assets_yet")}
            description={t("holdings:empty_add_first_asset")}
          >
            <Button size="default" onClick={() => setIsAlternativeAssetModalOpen(true)}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("holdings:add_asset")}
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
              emptyTitle={t("holdings:empty_no_assets")}
              emptyDescription={t("holdings:empty_add_first_asset_button")}
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
            title={t("holdings:empty_no_liabilities_yet")}
            description={t("holdings:empty_track_debts")}
          >
            <Button size="default" onClick={() => setIsAlternativeAssetModalOpen(true)}>
              <Icons.Plus className="mr-2 h-4 w-4" />
              {t("holdings:add_liability")}
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
              emptyTitle={t("holdings:empty_no_liabilities")}
              emptyDescription={t("holdings:empty_add_first_liability_button")}
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

  // Shared actions for header
  const sharedActions = useMemo(
    () => (
      <>
        {!hasMobileInvestmentsToolbar && (
          <AccountScopeSelector value={accountFilter} onChange={handleAccountScopeChange} />
        )}
        {/* Show Update button for HOLDINGS-mode manual accounts (only on investments tab) */}
        {canEditHoldings && !isEditMode && currentTab === "investments" && (
          <Button size="sm" variant="outline" onClick={() => setIsEditMode(true)}>
            <Icons.Pencil className="mr-2 h-4 w-4" />
            {t("holdings:update")}
          </Button>
        )}
        {!hasMobileInvestmentsToolbar && (
          <ActionPalette
            open={isActionPaletteOpen}
            onOpenChange={setIsActionPaletteOpen}
            groups={actionPaletteGroups}
          />
        )}
      </>
    ),
    [
      hasMobileInvestmentsToolbar,
      accountFilter,
      handleAccountScopeChange,
      canEditHoldings,
      isEditMode,
      currentTab,
      isActionPaletteOpen,
      actionPaletteGroups,
      t,
    ],
  );

  // Define the swipeable views
  const views: SwipablePageView[] = useMemo(
    () => [
      {
        value: "investments",
        label: t("holdings:investments"),
        icon: Icons.TrendingUp,
        content: investmentsContent,
        actions: sharedActions,
      },
      {
        value: "assets",
        label: t("holdings:assets"),
        icon: Icons.Wallet,
        content: assetsContent,
        actions: sharedActions,
      },
      {
        value: "liabilities",
        label: t("holdings:liabilities"),
        icon: Icons.CreditCard,
        content: liabilitiesContent,
        actions: sharedActions,
      },
    ],
    [investmentsContent, assetsContent, liabilitiesContent, sharedActions, t],
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
