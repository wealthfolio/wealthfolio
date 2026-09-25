import HistoryChart from "@/components/history-chart-symbol";
import { getQuoteHistory } from "@/adapters";
import { useAlternativeHoldings, useLinkedLiabilities } from "@/hooks/use-alternative-assets";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { QueryKeys } from "@/lib/query-keys";
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
import { addDays, addMonths, differenceInMonths, format, parseISO } from "date-fns";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, XAxis } from "recharts";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueries } from "@tanstack/react-query";
import { formatDateISO } from "@/lib/utils";
import {
  AlternativeAssetQuickAddModal,
  AssetDetailsSheet,
  type AssetDetailsSheetAsset,
  UpdateValuationModal,
  ValueHistoryDataGrid,
} from "./alternative-assets";
import {
  CloseLoanDialog,
  RecalculateScheduleDialog,
  RenewLoanDialog,
  LoanBalanceEventDialog,
} from "./alternative-assets/components/loan-action-dialogs";
import { LoanAmortizationSchedule } from "./alternative-assets/components/loan-amortization-schedule";
import { LoanProgressSummary } from "./alternative-assets/components/loan-progress-summary";
import { getLoanValuationSnapshot } from "./alternative-assets/lib/loan-valuation";
import { useAlternativeAssetMutations } from "./alternative-assets/hooks/use-alternative-asset-mutations";
import {
  buildLoanSchedule,
  calculateMonthlyPayment,
  calculateRemainingPaymentCount,
  getRemainingScheduleWindow,
} from "./alternative-assets/lib/loan-schedule";
import { calculatePaymentCountThroughDate } from "./alternative-assets/lib/loan-calculator";
import { useQuoteMutations } from "./hooks/use-quote-mutations";
import { LinkedAssetSection, LinkedLiabilitiesSection } from "./linked-liabilities-card";
import {
  appendLoanEvent,
  getLoanFrequencyAtDate,
  type LoanEvent,
  type LoanMetadata,
  type LoanPaymentFrequency,
} from "./alternative-assets/lib/loan-events";
import {
  getLatestCurrentLoanBalance,
  loanEventProvenance,
} from "./alternative-assets/lib/loan-balance";
import {
  buildLoanChartData,
  getRemainingLoanProjection,
} from "./alternative-assets/lib/loan-projection";
import type { DatedLoanProjectionRow } from "./alternative-assets/lib/loan-calculator";

function serializeLoanMetadataValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

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
  const linkedLiabilityQuoteResults = useQueries({
    queries: linkedLiabilities.map((liability) => ({
      queryKey: [QueryKeys.QUOTE_HISTORY, liability.id],
      queryFn: () => getQuoteHistory(liability.id),
      enabled: isLinkableAsset,
    })),
  });
  const valuedLinkedLiabilities = linkedLiabilities.map((liability, index) => ({
    ...liability,
    marketValue: String(
      getLoanValuationSnapshot(
        liability.marketValue,
        liability.metadata,
        linkedLiabilityQuoteResults[index]?.data ?? [],
      ).currentBalance,
    ),
  }));

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

  const { updateMetadataMutation } = useAlternativeAssetMutations();

  const [closeLoanOpen, setCloseLoanOpen] = useState(false);
  const [recalculateScheduleOpen, setRecalculateScheduleOpen] = useState(false);
  const [renewLoanOpen, setRenewLoanOpen] = useState(false);
  const [balanceCorrectionOpen, setBalanceCorrectionOpen] = useState(false);
  const [extraRepaymentOpen, setExtraRepaymentOpen] = useState(false);

  // Loan-specific computations (used in history tab and handlers)
  const metadata = useMemo(() => holding.metadata || {}, [holding.metadata]);
  const isLiability = holding.kind.toLowerCase() === "liability";
  const loanValuation = useMemo(
    () => getLoanValuationSnapshot(holding.marketValue, metadata, quoteHistory),
    [holding.marketValue, metadata, quoteHistory],
  );
  const currentBalance =
    holding.kind.toLowerCase() === "liability"
      ? loanValuation.currentBalance
      : Math.abs(parseFloat(holding.marketValue));
  const interestRate = metadata.interest_rate ? parseFloat(metadata.interest_rate as string) : 0;
  const storedFrequency: LoanPaymentFrequency =
    metadata.payment_frequency === "biweekly" ? "biweekly" : "monthly";
  const remainingLoanProjection = useMemo(
    () => (isLiability ? getRemainingLoanProjection(metadata, quoteHistory) : null),
    [isLiability, metadata, quoteHistory],
  );
  const loanFrequency = remainingLoanProjection?.frequency ?? storedFrequency;
  const activeInterestRate = remainingLoanProjection?.annualRate ?? interestRate;
  const endDate = (metadata.end_date as string | undefined)
    ? parseISO(metadata.end_date as string)
    : estimateEndDate(
        (metadata.origination_date ?? metadata.purchase_date) as string | undefined,
        (metadata.original_amount ?? metadata.purchase_price) as string | undefined,
        holding.marketValue,
        interestRate,
        metadata.current_monthly_payment
          ? parseFloat(metadata.current_monthly_payment as string)
          : null,
        loanFrequency,
      );
  const remainingMonths = endDate ? Math.max(1, differenceInMonths(endDate, new Date())) : 0;
  // Monthly payment uses original amount + total term (French amortization constant installment)
  const loanOriginationDate = (metadata.origination_date ?? metadata.purchase_date) as
    | string
    | undefined;
  const loanOriginalAmount = loanValuation.originalAmount ?? 0;
  const totalPaymentCount =
    endDate && loanOriginationDate
      ? calculatePaymentCountThroughDate(parseISO(loanOriginationDate), endDate, loanFrequency)
      : remainingMonths;
  const storedMonthlyPayment = metadata.current_monthly_payment
    ? parseFloat(metadata.current_monthly_payment as string)
    : null;
  const monthlyPayment =
    storedMonthlyPayment !== null &&
    Number.isFinite(storedMonthlyPayment) &&
    storedMonthlyPayment >= 0
      ? storedMonthlyPayment
      : calculateMonthlyPayment(loanOriginalAmount, interestRate, totalPaymentCount, loanFrequency);

  // Future instalments are projections, not market observations. They are
  // recalculated from loan metadata and events and are deliberately not
  // persisted as quotes. Existing generated quotes remain untouched for the
  // compatibility/migration work planned in the next commit.
  const replaceGeneratedLoanSchedule = (
    _schedule: ReturnType<typeof buildLoanSchedule>,
    _effectiveDate: Date,
  ) => undefined;

  const handleCloseLoan = async (date: Date) => {
    const cappedDate = date;
    const quote: Quote = {
      id: "",
      createdAt: new Date().toISOString(),
      dataSource: "MANUAL",
      timestamp: `${formatDateISO(cappedDate)}T00:00:00Z`,
      assetId,
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      adjclose: 0,
      volume: 0,
      currency: holding.currency,
      notes: "loan_closed",
    };
    await saveQuoteMutation.mutateAsync(quote);
    const existingMetadata = Object.fromEntries(
      Object.entries(holding.metadata || {}).map(([k, v]) => [k, serializeLoanMetadataValue(v)]),
    );
    await updateMetadataMutation.mutateAsync({
      assetId,
      metadata: {
        ...existingMetadata,
        end_date: formatDateISO(cappedDate),
        current_monthly_payment: "0",
      },
    });
    await invalidateQuoteQueries();
    setCloseLoanOpen(false);
  };

  const handleRecalculateSchedule = async (newRate: number) => {
    if (!endDate || !loanOriginationDate) return;
    const originationDate = parseISO(loanOriginationDate);
    const today = new Date();
    const scheduleWindow = getRemainingScheduleWindow(
      originationDate,
      today,
      endDate,
      loanFrequency,
    );
    if (!scheduleWindow) return;
    // Latest balance: last quote at or before today, sorted chronologically.
    const sortedPast = [...quoteHistory]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .filter((q) => new Date(q.timestamp) <= today);
    const latestQuote = sortedPast.at(-1);
    const latestBalance = latestQuote ? Math.abs(latestQuote.close) : currentBalance;

    const remainingN = scheduleWindow.paymentCount;
    const P = calculateMonthlyPayment(latestBalance, newRate, remainingN, loanFrequency);
    if (P === null) return;

    const quotes = buildLoanSchedule({
      assetId,
      currency: holding.currency,
      startingBalance: latestBalance,
      annualRate: newRate,
      paymentCount: remainingN,
      firstPaymentDate: scheduleWindow.firstPaymentDate,
      frequency: loanFrequency,
    });

    if (quotes.length > 0) replaceGeneratedLoanSchedule(quotes, today);

    // Always persist the new effective payment; also update rate if it changed
    const existingMetadata = Object.fromEntries(
      Object.entries(holding.metadata || {}).map(([k, v]) => [k, serializeLoanMetadataValue(v)]),
    );
    const metaUpdates: Record<string, string> = {
      ...existingMetadata,
      current_monthly_payment: String(Math.round(P * 100) / 100),
      payment_frequency: loanFrequency,
    };
    if (newRate !== interestRate) {
      metaUpdates.interest_rate = String(newRate);
    }
    await updateMetadataMutation.mutateAsync({ assetId, metadata: metaUpdates });

    await invalidateQuoteQueries();
    setRecalculateScheduleOpen(false);
  };

  const handleRenewLoan = async (
    effectiveDate: Date,
    newRate: number,
    paymentAmount?: number,
    termEndDate?: Date,
  ) => {
    const metadata = { ...(holding.metadata || {}) } as LoanMetadata;
    const nextMetadata = appendLoanEvent(metadata, {
      type: "renewal",
      effectiveDate: formatDateISO(effectiveDate),
      annualRate: newRate,
      frequency: loanFrequency,
      ...(paymentAmount !== undefined ? { paymentAmount } : {}),
      ...(termEndDate ? { termEndDate: formatDateISO(termEndDate) } : {}),
    });
    const updates: Record<string, string> = Object.fromEntries(
      Object.entries(nextMetadata).map(([key, value]) => [key, serializeLoanMetadataValue(value)]),
    );
    updates.interest_rate = String(newRate);
    updates.payment_frequency = loanFrequency;
    if (paymentAmount !== undefined) updates.current_monthly_payment = String(paymentAmount);
    if (termEndDate) updates.end_date = formatDateISO(termEndDate);
    await updateMetadataMutation.mutateAsync({ assetId, metadata: updates });
    await invalidateQuoteQueries();
    setRenewLoanOpen(false);
  };

  const handleBalanceEvent = async (
    mode: "balance_correction" | "extra_repayment",
    effectiveDate: Date,
    amount: number,
  ) => {
    const effectiveDay = formatDateISO(effectiveDate);
    const balanceAtDate = Math.abs(
      getLatestCurrentLoanBalance(quoteHistory, new Date(`${effectiveDay}T23:59:59.999Z`))?.close ??
        currentBalance,
    );
    const appliedAmount = mode === "extra_repayment" ? Math.min(amount, balanceAtDate) : amount;
    const newBalance =
      mode === "balance_correction" ? appliedAmount : Math.max(0, balanceAtDate - appliedAmount);
    const metadata = { ...(holding.metadata || {}) } as LoanMetadata;
    const event: LoanEvent =
      mode === "balance_correction"
        ? { type: mode, effectiveDate: effectiveDay, balance: newBalance }
        : { type: mode, effectiveDate: effectiveDay, amount: appliedAmount };
    const nextMetadata = appendLoanEvent(metadata, event);
    const updates: Record<string, string> = Object.fromEntries(
      Object.entries(nextMetadata).map(([key, value]) => [key, serializeLoanMetadataValue(value)]),
    );

    await saveQuoteMutation.mutateAsync({
      id: "",
      createdAt: new Date().toISOString(),
      dataSource: "MANUAL",
      timestamp: `${effectiveDay}T00:00:00Z`,
      assetId,
      open: newBalance,
      high: newBalance,
      low: newBalance,
      close: newBalance,
      adjclose: newBalance,
      volume: 0,
      currency: holding.currency,
      notes: loanEventProvenance(mode),
    });
    await updateMetadataMutation.mutateAsync({ assetId, metadata: updates });
    await invalidateQuoteQueries();
    setBalanceCorrectionOpen(false);
    setExtraRepaymentOpen(false);
  };

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
      // For liabilities: derive from original_amount vs current balance so cost-basis
      // errors in the portfolio engine don't pollute the header display.
      if (holding.kind.toLowerCase() === "liability") {
        const originalAmount = loanValuation.originalAmount ?? 0;
        const currentBal = currentBalance;
        if (originalAmount > 0) {
          const ga = currentBal - originalAmount; // negative = paid down (good)
          return { gainAmount: ga, gainPercent: ga / originalAmount };
        }
      }
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
  }, [
    filteredChartData,
    selectedIntervalCode,
    holding.unrealizedGain,
    holding.unrealizedGainPct,
    holding.kind,
    holding.metadata,
    holding.marketValue,
    currentBalance,
    loanValuation.originalAmount,
  ]);

  const handleIntervalSelect = (
    code: TimePeriod,
    description: string,
    range: DateRange | undefined,
  ) => {
    setSelectedIntervalCode(code);
    setSelectedIntervalDesc(description);
    setDateRange(range);
  };

  const marketValue = isLiability ? -currentBalance : parseFloat(holding.marketValue);

  // Calculate net equity for linkable assets
  const netEquity = useMemo(() => {
    if (valuedLinkedLiabilities.length === 0) {
      return null;
    }
    const liabilityTotal = valuedLinkedLiabilities.reduce((sum, liability) => {
      return sum + Math.abs(parseFloat(liability.marketValue));
    }, 0);
    return marketValue - liabilityTotal;
  }, [marketValue, valuedLinkedLiabilities]);

  // Total interest paid: base formula corrected for early lump-sum repayments.
  // Early repayments are pure capital (zero interest) but inflate amountPaid;
  // we add them back so they don't reduce the interest count.
  const totalInterestPaid = useMemo(() => {
    if (
      !isLiability ||
      !loanOriginationDate ||
      monthlyPayment === null ||
      !Number.isFinite(monthlyPayment) ||
      totalPaymentCount <= 0
    )
      return null;
    const now = new Date();
    // The origination-date quote is the first paid instalment, so include it
    // in the number of payments represented by the current balance.
    const paymentsMade = Math.min(
      calculatePaymentCountThroughDate(parseISO(loanOriginationDate), now, loanFrequency),
      totalPaymentCount,
    );
    const scheduledQuotes = [...quoteHistory]
      .filter(
        (q) =>
          new Date(q.timestamp) <= now &&
          (q.notes?.startsWith("loan_schedule") || q.notes?.startsWith("early_repayment:")),
      )
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (scheduledQuotes.length > 0) {
      let previousBalance = loanOriginalAmount;
      return scheduledQuotes.reduce((sum, quote) => {
        const isEarlyRepayment = quote.notes?.startsWith("early_repayment:");
        const rateText = quote.notes?.match(/(?:^|\|)rate=([\d.]+)/)?.[1];
        const rate = rateText ? Number.parseFloat(rateText) : interestRate;
        const periodsPerYear =
          getLoanFrequencyAtDate(metadata, quote.timestamp.slice(0, 10)) === "monthly" ? 12 : 26;
        const interest = isEarlyRepayment ? 0 : previousBalance * (rate / 100 / periodsPerYear);
        previousBalance = Math.abs(quote.close);
        return sum + Math.max(0, interest);
      }, 0);
    }

    // Legacy quotes do not contain historical rate/payment metadata.
    const amountPaid = loanOriginalAmount - currentBalance;
    return Math.max(0, paymentsMade * monthlyPayment - amountPaid);
  }, [
    isLiability,
    loanOriginationDate,
    monthlyPayment,
    totalPaymentCount,
    loanFrequency,
    interestRate,
    loanOriginalAmount,
    currentBalance,
    quoteHistory,
  ]);

  if (activeTab === "overview") {
    return (
      <div className="space-y-4">
        {isLiability && (
          <LoanProgressSummary
            originalAmount={loanOriginalAmount}
            currentBalance={currentBalance}
            totalInterestPaid={totalInterestPaid}
            quoteHistory={quoteHistory}
            metadata={metadata}
            currency={holding.currency}
          />
        )}
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
                  {isLiability ? (
                    <LiabilityHistoryChart
                      data={filteredChartData}
                      projectedRows={remainingLoanProjection?.projection.rows}
                    />
                  ) : (
                    <HistoryChart data={filteredChartData} />
                  )}
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
            hasLinkedLiabilities={valuedLinkedLiabilities.length > 0}
            linkedLiabilities={isLinkableAsset ? valuedLinkedLiabilities : []}
            isLiability={isLiability}
            totalInterestPaid={isLiability ? totalInterestPaid : null}
            monthlyPayment={isLiability ? monthlyPayment : null}
            interestRate={isLiability ? activeInterestRate : undefined}
            currentBalance={isLiability ? currentBalance : undefined}
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
    <>
      <ValueHistoryDataGrid
        key={assetId}
        data={quoteHistory}
        assetId={assetId}
        currency={holding.currency}
        isLiability={isLiability}
        interestRate={isLiability ? interestRate : undefined}
        loanOriginalAmount={isLiability ? loanOriginalAmount : undefined}
        loanOriginationDate={
          isLiability && loanOriginationDate ? parseISO(loanOriginationDate) : undefined
        }
        loanMetadata={isLiability ? metadata : undefined}
        onSaveQuote={(quote: Quote) => saveQuoteMutation.mutateAsync(quote)}
        onDeleteQuote={(id: string) => deleteQuoteMutation.mutateAsync(id)}
        onPersistComplete={invalidateQuoteQueries}
        contentAfterToolbar={
          isLiability ? (
            <LoanAmortizationSchedule
              quoteHistory={quoteHistory}
              metadata={holding.metadata || {}}
              currency={holding.currency}
            />
          ) : undefined
        }
        onCloseLoan={isLiability ? () => setCloseLoanOpen(true) : undefined}
        onRecalculateSchedule={isLiability ? () => setRecalculateScheduleOpen(true) : undefined}
        onBalanceCorrection={isLiability ? () => setBalanceCorrectionOpen(true) : undefined}
        onExtraRepayment={isLiability ? () => setExtraRepaymentOpen(true) : undefined}
      />
      {isLiability && (
        <>
          <CloseLoanDialog
            open={closeLoanOpen}
            onOpenChange={setCloseLoanOpen}
            onSubmit={handleCloseLoan}
            originationDate={loanOriginationDate ? parseISO(loanOriginationDate) : null}
          />
          <RecalculateScheduleDialog
            open={recalculateScheduleOpen}
            onOpenChange={setRecalculateScheduleOpen}
            currentBalance={currentBalance}
            currency={holding.currency}
            interestRate={interestRate}
            endDate={endDate}
            frequency={loanFrequency}
            remainingPayments={remainingLoanProjection?.projection.remainingPayments ?? 0}
            onSubmit={handleRecalculateSchedule}
          />
          <RenewLoanDialog
            open={renewLoanOpen}
            onOpenChange={setRenewLoanOpen}
            currentBalance={currentBalance}
            currency={holding.currency}
            interestRate={interestRate}
            endDate={endDate}
            onSubmit={handleRenewLoan}
          />
          <LoanBalanceEventDialog
            open={balanceCorrectionOpen}
            onOpenChange={setBalanceCorrectionOpen}
            mode="balance_correction"
            currentBalance={currentBalance}
            onSubmit={(date, amount) => handleBalanceEvent("balance_correction", date, amount)}
          />
          <LoanBalanceEventDialog
            open={extraRepaymentOpen}
            onOpenChange={setExtraRepaymentOpen}
            mode="extra_repayment"
            currentBalance={currentBalance}
            onSubmit={(date, amount) => handleBalanceEvent("extra_repayment", date, amount)}
          />
        </>
      )}
    </>
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
  other: "asset:altContent.liabilityType.other",
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
  totalInterestPaid?: number | null;
  monthlyPayment?: number | null;
  interestRate?: number;
  currentBalance?: number;
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
  totalInterestPaid = null,
  monthlyPayment = null,
  interestRate,
  currentBalance,
  className,
}) => {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();

  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();

  const metadata = useMemo(() => holding.metadata || {}, [holding.metadata]);
  const kind = holding.kind.toLowerCase();

  // Calculate liability progress (amountPaid + percentPaid for header display)
  const liabilityProgress = useMemo(() => {
    if (!isLiability) return null;

    const balance = currentBalance ?? Math.abs(parseFloat(holding.marketValue));
    // Check both new field (original_amount) and legacy field (purchase_price) for backwards compatibility
    const origAmountStr = (metadata.original_amount ?? metadata.purchase_price) as
      | string
      | undefined;
    const originalAmount = origAmountStr ? parseFloat(origAmountStr) : null;

    if (!originalAmount || originalAmount <= 0) {
      return { amountPaid: null, percentPaid: null, originalAmount: null, currentBalance: balance };
    }

    const amountPaid = originalAmount - balance;
    const percentPaid = amountPaid / originalAmount;

    return { amountPaid, percentPaid, originalAmount, currentBalance: balance };
  }, [currentBalance, isLiability, metadata.original_amount, metadata.purchase_price]);

  // Build detail rows based on asset type
  const detailRows = useMemo(
    () =>
      getDetailRows(
        kind,
        metadata,
        holding,
        isBalanceHidden,
        t,
        dateFormatting,
        monthlyPayment,
        totalInterestPaid,
        interestRate,
        currentBalance,
      ),
    [
      kind,
      metadata,
      holding,
      isBalanceHidden,
      t,
      dateFormatting,
      monthlyPayment,
      totalInterestPaid,
      interestRate,
      currentBalance,
    ],
  );

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
                {dateFormatting.formatCalendarDate(holding.valuationDate.split("T")[0])}
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
  monthlyPayment: number | null = null,
  totalInterestPaid: number | null = null,
  interestRate: number | undefined = undefined,
  currentBalance: number | null = null,
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
      const balance = currentBalance ?? Math.abs(parseFloat(holding.marketValue));
      rows.push({
        label: t("asset:altContent.current_balance"),
        value: (
          <AmountDisplay value={balance} currency={holding.currency} isHidden={isBalanceHidden} />
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
      if (interestRate !== undefined && Number.isFinite(interestRate)) {
        rows.push({
          label: t("asset:altContent.interest_rate"),
          value: `${interestRate}%`,
        });
      }

      // Monthly payment
      if (monthlyPayment !== null) {
        rows.push({
          label: t("asset:valueHistory.payment"),
          value: (
            <AmountDisplay
              value={monthlyPayment}
              currency={holding.currency}
              isHidden={isBalanceHidden}
            />
          ),
        });
      }

      // Total interest paid to date
      if (totalInterestPaid !== null) {
        rows.push({
          label: t("asset:altContent.total_interest_paid"),
          value: (
            <AmountDisplay
              value={totalInterestPaid}
              currency={holding.currency}
              isHidden={isBalanceHidden}
            />
          ),
        });
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

      // End date: explicit or estimated
      const endDateStr = metadata.end_date as string | undefined;
      const originalAmountForEst = (metadata.original_amount ?? metadata.purchase_price) as
        | string
        | undefined;
      const annualRateForEst = metadata.interest_rate
        ? parseFloat(metadata.interest_rate as string)
        : 0;
      const storedPaymentForEst = metadata.current_monthly_payment
        ? parseFloat(metadata.current_monthly_payment as string)
        : null;
      const estimatedEnd = !endDateStr
        ? estimateEndDate(
            originationDate,
            originalAmountForEst,
            holding.marketValue,
            annualRateForEst,
            storedPaymentForEst,
            metadata.payment_frequency === "biweekly" ? "biweekly" : "monthly",
          )
        : null;

      if (endDateStr) {
        rows.push({
          label: t("asset:altContent.end_date"),
          value: formatting.formatCalendarDate(endDateStr),
        });
      } else if (estimatedEnd) {
        rows.push({
          label: t("asset:altContent.end_date_estimated"),
          value: format(estimatedEnd, "MMM yyyy"),
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

function LiabilityHistoryChart({
  data,
  projectedRows = [],
}: {
  data: { timestamp: string; totalValue: number; currency: string }[];
  projectedRows?: DatedLoanProjectionRow[];
}) {
  const {
    data: chartData,
    splitPercent,
    todayTimestamp,
  } = useMemo(() => buildLoanChartData(data, projectedRows), [data, projectedRows]);

  const split = `${splitPercent.toFixed(2)}%`;

  return (
    <div className="relative flex h-full flex-col" data-no-swipe-drag>
      <div className="grow">
        <ResponsiveContainer width="100%" height="100%" minHeight={350}>
          <AreaChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="liabilityStroke" x1="0" x2="1" y1="0" y2="0">
                <stop offset={split} stopColor="var(--muted-foreground)" stopOpacity={1} />
                <stop offset={split} stopColor="var(--success)" stopOpacity={1} />
              </linearGradient>
              <linearGradient id="liabilityFill" x1="0" x2="1" y1="0" y2="0">
                <stop offset={split} stopColor="var(--muted-foreground)" stopOpacity={0.18} />
                <stop offset={split} stopColor="var(--success)" stopOpacity={0.15} />
              </linearGradient>
            </defs>
            <XAxis hide dataKey="timestamp" type="category" />
            <Area
              isAnimationActive={false}
              connectNulls
              type="monotone"
              dataKey="totalValue"
              stroke="url(#liabilityStroke)"
              strokeWidth={1.5}
              fillOpacity={1}
              fill="url(#liabilityFill)"
              dot={false}
            />
            {todayTimestamp && splitPercent < 100 && (
              <ReferenceLine
                x={todayTimestamp}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 3"
                strokeWidth={1}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function estimateEndDate(
  originationDateStr: string | undefined,
  originalAmountStr: string | undefined,
  currentMarketValue: string,
  annualRate?: number,
  storedMonthlyPayment?: number | null,
  frequency: LoanPaymentFrequency = "monthly",
): Date | null {
  if (!originationDateStr || !originalAmountStr) return null;

  const originationDate = parseISO(originationDateStr);
  const originalAmount = parseFloat(originalAmountStr);
  const currentBalance = Math.abs(parseFloat(currentMarketValue));

  if (!originalAmount || originalAmount <= 0 || currentBalance >= originalAmount) return null;

  if (
    annualRate !== undefined &&
    annualRate >= 0 &&
    storedMonthlyPayment &&
    storedMonthlyPayment > 0
  ) {
    const remainingCount = calculateRemainingPaymentCount(
      currentBalance,
      annualRate,
      storedMonthlyPayment,
      frequency,
    );
    if (remainingCount !== null && remainingCount > 0) {
      return frequency === "monthly"
        ? addMonths(new Date(), remainingCount)
        : addDays(new Date(), remainingCount * 14);
    }
  }

  const amountPaid = originalAmount - currentBalance;
  const percentPaid = amountPaid / originalAmount;
  if (percentPaid <= 0) return null;

  const monthsElapsed = differenceInMonths(new Date(), originationDate);
  if (monthsElapsed <= 0) return null;

  const estimatedTotalMonths = Math.round(monthsElapsed / percentPaid);
  return addMonths(originationDate, estimatedTotalMonths);
}

export default AlternativeAssetContent;
