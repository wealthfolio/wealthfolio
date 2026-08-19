import HistoryChart from "@/components/history-chart-symbol";
import { useAlternativeHoldings, useLinkedLiabilities } from "@/hooks/use-alternative-assets";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { AlternativeAssetHolding, Asset, DateRange, Quote, TimePeriod } from "@/lib/types";
import { AlternativeAssetKind } from "@/lib/types";
import {
  AmountDisplay,
  EmptyPlaceholder,
  type FormattingApi,
  Icons,
  IntervalSelector,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
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
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import type { TFunction } from "i18next";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlternativeAssetQuickAddModal,
  AssetDetailsSheet,
  type AssetDetailsSheetAsset,
  UpdateValuationModal,
  ValueHistoryDataGrid,
} from "./alternative-assets";
import { useAlternativeAssetMutations } from "./alternative-assets/hooks/use-alternative-asset-mutations";
import { useQuoteMutations } from "./hooks/use-quote-mutations";
import { LinkedAssetSection, LinkedLiabilitiesSection } from "./linked-liabilities-card";

interface AlternativeAssetContentProps {
  assetId: string;
  assetProfile: Asset;
  holding: AlternativeAssetHolding;
  quoteHistory: Quote[];
  activeTab: "overview" | "history";
  isMobile?: boolean;
}

/**
 * Content component for alternative asset detail pages.
 * Handles Overview and History tabs with alternative-specific layouts.
 */
export const AlternativeAssetContent: React.FC<AlternativeAssetContentProps> = ({
  assetId,
  assetProfile,
  holding,
  quoteHistory,
  activeTab,
}) => {
  const formatting = useNumberFormatting();
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();

  // Chart state
  const [selectedIntervalCode, setSelectedIntervalCode] = useState<TimePeriod>("ALL");
  const [selectedIntervalDesc, setSelectedIntervalDesc] = useState<string>("all time");
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

  // Fetch linked liabilities for property/vehicle
  const isLinkableAsset =
    holding.kind.toLowerCase() === "property" || holding.kind.toLowerCase() === "vehicle";
  const { data: linkedLiabilities = [] } = useLinkedLiabilities({
    assetId,
    enabled: isLinkableAsset,
  });

  // Fetch all alternative holdings to find linked asset for liabilities
  const { data: allHoldings = [] } = useAlternativeHoldings({ enabled: !!holding.linkedAssetId });
  const linkedAsset = useMemo(() => {
    if (!holding.linkedAssetId) return undefined;
    return allHoldings.find((h) => h.id === holding.linkedAssetId);
  }, [holding.linkedAssetId, allHoldings]);

  // Quote mutations for history grid
  const { saveQuoteMutation, deleteQuoteMutation, invalidateQuoteQueries } = useQuoteMutations(
    assetId,
    { invalidateOnSuccess: false },
  );

  // Filter chart data by date range
  const filteredChartData = useMemo(() => {
    if (!quoteHistory || quoteHistory.length === 0) return [];

    // Sort quotes chronologically (oldest first)
    const sortedQuotes = [...quoteHistory].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    if (!dateRange?.from || !dateRange?.to || selectedIntervalCode === "ALL") {
      return sortedQuotes.map((quote) => ({
        timestamp: quote.timestamp,
        totalValue: quote.close,
        currency: holding.currency,
      }));
    }

    return sortedQuotes
      .filter((quote) => {
        const quoteDate = new Date(quote.timestamp);
        return (
          dateRange.from && dateRange.to && quoteDate >= dateRange.from && quoteDate <= dateRange.to
        );
      })
      .map((quote) => ({
        timestamp: quote.timestamp,
        totalValue: quote.close,
        currency: holding.currency,
      }));
  }, [dateRange, quoteHistory, holding.currency, selectedIntervalCode]);

  // Calculate gain for displayed interval
  const { gainAmount, gainPercent } = useMemo(() => {
    const unrealizedGain = holding.unrealizedGain ? parseFloat(holding.unrealizedGain) : null;
    const unrealizedGainPct = holding.unrealizedGainPct
      ? parseFloat(holding.unrealizedGainPct)
      : null;

    if (selectedIntervalCode === "ALL") {
      return {
        gainAmount: unrealizedGain,
        gainPercent: unrealizedGainPct,
      };
    }

    // Calculate gain for filtered period
    const startValue = filteredChartData[0]?.totalValue;
    const endValue = filteredChartData.at(-1)?.totalValue;
    const isValidStartValue = typeof startValue === "number" && startValue !== 0;

    return {
      gainAmount:
        typeof startValue === "number" && typeof endValue === "number"
          ? endValue - startValue
          : null,
      gainPercent:
        isValidStartValue && typeof endValue === "number"
          ? (endValue - startValue) / startValue
          : null,
    };
  }, [filteredChartData, selectedIntervalCode, holding.unrealizedGain, holding.unrealizedGainPct]);

  const handleIntervalSelect = (
    code: TimePeriod,
    description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalCode(code);
    setSelectedIntervalDesc(description);
    setDateRange(range);
  };

  const isLiability = holding.kind.toLowerCase() === "liability";
  const marketValue = parseFloat(holding.marketValue);

  // Calculate net equity for linkable assets
  const netEquity = useMemo(() => {
    if (linkedLiabilities.length === 0) {
      return null;
    }
    const liabilityTotal = linkedLiabilities.reduce((sum, liability) => {
      return sum + Math.abs(parseFloat(liability.marketValue));
    }, 0);
    return marketValue - liabilityTotal;
  }, [marketValue, linkedLiabilities]);

  if (activeTab === "overview") {
    return (
      <div className="space-y-4">
        {/* Main grid: Chart on left, Details on right */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Left: Value history chart with value/gain/equity in header */}
          <Card className="col-span-1 md:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-md">
                <div>
                  <p className="pt-3 text-xl font-bold">
                    <AmountDisplay
                      value={isLiability ? -marketValue : marketValue}
                      currency={holding.currency}
                      isHidden={isBalanceHidden}
                    />
                  </p>
                  {gainAmount !== null && gainPercent !== null && (
                    <p
                      className={`text-sm ${
                        isLiability
                          ? gainAmount <= 0
                            ? "text-success"
                            : "text-destructive"
                          : gainAmount >= 0
                            ? "text-success"
                            : "text-destructive"
                      }`}
                    >
                      {isLiability ? (
                        <>
                          {gainAmount <= 0
                            ? t("asset:altContent.paid_down")
                            : t("asset:altContent.increased")}
                          <AmountDisplay
                            value={Math.abs(gainAmount)}
                            currency={holding.currency}
                            isHidden={isBalanceHidden}
                          />{" "}
                          ({formatting.formatPercent(Math.abs(gainPercent))}) {selectedIntervalDesc}
                        </>
                      ) : (
                        <>
                          <AmountDisplay
                            value={gainAmount}
                            currency={holding.currency}
                            isHidden={isBalanceHidden}
                          />{" "}
                          ({formatting.formatPercent(gainPercent)}) {selectedIntervalDesc}
                        </>
                      )}
                    </p>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="relative p-0">
              {filteredChartData.length > 0 ? (
                <>
                  <HistoryChart data={filteredChartData} />
                  <IntervalSelector
                    onIntervalSelect={handleIntervalSelect}
                    className="absolute bottom-2 left-1/2 -translate-x-1/2 transform"
                    defaultValue="ALL"
                  />
                </>
              ) : (
                <div className="flex h-[200px] items-center justify-center">
                  <EmptyPlaceholder
                    icon={<Icons.Activity className="text-muted-foreground h-8 w-8" />}
                    title={t("asset:altContent.no_valuation_data")}
                    description={t("asset:altContent.no_valuation_description")}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Right: Detail card */}
          <AlternativeAssetDetailCard
            holding={holding}
            linkedAsset={linkedAsset}
            netEquity={isLinkableAsset ? (netEquity ?? marketValue) : null}
            hasLinkedLiabilities={linkedLiabilities.length > 0}
            linkedLiabilities={isLinkableAsset ? linkedLiabilities : []}
            isLiability={isLiability}
            className="col-span-1"
          />
        </div>

        {/* Second row: About section */}
        <div className="space-y-4">
          <h3 className="text-lg font-bold">{t("asset:altContent.about")}</h3>

          {/* Kind and subtype badges */}
          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const kind = holding.kind.toLowerCase();
              const kindLabelKey = KIND_LABEL_KEYS[kind] || KIND_LABEL_KEYS.other;
              const subtypeLabel = getSubtypeLabel(kind, holding.metadata || {}, t);

              return (
                <>
                  <Badge
                    variant="secondary"
                    className="gap-1.5"
                    style={{
                      backgroundColor: `${KIND_COLOR}15`,
                      color: KIND_COLOR,
                    }}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: KIND_COLOR }}
                    />
                    {t(kindLabelKey)}
                  </Badge>
                  {subtypeLabel && (
                    <Badge
                      variant="secondary"
                      className="gap-1.5"
                      style={{
                        backgroundColor: `${KIND_COLOR}10`,
                        color: KIND_COLOR,
                      }}
                    >
                      {subtypeLabel}
                    </Badge>
                  )}
                </>
              );
            })()}
          </div>

          {/* Notes */}
          <p className="text-muted-foreground text-sm">
            {holding.notes || assetProfile?.notes || t("asset:altContent.no_notes")}
          </p>
        </div>
      </div>
    );
  }

  // History tab
  return (
    <ValueHistoryDataGrid
      key={assetId}
      data={quoteHistory}
      assetId={assetId}
      currency={holding.currency}
      isLiability={isLiability}
      onSaveQuote={(quote: Quote) => saveQuoteMutation.mutateAsync(quote)}
      onDeleteQuote={(id: string) => deleteQuoteMutation.mutateAsync(id)}
      onPersistComplete={invalidateQuoteQueries}
    />
  );
};

// Kind colors for badges (subtle/muted colors); labels resolved via i18n
const KIND_COLOR = "#6b7280";
const KIND_LABEL_KEYS: Record<string, string> = {
  property: "asset:altContent.kind.property",
  vehicle: "asset:altContent.kind.vehicle",
  collectible: "asset:altContent.kind.collectible",
  precious: "asset:altContent.kind.precious",
  liability: "asset:altContent.kind.liability",
  other: "asset:altContent.kind.other",
};

// Type-specific subtype label keys
const PROPERTY_TYPE_LABEL_KEYS: Record<string, string> = {
  residence: "asset:altContent.propertyType.residence",
  rental: "asset:altContent.propertyType.rental",
  land: "asset:altContent.propertyType.land",
  commercial: "asset:altContent.propertyType.commercial",
};

const VEHICLE_TYPE_LABEL_KEYS: Record<string, string> = {
  car: "asset:altContent.vehicleType.car",
  motorcycle: "asset:altContent.vehicleType.motorcycle",
  boat: "asset:altContent.vehicleType.boat",
  rv: "asset:altContent.vehicleType.rv",
  aircraft: "asset:altContent.vehicleType.aircraft",
};

const COLLECTIBLE_TYPE_LABEL_KEYS: Record<string, string> = {
  art: "asset:altContent.collectibleType.art",
  wine: "asset:altContent.collectibleType.wine",
  watch: "asset:altContent.collectibleType.watch",
  jewelry: "asset:altContent.collectibleType.jewelry",
  memorabilia: "asset:altContent.collectibleType.memorabilia",
};

const METAL_TYPE_LABEL_KEYS: Record<string, string> = {
  gold: "asset:altContent.metalType.gold",
  silver: "asset:altContent.metalType.silver",
  platinum: "asset:altContent.metalType.platinum",
  palladium: "asset:altContent.metalType.palladium",
};

const LIABILITY_TYPE_LABEL_KEYS: Record<string, string> = {
  mortgage: "asset:altContent.liabilityType.mortgage",
  auto_loan: "asset:altContent.liabilityType.auto_loan",
  student_loan: "asset:altContent.liabilityType.student_loan",
  credit_card: "asset:altContent.liabilityType.credit_card",
  personal_loan: "asset:altContent.liabilityType.personal_loan",
  heloc: "asset:altContent.liabilityType.heloc",
};

const WEIGHT_UNIT_LABEL_KEYS: Record<string, string> = {
  oz: "asset:altContent.weightUnit.oz",
  g: "asset:altContent.weightUnit.g",
  kg: "asset:altContent.weightUnit.kg",
};

interface AlternativeAssetDetailCardProps {
  holding: AlternativeAssetHolding;
  linkedAsset?: AlternativeAssetHolding;
  netEquity: number | null;
  hasLinkedLiabilities: boolean;
  linkedLiabilities: AlternativeAssetHolding[];
  className?: string;
  isLiability?: boolean;
}

/**
 * Get subtype label from metadata based on asset kind.
 * Checks both the unified 'sub_type' field and legacy type-specific fields.
 */
function getSubtypeLabel(
  kind: string,
  metadata: Record<string, unknown>,
  t: TFunction,
): string | null {
  // First check the unified sub_type field (used by quick-add modal)
  const subType = metadata.sub_type as string | undefined;
  const resolve = (value: string | undefined, keys: Record<string, string>): string | null => {
    if (!value) return null;
    const key = keys[value];
    return key ? t(key) : value;
  };

  switch (kind) {
    case "property":
      return resolve(
        subType || (metadata.property_type as string | undefined),
        PROPERTY_TYPE_LABEL_KEYS,
      );
    case "vehicle":
      return resolve(
        subType || (metadata.vehicle_type as string | undefined),
        VEHICLE_TYPE_LABEL_KEYS,
      );
    case "collectible":
      return resolve(
        subType || (metadata.collectible_type as string | undefined),
        COLLECTIBLE_TYPE_LABEL_KEYS,
      );
    case "precious":
      return resolve(subType || (metadata.metal_type as string | undefined), METAL_TYPE_LABEL_KEYS);
    case "liability":
      return resolve(
        subType || (metadata.liability_type as string | undefined),
        LIABILITY_TYPE_LABEL_KEYS,
      );
    default:
      return null;
  }
}

/**
 * Detail card for alternative assets showing:
 * - Net equity in header (for property/vehicle)
 * - Amount paid in header (for liabilities)
 * - Purchase info and last valued date
 * - Type-specific metadata
 */
const AlternativeAssetDetailCard: React.FC<AlternativeAssetDetailCardProps> = ({
  holding,
  linkedAsset,
  netEquity,
  hasLinkedLiabilities,
  linkedLiabilities,
  isLiability,
  className,
}) => {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();

  const metadata = holding.metadata || {};
  const kind = holding.kind.toLowerCase();

  // Build detail rows based on asset type
  const detailRows = getDetailRows(kind, metadata, holding, isBalanceHidden, t, dateFormatting);

  // Calculate liability progress
  const liabilityProgress = useMemo(() => {
    if (!isLiability) return null;

    const currentBalance = Math.abs(parseFloat(holding.marketValue));
    // Check both new field (original_amount) and legacy field (purchase_price) for backwards compatibility
    const origAmountStr = (metadata.original_amount ?? metadata.purchase_price) as
      | string
      | undefined;
    const originalAmount = origAmountStr ? parseFloat(origAmountStr) : null;

    if (!originalAmount || originalAmount <= 0) {
      return { amountPaid: null, percentPaid: null, originalAmount: null, currentBalance };
    }

    const amountPaid = originalAmount - currentBalance;
    const percentPaid = amountPaid / originalAmount;

    return { amountPaid, percentPaid, originalAmount, currentBalance };
  }, [isLiability, holding.marketValue, metadata.original_amount, metadata.purchase_price]);

  // Determine if we should show a header with value info
  const showNetEquityHeader = netEquity !== null;
  const showLiabilityHeader = isLiability && liabilityProgress;

  return (
    <Card className={className}>
      {/* Header: Net Equity for property/vehicle */}
      {showNetEquityHeader && (
        <CardHeader className="flex flex-row items-center justify-between pb-0">
          <CardTitle className="flex w-full justify-between text-lg font-bold">
            <div>
              <div className="text-muted-foreground text-sm font-normal">
                {t("asset:altContent.net_equity")}
              </div>
              {!hasLinkedLiabilities && (
                <div className="text-muted-foreground text-xs font-normal">
                  {t("asset:altContent.no_liabilities")}
                </div>
              )}
            </div>
            <div>
              <div
                className={`text-xl font-extrabold ${netEquity >= 0 ? "text-success" : "text-destructive"}`}
              >
                <AmountDisplay
                  value={netEquity}
                  currency={holding.currency}
                  isHidden={isBalanceHidden}
                />
              </div>
              <div className="text-muted-foreground text-right text-sm font-normal">
                {holding.currency}
              </div>
            </div>
          </CardTitle>
        </CardHeader>
      )}

      {/* Header: Amount Paid for liabilities */}
      {showLiabilityHeader && liabilityProgress.amountPaid !== null && (
        <CardHeader className="flex flex-row items-center justify-between pb-0">
          <CardTitle className="flex w-full justify-between text-lg font-bold">
            <div>
              <div className="text-muted-foreground text-sm font-normal">
                {t("asset:altContent.amount_paid")}
              </div>
              {liabilityProgress.percentPaid !== null && (
                <div className="text-muted-foreground text-xs font-normal">
                  {t("asset:altContent.percent_of_original", {
                    percent: numberFormatting.formatPercent(liabilityProgress.percentPaid),
                  })}
                </div>
              )}
            </div>
            <div>
              <div
                className={`text-xl font-extrabold ${liabilityProgress.amountPaid >= 0 ? "text-success" : "text-destructive"}`}
              >
                <AmountDisplay
                  value={liabilityProgress.amountPaid}
                  currency={holding.currency}
                  isHidden={isBalanceHidden}
                />
              </div>
              <div className="text-muted-foreground text-right text-sm font-normal">
                {holding.currency}
              </div>
            </div>
          </CardTitle>
        </CardHeader>
      )}

      {/* Fallback header for assets without special headers */}
      {!showNetEquityHeader && !showLiabilityHeader && (
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{t("asset:altContent.details")}</CardTitle>
        </CardHeader>
      )}

      <CardContent>
        {(showNetEquityHeader || showLiabilityHeader) && <Separator className="my-3" />}
        {/* Summary rows - skip purchase info for liabilities (shown in detail rows) */}
        <div className="space-y-4 text-sm">
          {!isLiability && holding.purchasePrice && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("asset:altContent.purchase_price")}</span>
              <span className="font-medium">
                <AmountDisplay
                  value={parseFloat(holding.purchasePrice)}
                  currency={holding.currency}
                  isHidden={isBalanceHidden}
                />
              </span>
            </div>
          )}

          {!isLiability && holding.purchaseDate && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("asset:altContent.purchase_date")}</span>
              <span className="font-medium">
                {dateFormatting.formatCalendarDate(holding.purchaseDate)}
              </span>
            </div>
          )}

          {holding.valuationDate && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("asset:altContent.last_updated")}</span>
              <span className="font-medium">
                {dateFormatting.formatCalendarDate(holding.valuationDate)}
              </span>
            </div>
          )}
        </div>

        {/* Type-specific details (continued without separator) */}
        {detailRows.length > 0 && (
          <div className="mt-4 space-y-4 text-sm">
            {detailRows.map((row, idx) => (
              <div key={idx} className="flex justify-between">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="text-right font-medium">{row.value}</span>
              </div>
            ))}
          </div>
        )}

        {/* Linked Asset (for liabilities) */}
        {isLiability && linkedAsset && (
          <>
            <Separator className="my-4" />
            <LinkedAssetSection
              assetId={linkedAsset.id}
              assetName={linkedAsset.name}
              assetKind={linkedAsset.kind}
              assetValue={linkedAsset.marketValue}
              currency={linkedAsset.currency}
            />
          </>
        )}

        {/* Linked Liabilities (for property/vehicle) */}
        {linkedLiabilities.length > 0 && (
          <>
            <Separator className="my-4" />
            <LinkedLiabilitiesSection liabilities={linkedLiabilities} />
          </>
        )}
      </CardContent>
    </Card>
  );
};

interface DetailRow {
  label: string;
  value: React.ReactNode;
}

function getDetailRows(
  kind: string,
  metadata: Record<string, unknown>,
  holding: AlternativeAssetHolding,
  isBalanceHidden: boolean,
  t: TFunction,
  formatting: Pick<FormattingApi, "formatCalendarDate">,
): DetailRow[] {
  const rows: DetailRow[] = [];

  switch (kind) {
    case "property": {
      // Address (type is shown in badge)
      const address = metadata.address as string | undefined;
      if (address) {
        rows.push({ label: t("asset:altContent.address"), value: address });
      }
      break;
    }

    case "vehicle": {
      // Make/Model (type is shown in badge)
      const description = metadata.description as string | undefined;
      if (description) {
        rows.push({ label: t("asset:altContent.make_model"), value: description });
      }
      break;
    }

    case "collectible": {
      // Description (type is shown in badge)
      const description = metadata.description as string | undefined;
      if (description) {
        rows.push({ label: t("asset:altContent.description"), value: description });
      }
      break;
    }

    case "precious": {
      // Quantity and unit
      const quantity = metadata.quantity as string | number | undefined;
      const unit = metadata.unit as string | undefined;
      if (quantity) {
        const unitKey = unit ? WEIGHT_UNIT_LABEL_KEYS[unit] : undefined;
        const unitLabel = unit ? (unitKey ? t(unitKey) : unit) : "";
        rows.push({
          label: t("asset:altContent.quantity"),
          value: `${quantity} ${unitLabel}`.trim(),
        });
      }
      // Purchase price per unit
      const pricePerUnit = metadata.purchase_price_per_unit as string | undefined;
      if (pricePerUnit) {
        rows.push({
          label: t("asset:altContent.purchase_price_per_unit"),
          value: (
            <AmountDisplay
              value={parseFloat(pricePerUnit)}
              currency={holding.currency}
              isHidden={isBalanceHidden}
            />
          ),
        });
      }
      // Description
      const description = metadata.description as string | undefined;
      if (description) {
        rows.push({ label: t("asset:altContent.description"), value: description });
      }
      break;
    }

    case "liability": {
      // Current balance (shown prominently for liabilities)
      const currentBalance = Math.abs(parseFloat(holding.marketValue));
      rows.push({
        label: t("asset:altContent.current_balance"),
        value: (
          <AmountDisplay
            value={currentBalance}
            currency={holding.currency}
            isHidden={isBalanceHidden}
          />
        ),
      });

      // Original amount (check both new and legacy field names)
      const originalAmount = (metadata.original_amount ?? metadata.purchase_price) as
        | string
        | undefined;
      if (originalAmount) {
        rows.push({
          label: t("asset:altContent.original_amount"),
          value: (
            <AmountDisplay
              value={parseFloat(originalAmount)}
              currency={holding.currency}
              isHidden={isBalanceHidden}
            />
          ),
        });
      }

      // Interest rate
      const interestRate = metadata.interest_rate as string | undefined;
      if (interestRate) {
        rows.push({ label: t("asset:altContent.interest_rate"), value: `${interestRate}%` });
      }

      // Note: Linked asset is shown in its own section with LinkedAssetSection

      // Origination date (check both new and legacy field names)
      const originationDate = (metadata.origination_date ?? metadata.purchase_date) as
        | string
        | undefined;
      if (originationDate) {
        rows.push({
          label: t("asset:altContent.origination_date"),
          value: formatting.formatCalendarDate(originationDate),
        });
      }
      break;
    }

    case "other":
    default: {
      const description = metadata.description as string | undefined;
      if (description) {
        rows.push({ label: t("asset:altContent.description"), value: description });
      }
      break;
    }
  }

  return rows;
}

interface AlternativeAssetActionsProps {
  holding: AlternativeAssetHolding | null | undefined;
  assetProfile: Asset | null | undefined;
  allHoldings: AlternativeAssetHolding[];
  onNavigateBack: () => void;
}

/**
 * Hook that provides alternative asset actions and modals.
 */
export function useAlternativeAssetActions({
  holding,
  allHoldings,
  onNavigateBack,
}: AlternativeAssetActionsProps) {
  const { t } = useTranslation();
  // Modal state
  const [updateValuationOpen, setUpdateValuationOpen] = useState(false);
  const [editDetailsOpen, setEditDetailsOpen] = useState(false);
  const [addLiabilityOpen, setAddLiabilityOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Mutations
  const { deleteMutation, updateMetadataMutation, linkLiabilityMutation, unlinkLiabilityMutation } =
    useAlternativeAssetMutations({
      onDeleteSuccess: onNavigateBack,
    });

  // Fetch linked liabilities for property/vehicle
  const holdingKind = holding?.kind?.toLowerCase() ?? "";
  const isLinkableAsset = holdingKind === "property" || holdingKind === "vehicle";
  const { data: linkedLiabilities = [] } = useLinkedLiabilities({
    assetId: holding?.id ?? "",
    enabled: isLinkableAsset && !!holding?.id,
  });

  // Build linkable assets for liability linking (properties and vehicles)
  const linkableAssets = useMemo(() => {
    return allHoldings.filter(
      (h) => h.kind.toLowerCase() === "property" || h.kind.toLowerCase() === "vehicle",
    );
  }, [allHoldings]);

  // Find linked asset name for liabilities
  const linkedAssetName = useMemo(() => {
    if (!holding?.linkedAssetId) return undefined;
    const linkedAsset = allHoldings.find((h) => h.id === holding.linkedAssetId);
    return linkedAsset?.name;
  }, [holding?.linkedAssetId, allHoldings]);

  // Get available (unlinked) mortgages for property linking
  const availableMortgages = useMemo(() => {
    const holdingId = holding?.id ?? "";
    return allHoldings.filter(
      (h) => h.kind.toLowerCase() === "liability" && !h.linkedAssetId && h.id !== holdingId,
    );
  }, [allHoldings, holding?.id]);

  // Handle edit sheet save
  const handleEditSave = async (
    _assetId: string,
    metadata: Record<string, string>,
    name?: string,
    notes?: string | null,
  ) => {
    if (!holding) return;
    await updateMetadataMutation.mutateAsync({
      assetId: holding.id,
      metadata,
      name,
      notes,
    });
  };

  // Handle mortgage linking
  const handleLinkMortgage = async (mortgageId: string) => {
    if (!holding) return;
    await linkLiabilityMutation.mutateAsync({
      liabilityId: mortgageId,
      request: { targetAssetId: holding.id },
    });
  };

  // Handle mortgage unlinking
  const handleUnlinkMortgage = async (mortgageId: string) => {
    await unlinkLiabilityMutation.mutateAsync(mortgageId);
  };

  // Handle delete
  const handleDelete = () => {
    if (!holding) return;
    deleteMutation.mutate(holding.id);
  };

  // Convert holding to edit sheet asset format (only if holding exists)
  const editSheetAsset: AssetDetailsSheetAsset | null = holding
    ? {
        id: holding.id,
        name: holding.name,
        kind: holding.kind.toUpperCase() as AlternativeAssetKind,
        currency: holding.currency,
        metadata: holding.metadata,
        notes: holding.notes,
      }
    : null;

  // Render modals (only if holding exists)
  const modals = holding ? (
    <>
      {/* Update Valuation Modal */}
      <UpdateValuationModal
        open={updateValuationOpen}
        onOpenChange={setUpdateValuationOpen}
        assetId={holding.id}
        assetName={holding.name}
        currentValue={holding.marketValue}
        lastUpdatedDate={holding.valuationDate}
        currency={holding.currency}
      />

      {/* Edit Details Sheet */}
      <AssetDetailsSheet
        open={editDetailsOpen}
        onOpenChange={setEditDetailsOpen}
        asset={editSheetAsset}
        onSave={handleEditSave}
        linkedAssetName={linkedAssetName}
        linkableAssets={linkableAssets.map((a) => ({ id: a.id, name: a.name }))}
        linkedLiabilities={linkedLiabilities.map((l) => ({
          id: l.id,
          name: l.name,
          balance: l.marketValue,
        }))}
        availableMortgages={availableMortgages.map((m) => ({
          id: m.id,
          name: m.name,
          balance: m.marketValue,
        }))}
        onLinkMortgage={handleLinkMortgage}
        onUnlinkMortgage={handleUnlinkMortgage}
        isSaving={updateMetadataMutation.isPending}
      />

      {/* Add Liability Modal */}
      <AlternativeAssetQuickAddModal
        open={addLiabilityOpen}
        onOpenChange={setAddLiabilityOpen}
        defaultKind={AlternativeAssetKind.LIABILITY}
        linkedAssetId={holding.id}
        defaultLiabilityType="mortgage"
        defaultName={`${holding.name} ${t("asset:altContent.mortgage_suffix")}`}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("asset:altContent.delete_asset_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("asset:altContent.delete_asset_description", { name: holding.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("asset:altContent.deleting")}
                </>
              ) : (
                t("asset:altContent.delete")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  ) : null;

  return {
    openUpdateValuation: () => setUpdateValuationOpen(true),
    openEditDetails: () => setEditDetailsOpen(true),
    openAddLiability: () => setAddLiabilityOpen(true),
    openDeleteConfirm: () => setDeleteConfirmOpen(true),
    modals,
    isLinkableAsset,
  };
}

export default AlternativeAssetContent;
