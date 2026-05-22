import { createActivity, getAssetHoldings, getAssetLots, getHolding } from "@/adapters";
import { ActionPalette, type ActionPaletteGroup } from "@/components/action-palette";
import { TickerAvatar } from "@/components/ticker-avatar";
import { useHapticFeedback } from "@/hooks";
import { useAlternativeAssetHolding, useAlternativeHoldings } from "@/hooks/use-alternative-assets";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useQuoteHistory } from "@/hooks/use-quote-history";
import { useSyncMarketDataMutation } from "@/hooks/use-sync-market-data";
import { useAssetTaxonomyAssignments, useTaxonomy } from "@/hooks/use-taxonomies";
import { PORTFOLIO_ACCOUNT_ID } from "@/lib/constants";
import { generateId } from "@/lib/id";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type { AssetKind, AssetLotView, Holding, Quote } from "@/lib/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatedToggleGroup, Page, PageContent, PageHeader, SwipableView } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
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
import { Tabs, TabsContent } from "@wealthfolio/ui/components/ui/tabs";
import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { AlternativeAssetContent, useAlternativeAssetActions } from "./alternative-asset-content";
import { ValueHistoryDataGrid } from "./alternative-assets";
import AssetDetailCard from "./asset-detail-card";
import { AssetEditSheet } from "./asset-edit-sheet";
import AssetHistoryCard from "./asset-history-card";
import {
  AssetAccountHoldings,
  AssetSnapshotHistory,
  useHasManualSnapshots,
} from "./asset-account-holdings";
import AssetLotsTable from "./asset-lots-table";
import { useAssetProfile } from "./hooks/use-asset-profile";
import { useAssetProfileMutations } from "./hooks/use-asset-profile-mutations";
import { RefreshQuotesConfirmDialog } from "./refresh-quotes-confirm-dialog";
import { useQuoteMutations } from "./hooks/use-quote-mutations";
import { QuoteHistoryDataGrid } from "./quote-history-data-grid";

// Alternative asset kinds that should use ValueHistoryDataGrid
const ALTERNATIVE_ASSET_KINDS: AssetKind[] = [
  "PROPERTY",
  "VEHICLE",
  "COLLECTIBLE",
  "PRECIOUS_METAL",
  "LIABILITY",
  "OTHER",
];

const isAlternativeAsset = (kind: AssetKind | undefined | null): boolean => {
  if (!kind) return false;
  return ALTERNATIVE_ASSET_KINDS.includes(kind);
};

// Helper to parse JSON field that might be a string or already an object
const parseJsonField = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
};

interface AssetDetailData {
  numShares: number;
  marketValue: number;
  costBasis: number;
  averagePrice: number;
  portfolioPercent: number;
  todaysReturn: number | null;
  todaysReturnPercent: number | null;
  totalReturn: number;
  totalReturnPercent: number;
  currency: string;
  quoteCurrency: string | null;
  quote: {
    open: number;
    high: number;
    low: number;
    volume: number;
    close: number;
    adjclose: number;
  } | null;
  bondSpec?: {
    maturityDate?: string | null;
    couponRate?: number | null;
    couponFrequency?: string | null;
  } | null;
  optionSpec?: {
    right?: string | null;
    strike?: number | null;
    expiration?: string | null;
  } | null;
}

type AssetTab = "overview" | "lots" | "history";

export const AssetProfilePage = () => {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { assetId: encodedAssetId = "" } = useParams<{ assetId: string }>();
  const assetId = decodeURIComponent(encodedAssetId);
  const location = useLocation();
  const navigate = useNavigate();
  const queryParams = new URLSearchParams(location.search);
  const tabParam = queryParams.get("tab");
  const defaultTab: AssetTab =
    tabParam === "overview" || tabParam === "lots" || tabParam === "history"
      ? tabParam
      : "overview";
  const [activeTab, setActiveTab] = useState<AssetTab>(defaultTab);
  type OverviewSubTab = "about" | "holdings" | "snapshots";
  const [overviewSubTab, setOverviewSubTab] = useState<OverviewSubTab>("about");
  const hasManualSnapshots = useHasManualSnapshots(assetId);
  const overviewSubTabs = useMemo(() => {
    const items: { value: OverviewSubTab; label: string }[] = [
      { value: "about", label: "About" },
      { value: "holdings", label: "Holdings" },
    ];
    if (hasManualSnapshots) {
      items.push({ value: "snapshots", label: "Snapshots" });
    }
    return items;
  }, [hasManualSnapshots]);
  const [actionPaletteOpen, setActionPaletteOpen] = useState(false);
  const [editSheetOpen, setEditSheetOpen] = useState(false);
  const [editSheetDefaultTab, setEditSheetDefaultTab] = useState<
    "general" | "classification" | "market-data"
  >("general");
  const { triggerHaptic } = useHapticFeedback();
  const isMobile = useIsMobileViewport();

  const fxTabs = useMemo(() => {
    const items: { value: "overview" | "quotes"; label: string }[] = [
      { value: "overview", label: "Overview" },
      { value: "quotes", label: "Quotes" },
    ];
    return items;
  }, []);

  const [fxActiveTab, setFxActiveTab] = useState<"overview" | "quotes">(
    queryParams.get("tab") === "quotes" ? "quotes" : "overview",
  );

  const {
    data: assetProfile,
    isLoading: isAssetProfileLoading,
    isError: isAssetProfileError,
  } = useAssetProfile(assetId);

  const {
    data: holding,
    isLoading: isHoldingLoading,
    isError: isHoldingError,
  } = useQuery<Holding | null, Error>({
    queryKey: [QueryKeys.HOLDING, PORTFOLIO_ACCOUNT_ID, assetId],
    queryFn: () => getHolding(PORTFOLIO_ACCOUNT_ID, assetId),
    enabled: !!assetId,
  });

  const {
    data: quoteHistory,
    isLoading: isQuotesLoading,
    isError: isQuotesError,
  } = useQuoteHistory({
    assetId,
    enabled: !!assetId,
  });

  // Taxonomy data for category badges - use same approach as edit sheet
  const { data: assignments = [], isLoading: isAssignmentsLoading } =
    useAssetTaxonomyAssignments(assetId);
  const { updateQuoteModeMutation } = useAssetProfileMutations();

  // Fetch taxonomy details for taxonomies with assignments
  // We need the categories to get name and color
  const { data: typeOfSecurityTaxonomy } = useTaxonomy(
    assignments.find((a) => a.taxonomyId === "instrument_type")?.taxonomyId ?? null,
  );
  const { data: riskCategoryTaxonomy } = useTaxonomy(
    assignments.find((a) => a.taxonomyId === "risk_category")?.taxonomyId ?? null,
  );
  const { data: assetClassesTaxonomy } = useTaxonomy(
    assignments.find((a) => a.taxonomyId === "asset_classes")?.taxonomyId ?? null,
  );
  const { data: industriesTaxonomy } = useTaxonomy(
    assignments.find((a) => a.taxonomyId === "industries_gics")?.taxonomyId ?? null,
  );
  const { data: regionsTaxonomy } = useTaxonomy(
    assignments.find((a) => a.taxonomyId === "regions")?.taxonomyId ?? null,
  );

  const isClassificationsLoading = isAssignmentsLoading;

  // Build category badges from assignments and taxonomy data
  // Order: Class, Type, Risk
  const categoryBadges = useMemo(() => {
    const badges: {
      id: string;
      categoryName: string;
      categoryColor: string;
      taxonomyName: string;
    }[] = [];

    // Asset Class badge (first)
    const assetClassAssignment = assignments.find((a) => a.taxonomyId === "asset_classes");
    if (assetClassAssignment && assetClassesTaxonomy?.categories) {
      const category = assetClassesTaxonomy.categories.find(
        (c) => c.id === assetClassAssignment.categoryId,
      );
      if (category) {
        badges.push({
          id: category.id,
          categoryName: category.name,
          categoryColor: category.color,
          taxonomyName: "Class",
        });
      }
    }

    // Type of Security badge (second)
    const typeAssignment = assignments.find((a) => a.taxonomyId === "instrument_type");
    if (typeAssignment && typeOfSecurityTaxonomy?.categories) {
      const category = typeOfSecurityTaxonomy.categories.find(
        (c) => c.id === typeAssignment.categoryId,
      );
      if (category) {
        badges.push({
          id: category.id,
          categoryName: category.name === "Exchange Traded Fund (ETF)" ? "ETF" : category.name,
          categoryColor: category.color,
          taxonomyName: "Type",
        });
      }
    }

    // Risk Category badge (third)
    const riskAssignment = assignments.find((a) => a.taxonomyId === "risk_category");
    if (riskAssignment && riskCategoryTaxonomy?.categories) {
      const category = riskCategoryTaxonomy.categories.find(
        (c) => c.id === riskAssignment.categoryId,
      );
      if (category) {
        badges.push({
          id: category.id,
          categoryName: `Risk: ${category.name}`,
          categoryColor: category.color,
          taxonomyName: "Risk",
        });
      }
    }

    // Industries (GICS) - top 2 by weight
    const industryAssignments = assignments
      .filter((a) => a.taxonomyId === "industries_gics")
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, 2);
    if (industriesTaxonomy?.categories) {
      for (const assignment of industryAssignments) {
        const category = industriesTaxonomy.categories.find((c) => c.id === assignment.categoryId);
        if (category) {
          badges.push({
            id: `industry-${category.id}`,
            categoryName: category.name,
            categoryColor: category.color,
            taxonomyName: "Industry",
          });
        }
      }
    }

    // Regions - top 2 by weight
    const regionAssignments = assignments
      .filter((a) => a.taxonomyId === "regions")
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, 2);
    if (regionsTaxonomy?.categories) {
      for (const assignment of regionAssignments) {
        const category = regionsTaxonomy.categories.find((c) => c.id === assignment.categoryId);
        if (category) {
          badges.push({
            id: `region-${category.id}`,
            categoryName: category.name,
            categoryColor: category.color,
            taxonomyName: "Region",
          });
        }
      }
    }

    return badges;
  }, [
    assignments,
    assetClassesTaxonomy,
    typeOfSecurityTaxonomy,
    riskCategoryTaxonomy,
    industriesTaxonomy,
    regionsTaxonomy,
  ]);

  const quote = useMemo(() => {
    // Backend returns quotes in descending order (newest first)
    // So .at(0) gives the latest quote
    return quoteHistory?.at(0) ?? null;
  }, [quoteHistory]);

  // Bond metadata for display (only when asset is a bond)
  const bondSpec = useMemo(() => {
    if (assetProfile?.instrumentType !== "BOND" || !assetProfile?.metadata) return null;
    const bond = assetProfile.metadata.bond as
      | {
          maturityDate?: string | null;
          couponRate?: number | null;
          couponFrequency?: string | null;
        }
      | undefined;
    if (!bond || (!bond.maturityDate && bond.couponRate == null)) return null;
    return bond;
  }, [assetProfile]);

  // Option metadata for display (only when asset is an option)
  const optionSpec = useMemo(() => {
    if (assetProfile?.instrumentType !== "OPTION" || !assetProfile?.metadata) return null;
    const option = assetProfile.metadata.option as
      | { right?: string | null; strike?: number | null; expiration?: string | null }
      | undefined;
    if (!option || (!option.right && option.strike == null && !option.expiration)) return null;
    return option;
  }, [assetProfile]);

  const isExpiredOption = useMemo(() => {
    if (!optionSpec?.expiration) return false;
    // Compare date-only: expired once the calendar day after expiration has started
    const today = new Date().toISOString().split("T")[0];
    return optionSpec.expiration < today;
  }, [optionSpec]);

  const [confirmExpiryOpen, setConfirmExpiryOpen] = useState(false);
  const queryClient = useQueryClient();

  const confirmExpiryMutation = useMutation({
    mutationFn: async () => {
      const accountHoldings = await getAssetHoldings(assetId);
      const nonZeroHoldings = accountHoldings.filter((h) => h.quantity > 0);
      if (nonZeroHoldings.length === 0) throw new Error("No open positions found");

      for (const h of nonZeroHoldings) {
        await createActivity({
          idempotencyKey: generateId("option-expiry"),
          accountId: h.accountId,
          activityType: "ADJUSTMENT",
          subtype: "OPTION_EXPIRY",
          activityDate: optionSpec?.expiration ?? new Date().toISOString().split("T")[0],
          asset: { id: assetId },
          quantity: String(h.quantity),
          unitPrice: "0",
          fee: "0",
          currency: h.localCurrency,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      toast.success("Option expiry recorded");
    },
    onError: (error) => {
      toast.error("Failed to record option expiry", { description: String(error) });
    },
  });

  const { saveQuoteMutation, deleteQuoteMutation } = useQuoteMutations(assetId);
  const syncMarketDataMutation = useSyncMarketDataMutation(true);
  const updateMarketDataMutation = useSyncMarketDataMutation(false);

  // Determine if manual tracking based on asset's quoteMode
  const isManualPricingMode = assetProfile?.quoteMode === "MANUAL";

  // Determine if this is an alternative asset (property, vehicle, liability, etc.)
  const isAltAsset = isAlternativeAsset(assetProfile?.kind);
  const isLiability = assetProfile?.kind === "LIABILITY";

  const { data: assetLots = [] } = useQuery<AssetLotView[], Error>({
    queryKey: [QueryKeys.ASSET_LOTS, assetId, true],
    queryFn: () => getAssetLots(assetId, true),
    enabled: !!assetId && !isAssetProfileLoading && !isAltAsset,
  });

  // Fetch alternative asset holding data (for alternative assets only)
  const { data: altHolding } = useAlternativeAssetHolding({
    assetId,
    enabled: isAltAsset,
  });

  // Fetch all alternative holdings for linking context
  const { data: allAltHoldings = [] } = useAlternativeHoldings({
    enabled: isAltAsset,
  });

  const profile = useMemo(() => {
    const instrument = holding?.instrument;
    const asset = assetProfile;

    if (!instrument && !asset) return null;

    const totalGainAmount = holding?.totalGain?.local ?? 0;
    const totalGainPercent = holding?.totalGainPct ?? 0;
    const calculatedAt = holding?.asOfDate;

    // Legacy data is in asset.metadata.legacy (for migration purposes)
    // New data should come from taxonomies
    const legacy = asset?.metadata?.legacy as
      | { sectors?: string | null; countries?: string | null }
      | undefined;

    const identifiers = asset?.metadata?.identifiers as { isin?: string } | undefined;

    return {
      id: instrument?.id ?? asset?.id ?? "",
      symbol: instrument?.symbol ?? asset?.displayCode ?? assetId,
      name: instrument?.name ?? asset?.name ?? "-",
      isin: identifiers?.isin ?? null,
      assetType: null,
      symbolMapping: null,
      notes: instrument?.notes ?? asset?.notes ?? null,
      // Sectors and countries now come from taxonomy classifications (displayed via badges)
      countries: JSON.stringify(parseJsonField(legacy?.countries) ?? []),
      categories: null,
      classes: null,
      attributes: null,
      createdAt: holding?.openDate ? new Date(holding.openDate) : new Date(),
      updatedAt: new Date(),
      currency: instrument?.currency ?? asset?.quoteCcy ?? baseCurrency,
      sectors: JSON.stringify(parseJsonField(legacy?.sectors) ?? []),
      url: null,
      marketPrice: holding?.price ?? quote?.close ?? 0,
      totalGainAmount,
      totalGainPercent,
      calculatedAt,
    };
  }, [holding, assetProfile, quote, assetId]);

  const symbolHolding = useMemo((): AssetDetailData | null => {
    if (!holding) return null;

    const averageCostPrice =
      holding.costBasis?.local && holding.quantity !== 0
        ? holding.costBasis.local / holding.quantity
        : 0;

    const quoteData = quote
      ? {
          quote: {
            open: quote.open,
            high: quote.high,
            low: quote.low,
            volume: quote.volume,
            close: quote.close,
            adjclose: quote.adjclose,
          },
          quoteCurrency: quote.currency ?? null,
        }
      : null;

    const todaysReturn = holding.dayChange?.local;
    const todaysReturnPercent = holding.dayChangePct;

    return {
      numShares: Number(holding.quantity),
      marketValue: Number(holding.marketValue.local ?? 0),
      costBasis: Number(holding.costBasis?.local ?? 0),
      averagePrice: Number(averageCostPrice),
      portfolioPercent: Number(holding.weight ?? 0),
      todaysReturn: todaysReturn != null ? Number(todaysReturn) : null,
      todaysReturnPercent: todaysReturnPercent != null ? Number(todaysReturnPercent) : null,
      totalReturn: Number(holding.totalGain?.local ?? 0),
      totalReturnPercent: Number(holding.totalGainPct ?? 0),
      currency: holding.localCurrency ?? holding.instrument?.currency ?? baseCurrency,
      quoteCurrency: quoteData?.quoteCurrency ?? null,
      quote: quoteData?.quote ?? null,
      bondSpec: bondSpec ?? null,
      optionSpec: optionSpec ?? null,
    };
  }, [holding, quote, bondSpec, optionSpec]);

  // Build toggle items dynamically based on available data
  const toggleItems = useMemo(() => {
    const items: { value: AssetTab; label: string }[] = [];

    // For alternative assets: Overview | History (no Lots tab)
    if (isAltAsset) {
      items.push({ value: "overview", label: "Overview" });
      items.push({ value: "history", label: "Values" });
      return items;
    }

    // For regular assets
    if (profile) {
      items.push({ value: "overview", label: "Overview" });
    }

    if (assetLots.length > 0) {
      items.push({ value: "lots", label: "Lots" });
    }

    items.push({ value: "history", label: "Quotes" });

    return items;
  }, [profile, assetLots, isAltAsset]);

  // Build swipable tabs for mobile
  const swipableTabs = useMemo(() => {
    const tabs: { name: string; content: React.ReactNode }[] = [];

    if (profile) {
      tabs.push({
        name: "Overview",
        content: (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 pt-0 md:grid-cols-3">
              <AssetHistoryCard
                assetId={profile.id ?? ""}
                currency={quote?.currency ?? profile.currency ?? baseCurrency}
                marketPrice={quote?.close ?? profile.marketPrice}
                totalGainAmount={profile.totalGainAmount}
                totalGainPercent={profile.totalGainPercent}
                quoteHistory={quoteHistory ?? []}
                className={`col-span-1 ${holding ? "md:col-span-2" : "md:col-span-3"}`}
              />
              {symbolHolding && (
                <AssetDetailCard assetData={symbolHolding} className="col-span-1 md:col-span-1" />
              )}
            </div>

            <AnimatedToggleGroup
              items={overviewSubTabs}
              value={overviewSubTab}
              onValueChange={(v: OverviewSubTab) => setOverviewSubTab(v)}
              className="text-sm"
            />

            {overviewSubTab === "about" && (
              <div className="space-y-4">
                {/* Category badges */}
                <div className="flex flex-wrap items-center gap-2">
                  {isClassificationsLoading ? (
                    <>
                      <Skeleton className="h-6 w-16 rounded-full" />
                      <Skeleton className="h-6 w-20 rounded-full" />
                    </>
                  ) : categoryBadges.length > 0 ? (
                    <>
                      {categoryBadges.map((badge) => (
                        <Badge
                          key={badge.id}
                          variant="secondary"
                          className="gap-1.5"
                          style={{
                            backgroundColor: `${badge.categoryColor}20`,
                            color: badge.categoryColor,
                            borderColor: badge.categoryColor,
                          }}
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: badge.categoryColor }}
                          />
                          {badge.categoryName}
                        </Badge>
                      ))}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={() => {
                          setEditSheetDefaultTab("classification");
                          setEditSheetOpen(true);
                        }}
                      >
                        More
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-6 text-xs"
                      onClick={() => {
                        setEditSheetDefaultTab("classification");
                        setEditSheetOpen(true);
                      }}
                    >
                      + Add classifications
                    </Button>
                  )}
                </div>

                {/* Notes section */}
                <p className="text-muted-foreground text-sm">
                  {assetProfile?.notes || holding?.instrument?.notes || "No notes added."}
                </p>
              </div>
            )}

            {overviewSubTab === "holdings" && (
              <AssetAccountHoldings assetId={assetId} baseCurrency={baseCurrency} />
            )}

            {overviewSubTab === "snapshots" && (
              <AssetSnapshotHistory assetId={assetId} baseCurrency={baseCurrency} />
            )}
          </div>
        ),
      });
    }

    if (assetLots.length > 0 && profile) {
      tabs.push({
        name: "Lots",
        content: (
          <AssetLotsTable
            lots={assetLots}
            currency={symbolHolding?.currency ?? profile.currency ?? baseCurrency}
            marketPrice={Number(holding?.price ?? profile.marketPrice)}
            contractMultiplier={Number(holding?.contractMultiplier ?? 1)}
          />
        ),
      });
    }

    // Use ValueHistoryDataGrid for alternative assets, QuoteHistoryTable for regular assets
    tabs.push({
      name: isAltAsset ? "Values" : "Quotes",
      content: isAltAsset ? (
        <ValueHistoryDataGrid
          data={quoteHistory ?? []}
          currency={profile?.currency ?? baseCurrency}
          isLiability={isLiability}
          onSaveQuote={(quote: Quote) => {
            saveQuoteMutation.mutate(quote);
          }}
          onDeleteQuote={(id: string) => deleteQuoteMutation.mutate(id)}
        />
      ) : (
        <QuoteHistoryDataGrid
          data={quoteHistory ?? []}
          assetId={assetId}
          currency={quote?.currency ?? profile?.currency ?? baseCurrency}
          assetKind={assetProfile?.kind}
          isManualDataSource={isManualPricingMode}
          onSaveQuote={(quote: Quote) => saveQuoteMutation.mutate(quote)}
          onDeleteQuote={(id: string) => deleteQuoteMutation.mutate(id)}
          onChangeDataSource={(isManual) => {
            if (profile) {
              updateQuoteModeMutation.mutate({
                assetId: assetId,
                quoteMode: isManual ? "MANUAL" : "MARKET",
              });
            }
          }}
        />
      ),
    });

    return tabs;
  }, [
    profile,
    holding,
    assetLots,
    symbolHolding,
    quoteHistory,
    saveQuoteMutation,
    deleteQuoteMutation,
    assetId,
    isAltAsset,
    isLiability,
    isManualPricingMode,
    categoryBadges,
    isClassificationsLoading,
    assetProfile,
    overviewSubTab,
    overviewSubTabs,
  ]);

  const isLoading = isHoldingLoading || isQuotesLoading || isAssetProfileLoading;
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);

  const handleUpdateQuotes = useCallback(() => {
    if (!profile?.id) return;
    triggerHaptic();
    updateMarketDataMutation.mutate([profile.id]);
  }, [profile?.id, updateMarketDataMutation, triggerHaptic]);

  const handleRefreshQuotes = useCallback(() => {
    if (!profile?.id) return;
    triggerHaptic();
    syncMarketDataMutation.mutate([profile.id]);
  }, [profile?.id, syncMarketDataMutation, triggerHaptic]);

  const handleRefreshQuotesWithConfirm = useCallback(() => {
    setRefreshConfirmOpen(true);
  }, []);

  const handleBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  // Alternative asset actions hook (only used when isAltAsset && altHolding)
  const altAssetActions = useAlternativeAssetActions({
    holding: altHolding,
    assetProfile: assetProfile,
    allHoldings: allAltHoldings,
    onNavigateBack: handleBack,
  });

  if (isLoading)
    return (
      <Page>
        <PageContent>
          <Icons.Spinner className="h-6 w-6 animate-spin" />
        </PageContent>
      </Page>
    ); // Show loading spinner

  // FX assets use tabs: Overview (with chart) | Quotes

  // Simplified view for quote-only assets (like FX rates)
  if (assetProfile?.kind === "FX") {
    return (
      <Page>
        <PageHeader
          heading={assetProfile.displayCode ?? assetId}
          text={assetProfile.name ?? ""}
          onBack={handleBack}
          actions={
            <div className="flex items-center gap-2">
              <AnimatedToggleGroup
                items={fxTabs}
                value={fxActiveTab}
                onValueChange={(next: "overview" | "quotes") => {
                  if (next === fxActiveTab) return;
                  triggerHaptic();
                  setFxActiveTab(next);
                  const url = `${location.pathname}?tab=${next}`;
                  navigate(url, { replace: true });
                }}
                className="mr-2"
              />
              <ActionPalette
                open={actionPaletteOpen}
                onOpenChange={setActionPaletteOpen}
                title={assetProfile.displayCode ?? assetId}
                groups={
                  [
                    {
                      title: "Manage",
                      items: [
                        {
                          icon: Icons.Download,
                          label: "Update Price",
                          onClick: handleUpdateQuotes,
                        },
                        {
                          icon: Icons.Refresh,
                          label: "Refresh History",
                          onClick: handleRefreshQuotesWithConfirm,
                        },
                        {
                          icon: Icons.Pencil,
                          label: "Edit",
                          onClick: () => setEditSheetOpen(true),
                        },
                      ],
                    },
                  ] satisfies ActionPaletteGroup[]
                }
                trigger={
                  <Button variant="outline" size="icon" className="h-9 w-9">
                    <Icons.DotsThreeVertical className="h-5 w-5" weight="fill" />
                  </Button>
                }
              />
            </div>
          }
        />
        <PageContent>
          {fxActiveTab === "overview" && (
            <div className="space-y-4">
              <AssetHistoryCard
                assetId={assetId}
                currency={quote?.currency ?? profile?.currency ?? baseCurrency}
                marketPrice={quote?.close ?? 0}
                totalGainAmount={0}
                totalGainPercent={0}
                quoteHistory={quoteHistory ?? []}
                className="w-full"
              />

              {/* Type badge */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-blue-500" />
                  FX Rate
                </Badge>
              </div>

              {/* Notes section */}
              <p className="text-muted-foreground text-sm">
                {assetProfile?.notes || "No notes added."}
              </p>
            </div>
          )}
          {fxActiveTab === "quotes" && (
            <QuoteHistoryDataGrid
              data={quoteHistory ?? []}
              assetId={assetId}
              currency={profile?.currency ?? baseCurrency}
              assetKind={assetProfile?.kind}
              isManualDataSource={isManualPricingMode}
              onSaveQuote={(quote: Quote) => saveQuoteMutation.mutate(quote)}
              onDeleteQuote={(id: string) => deleteQuoteMutation.mutate(id)}
              onChangeDataSource={(isManual) => {
                updateQuoteModeMutation.mutate({
                  assetId: assetId,
                  quoteMode: isManual ? "MANUAL" : "MARKET",
                });
              }}
            />
          )}
        </PageContent>

        <AssetEditSheet
          open={editSheetOpen}
          onOpenChange={setEditSheetOpen}
          asset={assetProfile ?? null}
          latestQuote={quote}
          defaultTab="general"
        />
      </Page>
    );
  }

  // Handle case where loading finished but we have no asset data at all
  if (!profile && (!quoteHistory || quoteHistory.length === 0)) {
    return (
      <Page>
        <PageHeader
          heading={assetId}
          text={`Error loading data for ${assetId}`}
          onBack={handleBack}
        />
        <PageContent>
          <p>
            Could not load necessary information for this asset. Please check the asset ID or try
            again later.
          </p>
          {isHoldingError && <p className="text-sm text-red-500">Holding fetch error.</p>}
          {isQuotesError && <p className="text-sm text-red-500">Quote fetch error.</p>}
          {isAssetProfileError && (
            <p className="text-sm text-red-500">Asset profile fetch error.</p>
          )}
        </PageContent>
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader
        onBack={handleBack}
        actions={
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex">
              <AnimatedToggleGroup
                items={toggleItems}
                value={activeTab}
                onValueChange={(next: AssetTab) => {
                  if (next === activeTab) {
                    return;
                  }
                  triggerHaptic();
                  setActiveTab(next);
                  const url = `${location.pathname}?tab=${next}`;
                  navigate(url, { replace: true });
                }}
                className="md:text-base"
              />
            </div>
            <ActionPalette
              open={actionPaletteOpen}
              onOpenChange={setActionPaletteOpen}
              title={
                isAltAsset && altHolding
                  ? altHolding.name
                  : (assetProfile?.displayCode ?? assetProfile?.name ?? assetId)
              }
              groups={
                isAltAsset && altHolding
                  ? ([
                      {
                        title: "Valuation",
                        items: [
                          {
                            icon: Icons.DollarSign,
                            label: "Update Value",
                            onClick: () => altAssetActions.openUpdateValuation(),
                          },
                        ],
                      },
                      {
                        title: "Manage",
                        items: [
                          {
                            icon: Icons.Pencil,
                            label: "Edit Details",
                            onClick: () => altAssetActions.openEditDetails(),
                          },
                          ...(altAssetActions.isLinkableAsset
                            ? [
                                {
                                  icon: Icons.Link,
                                  label: "Add Liability",
                                  onClick: () => altAssetActions.openAddLiability(),
                                },
                              ]
                            : []),
                          {
                            icon: Icons.Trash,
                            label: "Delete",
                            onClick: () => altAssetActions.openDeleteConfirm(),
                          },
                        ],
                      },
                    ] satisfies ActionPaletteGroup[])
                  : ([
                      {
                        title: "Record Transaction",
                        items: [
                          {
                            icon: Icons.TrendingUp,
                            label: "Buy",
                            onClick: () =>
                              navigate(
                                `/activities/manage?assetId=${encodeURIComponent(assetId)}&type=BUY`,
                              ),
                          },
                          {
                            icon: Icons.TrendingDown,
                            label: "Sell",
                            onClick: () =>
                              navigate(
                                `/activities/manage?assetId=${encodeURIComponent(assetId)}&type=SELL`,
                              ),
                          },
                          {
                            icon: Icons.Coins,
                            label: "Dividend",
                            onClick: () =>
                              navigate(
                                `/activities/manage?assetId=${encodeURIComponent(assetId)}&type=DIVIDEND`,
                              ),
                          },
                          {
                            icon: Icons.Ellipsis,
                            label: "Other",
                            onClick: () =>
                              navigate(`/activities/manage?assetId=${encodeURIComponent(assetId)}`),
                          },
                          ...(isExpiredOption
                            ? [
                                {
                                  icon: Icons.XCircle,
                                  label: "Confirm Expiry",
                                  onClick: () => setConfirmExpiryOpen(true),
                                },
                              ]
                            : []),
                        ],
                      },
                      {
                        title: "Manage",
                        items: [
                          {
                            icon: Icons.Download,
                            label: "Update Price",
                            onClick: handleUpdateQuotes,
                          },
                          {
                            icon: Icons.Refresh,
                            label: "Refresh History",
                            onClick: handleRefreshQuotesWithConfirm,
                          },
                          {
                            icon: Icons.Pencil,
                            label: "Edit",
                            onClick: () => setEditSheetOpen(true),
                          },
                        ],
                      },
                    ] satisfies ActionPaletteGroup[])
              }
              trigger={
                <Button variant="outline" size="icon" className="h-9 w-9">
                  <Icons.DotsThreeVertical className="h-5 w-5" weight="fill" />
                </Button>
              }
            />
          </div>
        }
      >
        <div className="flex items-center gap-2" data-tauri-drag-region="true">
          {isAltAsset && altHolding ? (
            <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-full">
              <AlternativeAssetIcon kind={altHolding.kind} size={20} />
            </div>
          ) : (
            (profile?.symbol ?? holding?.instrument?.symbol ?? assetProfile?.displayCode) && (
              <TickerAvatar
                symbol={
                  profile?.symbol ??
                  holding?.instrument?.symbol ??
                  assetProfile?.displayCode ??
                  assetId
                }
                className="size-9"
              />
            )
          )}
          <div className="flex min-w-0 flex-col justify-center">
            <h1 className="truncate text-base font-semibold leading-tight md:text-lg">
              {assetProfile?.name ?? holding?.instrument?.name ?? assetId ?? "-"}
            </h1>
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs leading-tight md:text-sm">
              {isAltAsset && altHolding ? (
                getAlternativeAssetKindLabel(altHolding.kind)
              ) : (
                <>
                  {assetProfile?.displayCode ?? holding?.instrument?.symbol ?? assetId}
                  {(assetProfile?.quoteCcy ?? profile?.currency) && (
                    <>
                      <span className="bg-muted-foreground/40 h-3 w-px rounded-full" />
                      {assetProfile?.quoteCcy ?? profile?.currency}
                    </>
                  )}
                </>
              )}
            </p>
          </div>
        </div>
      </PageHeader>
      <PageContent>
        {/* Alternative Asset Content */}
        {isAltAsset && altHolding && assetProfile ? (
          isMobile ? (
            <SwipableView
              items={[
                {
                  name: "Overview",
                  content: (
                    <AlternativeAssetContent
                      assetId={assetId}
                      assetProfile={assetProfile}
                      holding={altHolding}
                      quoteHistory={quoteHistory ?? []}
                      activeTab="overview"
                      isMobile={true}
                    />
                  ),
                },
                {
                  name: "Values",
                  content: (
                    <AlternativeAssetContent
                      assetId={assetId}
                      assetProfile={assetProfile}
                      holding={altHolding}
                      quoteHistory={quoteHistory ?? []}
                      activeTab="history"
                      isMobile={true}
                    />
                  ),
                },
              ]}
              displayToggle={true}
              onViewChange={(_index: number, name: string) => {
                const tabValue = name.toLowerCase() === "values" ? "history" : "overview";
                if (tabValue === activeTab) return;
                triggerHaptic();
                setActiveTab(tabValue as AssetTab);
                navigate(`${location.pathname}?tab=${tabValue}`, { replace: true });
              }}
            />
          ) : (
            <Tabs value={activeTab} className="space-y-4">
              <TabsContent value="overview" className="space-y-4">
                <AlternativeAssetContent
                  assetId={assetId}
                  assetProfile={assetProfile}
                  holding={altHolding}
                  quoteHistory={quoteHistory ?? []}
                  activeTab="overview"
                  isMobile={false}
                />
              </TabsContent>
              <TabsContent value="history" className="pt-6">
                <AlternativeAssetContent
                  assetId={assetId}
                  assetProfile={assetProfile}
                  holding={altHolding}
                  quoteHistory={quoteHistory ?? []}
                  activeTab="history"
                  isMobile={false}
                />
              </TabsContent>
            </Tabs>
          )
        ) : isMobile ? (
          <SwipableView
            items={swipableTabs}
            displayToggle={true}
            onViewChange={(_index: number, name: string) => {
              const tabValue = name.toLowerCase() as AssetTab;
              if (tabValue === activeTab) {
                return;
              }
              triggerHaptic();
              setActiveTab(tabValue);
              const url = `${location.pathname}?tab=${tabValue}`;
              navigate(url, { replace: true });
            }}
          />
        ) : (
          <Tabs value={activeTab} className="space-y-4">
            {/* Overview Content: Requires profile */}
            {profile && (
              <TabsContent value="overview" className="space-y-4">
                <div className="grid grid-cols-1 gap-4 pt-0 md:grid-cols-3">
                  <AssetHistoryCard
                    assetId={profile.id ?? ""}
                    currency={quote?.currency ?? profile.currency ?? baseCurrency}
                    marketPrice={quote?.close ?? profile.marketPrice}
                    totalGainAmount={profile.totalGainAmount}
                    totalGainPercent={profile.totalGainPercent}
                    quoteHistory={quoteHistory ?? []}
                    className={`col-span-1 ${holding ? "md:col-span-2" : "md:col-span-3"}`}
                  />
                  {symbolHolding && (
                    <AssetDetailCard
                      assetData={symbolHolding}
                      className="col-span-1 md:col-span-1"
                    />
                  )}
                </div>

                <AnimatedToggleGroup
                  items={overviewSubTabs}
                  value={overviewSubTab}
                  onValueChange={(v: OverviewSubTab) => setOverviewSubTab(v)}
                  className="text-sm"
                />

                {overviewSubTab === "about" && (
                  <div className="space-y-4">
                    {/* Category badges */}
                    <div className="flex flex-wrap items-center gap-2">
                      {isClassificationsLoading ? (
                        <>
                          <Skeleton className="h-6 w-16 rounded-full" />
                          <Skeleton className="h-6 w-20 rounded-full" />
                        </>
                      ) : categoryBadges.length > 0 ? (
                        <>
                          {categoryBadges.map((badge) => (
                            <Badge
                              key={badge.id}
                              variant="secondary"
                              className="gap-1.5"
                              style={{
                                backgroundColor: `${badge.categoryColor}20`,
                                color: badge.categoryColor,
                                borderColor: badge.categoryColor,
                              }}
                            >
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: badge.categoryColor }}
                              />
                              {badge.categoryName}
                            </Badge>
                          ))}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={() => {
                              setEditSheetDefaultTab("classification");
                              setEditSheetOpen(true);
                            }}
                          >
                            More
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground h-6 text-xs"
                          onClick={() => {
                            setEditSheetDefaultTab("classification");
                            setEditSheetOpen(true);
                          }}
                        >
                          + Add classifications
                        </Button>
                      )}
                    </div>

                    {/* ISIN */}
                    {profile.isin && (
                      <p className="text-muted-foreground text-sm">
                        <span className="font-medium">ISIN:</span> {profile.isin}
                      </p>
                    )}

                    {/* Notes section */}
                    <p className="text-muted-foreground text-sm">
                      {assetProfile?.notes || holding?.instrument?.notes || "No notes added."}
                    </p>
                  </div>
                )}

                {overviewSubTab === "holdings" && (
                  <AssetAccountHoldings assetId={assetId} baseCurrency={baseCurrency} />
                )}

                {overviewSubTab === "snapshots" && (
                  <AssetSnapshotHistory assetId={assetId} baseCurrency={baseCurrency} />
                )}
              </TabsContent>
            )}

            {/* Lots Content: Requires profile and lot rows */}
            {profile && assetLots.length > 0 && (
              <TabsContent value="lots">
                <AssetLotsTable
                  lots={assetLots}
                  currency={symbolHolding?.currency ?? profile.currency ?? baseCurrency}
                  marketPrice={Number(holding?.price ?? profile.marketPrice)}
                  contractMultiplier={Number(holding?.contractMultiplier ?? 1)}
                  dayChangeAmount={
                    holding?.dayChange?.local != null ? Number(holding.dayChange.local) : null
                  }
                  dayChangePct={holding?.dayChangePct ?? null}
                />
              </TabsContent>
            )}

            {/* History/Quotes Content: Requires quoteHistory */}
            <TabsContent value="history" className="space-y-16 pt-6">
              {isAltAsset ? (
                <ValueHistoryDataGrid
                  data={quoteHistory ?? []}
                  currency={profile?.currency ?? baseCurrency}
                  isLiability={isLiability}
                  onSaveQuote={(quote: Quote) => {
                    saveQuoteMutation.mutate(quote);
                  }}
                  onDeleteQuote={(id: string) => deleteQuoteMutation.mutate(id)}
                />
              ) : (
                <QuoteHistoryDataGrid
                  data={quoteHistory ?? []}
                  assetId={assetId}
                  currency={quote?.currency ?? profile?.currency ?? baseCurrency}
                  assetKind={assetProfile?.kind}
                  isManualDataSource={isManualPricingMode}
                  onSaveQuote={(quote: Quote) => saveQuoteMutation.mutate(quote)}
                  onDeleteQuote={(id: string) => deleteQuoteMutation.mutate(id)}
                  onChangeDataSource={(isManual) => {
                    if (profile) {
                      updateQuoteModeMutation.mutate({
                        assetId: assetId,
                        quoteMode: isManual ? "MANUAL" : "MARKET",
                      });
                    }
                  }}
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </PageContent>

      <RefreshQuotesConfirmDialog
        open={refreshConfirmOpen}
        onOpenChange={setRefreshConfirmOpen}
        onConfirm={handleRefreshQuotes}
      />

      {/* Confirm Option Expiry Dialog */}
      <AlertDialog open={confirmExpiryOpen} onOpenChange={setConfirmExpiryOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm option expiry</AlertDialogTitle>
            <AlertDialogDescription>
              This will record the option as expired worthless, removing the position with no cash
              effect. This action cannot be easily undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmExpiryMutation.mutate();
                setConfirmExpiryOpen(false);
              }}
            >
              Confirm Expiry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Sheet (for regular assets) */}
      <AssetEditSheet
        open={editSheetOpen}
        onOpenChange={setEditSheetOpen}
        asset={assetProfile ?? null}
        latestQuote={quote}
        defaultTab={editSheetDefaultTab}
      />

      {/* Alternative Asset Modals */}
      {isAltAsset && altHolding && altAssetActions.modals}
    </Page>
  );
};

// Helper component for alternative asset icons
function AlternativeAssetIcon({ kind, size = 20 }: { kind: string; size?: number }) {
  switch (kind.toLowerCase()) {
    case "property":
      return <Icons.RealEstateDuotone size={size} />;
    case "vehicle":
      return <Icons.VehicleDuotone size={size} />;
    case "collectible":
      return <Icons.CollectibleDuotone size={size} />;
    case "precious":
      return <Icons.PreciousDuotone size={size} />;
    case "liability":
      return <Icons.LiabilityDuotone size={size} />;
    default:
      return <Icons.OtherAssetDuotone size={size} />;
  }
}

// Helper to get display label for alternative asset kinds
function getAlternativeAssetKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    property: "Property",
    vehicle: "Vehicle",
    collectible: "Collectible",
    precious: "Precious Metal",
    liability: "Liability",
    other: "Other Asset",
  };
  return labels[kind.toLowerCase()] || kind;
}

export default AssetProfilePage;
