import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  differenceInCalendarDays,
  differenceInCalendarMonths,
  differenceInMonths,
  parseISO,
} from "date-fns";
import {
  AmountDisplay,
  Button,
  Icons,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { useNavigate } from "react-router-dom";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useLinkedLiabilities } from "@/hooks/use-alternative-assets";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { cn, formatDateISO } from "@/lib/utils";
import { LoanTimeline } from "./loan-timeline";
import { lastLoanConfirmation, loanMilestones } from "../lib/loan-presentation";
import { readLoanEvents, readLoanProjectionMetadata } from "../lib/loan-events";
import { getLoanRenewalSummary } from "../lib/loan-renewal-summary";
import type { LoanActionCallbacks } from "../hooks/use-loan-actions";

export interface LoanOverviewProps {
  holding: AlternativeAssetHolding;
  calculation: LoanCalculation | null;
  quotes: Quote[];
  linkedAsset?: AlternativeAssetHolding;
  actions: LoanActionCallbacks;
  onEdit: () => void;
}
/** Mortgage-specific presentation, sharing valuation and actions with other loans. */
export function MortgageOverview(props: LoanOverviewProps) {
  return <LoanOverview {...props} mortgage />;
}

const CARD_COLUMNS = ["", "md:grid-cols-1", "md:grid-cols-2", "md:grid-cols-3"];

/** Summary strip, full-width balance chart, then one card per question: term, payoff, loan. */
export function LoanOverview({
  holding,
  calculation,
  quotes,
  linkedAsset,
  actions,
  onEdit,
  mortgage = false,
}: LoanOverviewProps & { mortgage?: boolean }) {
  const today = formatDateISO(new Date());
  const metadata = holding.metadata ?? {};
  const confirmed = lastLoanConfirmation(quotes, today);
  const balance =
    calculation?.currentBalance ?? Math.abs(Number(confirmed?.close ?? holding.marketValue));
  const original = Number(metadata.original_amount ?? metadata.purchase_price);
  const originalAmount = Number.isFinite(original) && original > 0 ? original : null;
  const lastConfirmed = confirmed?.timestamp.slice(0, 10);
  const milestones = loanMilestones(calculation, metadata, today);
  const showTerm = !!calculation && (mortgage || !!milestones.maturity);
  const cards = 1 + (showTerm ? 1 : 0) + (calculation ? 1 : 0);
  return (
    <div className="space-y-4" data-testid={mortgage ? "mortgage-overview" : "loan-overview"}>
      <LoanSummaryStrip
        calculation={calculation}
        metadata={metadata}
        balance={balance}
        originalAmount={originalAmount}
        currency={holding.currency}
      />
      <LoanTimeline
        className="min-h-[400px]"
        calculation={calculation}
        quotes={quotes}
        metadata={metadata}
        currency={holding.currency}
        balance={balance}
        originalAmount={originalAmount}
        lastConfirmed={lastConfirmed}
        mortgage={mortgage}
        onConfirmBalance={actions.confirmBalance}
        onEditEvent={actions.editEvent}
        onEditTerms={onEdit}
      />
      <div className={cn("grid grid-cols-1 gap-4", CARD_COLUMNS[cards])}>
        {showTerm && calculation && (
          <ThisTermCard
            calculation={calculation}
            metadata={metadata}
            currency={holding.currency}
            mortgage={mortgage}
            onRenew={actions.renew}
            onEdit={onEdit}
          />
        )}
        {calculation && (
          <PayoffCard calculation={calculation} metadata={metadata} currency={holding.currency} />
        )}
        <LoanFactsCard
          metadata={metadata}
          currency={holding.currency}
          originalAmount={originalAmount}
          lastConfirmed={lastConfirmed}
          linkedAsset={linkedAsset}
          mortgage={mortgage}
        />
      </div>
    </div>
  );
}

/** Shared formatting for the loan overview cards. */
function useLoanFormat(currency: string) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const numbers = useNumberFormatting();
  const dates = useDateFormatting();
  const { formatAmount } = useAmountFormatting();
  return {
    t,
    isBalanceHidden,
    numbers,
    money: (amount: number | null | undefined) =>
      amount == null ? (
        <span className="text-muted-foreground">{t("asset:loanOverview.unavailable")}</span>
      ) : (
        <AmountDisplay value={amount} currency={currency} isHidden={isBalanceHidden} />
      ),
    moneyText: (amount: number) => (isBalanceHidden ? "••••" : formatAmount(amount, currency)),
    date: (value: string) =>
      dates.formatCalendarDate(value, { day: "numeric", month: "short", year: "numeric" }),
    shortDate: (value: string) =>
      dates.formatCalendarDate(value, { day: "numeric", month: "short" }),
    month: (value: string) => dates.formatCalendarDate(value, { month: "short", year: "numeric" }),
    rate: (value: number) => `${numbers.formatDecimal(value, { maximumFractionDigits: 2 })}%`,
    duration: (months: number) =>
      [
        months >= 12
          ? t("asset:loanActions.duration_year", { count: Math.floor(months / 12) })
          : null,
        months % 12 || months === 0
          ? t("asset:loanActions.duration_month", { count: months % 12 })
          : null,
      ]
        .filter(Boolean)
        .join(" "),
  };
}

function LoanSummaryStrip({
  calculation,
  metadata,
  balance,
  originalAmount,
  currency,
}: {
  calculation: LoanCalculation | null;
  metadata: Record<string, unknown>;
  balance: number;
  originalAmount: number | null;
  currency: string;
}) {
  const { t, isBalanceHidden, numbers, money, moneyText, shortDate, month, rate } =
    useLoanFormat(currency);
  const today = formatDateISO(new Date());
  const milestones = loanMilestones(calculation, metadata, today);
  const progress =
    originalAmount != null
      ? Math.max(0, Math.min(1, (originalAmount - balance) / originalAmount))
      : null;
  const currentRenewal = readLoanEvents(metadata)
    .filter((event) => event.type === "renewal" && event.effectiveDate <= today)
    .at(-1);
  const termStart =
    currentRenewal?.effectiveDate ??
    (typeof metadata.origination_date === "string" ? metadata.origination_date : undefined);
  const termEnd = milestones.maturity ?? milestones.horizon;
  const annualRate = calculation?.annualRate ?? Number(metadata.interest_rate ?? Number.NaN);
  const next = calculation?.rows.find(
    (row) => row.date > today && row.scheduledPayment && row.payment > 0,
  );
  const cell = "lg:border-l lg:pl-6";

  return (
    <Card data-testid="loan-summary-header">
      <CardContent className="grid gap-6 p-5 sm:grid-cols-2 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
        <div className="flex items-center gap-4">
          <div className="relative size-20 shrink-0">
            <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
              <circle cx="50" cy="50" r="42" fill="none" stroke="var(--muted)" strokeWidth="8" />
              {!isBalanceHidden && progress != null && (
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke="var(--success)"
                  strokeWidth="8"
                  strokeLinecap="round"
                  pathLength="100"
                  strokeDasharray={`${progress * 100} 100`}
                />
              )}
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
              {isBalanceHidden || progress == null
                ? "••••"
                : numbers.formatPercent(progress, { digits: 1 })}
            </span>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {t("asset:loanOverview.principal_repaid")}
            </p>
            <p className="mt-1 font-semibold tabular-nums">
              {originalAmount == null ? "—" : money(Math.max(0, originalAmount - balance))}
            </p>
            {originalAmount != null && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("asset:loanOverview.of_original", { amount: moneyText(originalAmount) })}
              </p>
            )}
          </div>
        </div>

        {termStart && (
          <div className={cell}>
            <p className="text-muted-foreground text-xs">
              {t("asset:loanEvents.current_term")}
              {Number.isFinite(annualRate) && <> · {rate(annualRate)}</>}
            </p>
            {termEnd ? (
              <TermRuler
                start={termStart}
                end={termEnd}
                renews={!!milestones.maturity}
                today={today}
              />
            ) : (
              <p className="mt-1 font-semibold tabular-nums">{month(termStart)}</p>
            )}
          </div>
        )}

        {calculation && (
          <div className={cell}>
            <p className="text-muted-foreground text-xs">
              {next
                ? `${t("asset:loanOverview.next_payment")} · ${shortDate(next.date)} · ${t(
                    "asset:loanOverview.in_days",
                    { count: differenceInCalendarDays(parseISO(next.date), parseISO(today)) },
                  )}`
                : t("asset:loanOverview.regular_payment")}
            </p>
            <p className="mt-1 font-semibold tabular-nums">
              {money(next?.payment ?? calculation.paymentAmount)}
              <span className="text-muted-foreground text-xs font-normal">
                {" "}
                · {t(`asset:loanActions.${calculation.frequency}`)}
              </span>
            </p>
            {next && (
              <PaymentSplit
                principal={next.principal}
                interest={next.interest}
                currency={currency}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * How the next payment divides between principal and interest. Principal is green,
 * as in the repaid ring beside it; the split is an estimate.
 */
function PaymentSplit({
  principal,
  interest,
  currency,
}: {
  principal: number;
  interest: number;
  currency: string;
}) {
  const { t, numbers, moneyText } = useLoanFormat(currency);
  const total = principal + interest;
  if (!(total > 0)) return null;
  const share = Math.max(0, Math.min(1, principal / total));
  const hint = t("asset:loanOverview.payment_split_hint", {
    percent: numbers.formatPercent(share, { digits: 0 }),
  });
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="img"
            aria-label={hint}
            tabIndex={0}
            className="mt-3 flex h-2.5 cursor-help items-center gap-0.5 outline-none"
          >
            <span className="bg-success h-1 rounded-full" style={{ width: `${share * 100}%` }} />
            <span className="bg-muted-foreground/30 h-1 flex-1 rounded-full" />
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{hint}</TooltipContent>
      </Tooltip>
      <div className="text-muted-foreground mt-1.5 flex flex-wrap justify-between gap-x-3 text-xs tabular-nums">
        <span>{t("asset:loanOverview.principal_amount", { amount: moneyText(principal) })}</span>
        <span>{t("asset:loanOverview.interest_amount", { amount: moneyText(interest) })}</span>
      </div>
    </>
  );
}

/** Renewal prompts turn to warnings this many days before maturity. */
const RENEWAL_SOON_DAYS = 90;

/**
 * Time left in the term, then a timeline with the elapsed part shaded and today
 * marked. Neutral on purpose: green in this strip means principal repaid.
 */
function TermRuler({
  start,
  end,
  renews,
  today,
}: {
  start: string;
  end: string;
  /** The end is a renewal maturity rather than the amortization end. */
  renews: boolean;
  today: string;
}) {
  const { t, duration, date } = useLoanFormat("");
  const startDate = parseISO(start);
  const endDate = parseISO(end);
  const todayDate = parseISO(today);
  const total = Math.max(1, differenceInCalendarDays(endDate, startDate));
  const position = Math.max(0, Math.min(1, differenceInCalendarDays(todayDate, startDate) / total));
  const termMonths = Math.max(1, differenceInCalendarMonths(endDate, startDate));
  // Year boundaries inside the term, as fractions of its length.
  const yearTicks = Array.from(
    { length: Math.floor((termMonths - 1) / 12) },
    (_, index) => ((index + 1) * 12) / termMonths,
  );
  const elapsed = duration(Math.max(0, differenceInMonths(todayDate, startDate)));
  const summary =
    termMonths % 12 === 0
      ? t("asset:loanOverview.term_elapsed_years", { count: termMonths / 12, elapsed })
      : t("asset:loanOverview.term_elapsed_months", { count: termMonths, elapsed });
  const daysLeft = differenceInCalendarDays(endDate, todayDate);
  const ended = daysLeft < 0;
  const warn = renews && daysLeft <= RENEWAL_SOON_DAYS;
  const headline =
    ended && renews
      ? t("asset:loanOverview.renewal_due")
      : renews && daysLeft <= RENEWAL_SOON_DAYS
        ? t("asset:loanOverview.renews_in_days", { count: daysLeft })
        : t("asset:loanOverview.term_left", {
            duration: duration(Math.max(0, differenceInMonths(endDate, todayDate))),
          });
  return (
    <>
      <p className={cn("mt-1 font-semibold tabular-nums", warn && "text-warning")}>{headline}</p>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="img"
            aria-label={summary}
            tabIndex={0}
            className="relative mt-3 h-2.5 cursor-help outline-none"
          >
            <span className="bg-muted absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full" />
            <span
              className="bg-muted-foreground/60 absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
              style={{ width: `${position * 100}%` }}
            />
            {yearTicks.map((tick) => (
              <span
                key={tick}
                className="bg-card absolute top-1/2 h-1.5 w-0.5 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${tick * 100}%` }}
              />
            ))}
            {!ended && (
              <span
                className="bg-foreground absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ left: `${position * 100}%` }}
              />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>{summary}</TooltipContent>
      </Tooltip>
      <div className="text-muted-foreground mt-1.5 flex flex-wrap justify-between gap-x-3 text-xs">
        <span>{t("asset:loanOverview.started_on", { date: date(start) })}</span>
        <span className={cn(warn && "text-warning")}>
          {t(
            ended
              ? "asset:loanOverview.ended_on"
              : renews
                ? "asset:loanOverview.renews_on"
                : "asset:loanOverview.ends_on",
            { date: date(end) },
          )}
        </span>
      </div>
    </>
  );
}

function ThisTermCard({
  calculation,
  metadata,
  currency,
  mortgage,
  onRenew,
  onEdit,
}: {
  calculation: LoanCalculation;
  metadata: Record<string, unknown>;
  currency: string;
  mortgage: boolean;
  onRenew: () => void;
  onEdit: () => void;
}) {
  const { t, numbers, money, duration } = useLoanFormat(currency);
  const today = formatDateISO(new Date());
  const { maturity } = loanMilestones(calculation, metadata, today);
  const renewal = maturity ? getLoanRenewalSummary(calculation, maturity, today) : null;
  const renewalDue =
    !!maturity &&
    differenceInCalendarDays(parseISO(maturity), parseISO(today)) <= RENEWAL_SOON_DAYS;
  return (
    <OverviewCard
      testId="loan-term-card"
      title={t("asset:loanOverview.this_term")}
      aside={<EstimatedLabel hint={t("asset:loanOverview.term_estimate_hint")} />}
    >
      {maturity ? (
        <Rows
          rows={[
            {
              label: t("asset:loanOverview.payments_left"),
              value: renewal ? numbers.formatDecimal(renewal.payments) : "—",
            },
            {
              label: t("asset:loanOverview.principal_to_repay"),
              value: renewal ? money(renewal.principal) : "—",
            },
            {
              label: t("asset:loanOverview.interest_to_pay"),
              value: renewal ? money(renewal.interest) : "—",
            },
            { label: t("asset:loanActions.balance_at_renewal"), value: money(renewal?.balance) },
            {
              label: t("asset:loanOverview.amortization_at_renewal"),
              value:
                renewal?.years != null && renewal.months != null
                  ? duration(renewal.years * 12 + renewal.months)
                  : "—",
            },
          ]}
        />
      ) : (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("asset:loanOverview.next_renewal")}</span>
          <Button variant="link" size="xs" className="h-auto p-0" onClick={onEdit}>
            {t("asset:loanOverview.add_renewal")}
          </Button>
        </div>
      )}
      {renewalDue && (
        <Button variant="outline" size="sm" className="mt-4 w-full rounded-full" onClick={onRenew}>
          {t(mortgage ? "asset:loanOverview.renew_mortgage" : "asset:loanActions.renew_loan")}
        </Button>
      )}
    </OverviewCard>
  );
}

function PayoffCard({
  calculation,
  metadata,
  currency,
}: {
  calculation: LoanCalculation;
  metadata: Record<string, unknown>;
  currency: string;
}) {
  const { t, numbers, money, date, duration } = useLoanFormat(currency);
  const milestones = loanMilestones(calculation, metadata, formatDateISO(new Date()));
  const extraPaid = readLoanEvents(metadata).reduce(
    (sum, event) => (event.type === "extra_repayment" ? sum + event.amount : sum),
    0,
  );
  return (
    <OverviewCard
      testId="loan-payoff-card"
      title={t("asset:loanOverview.payoff")}
      aside={
        <EstimatedLabel
          hint={t("asset:loanOverview.payoff_estimate_hint", {
            date: date(calculation.calculationStartDate),
          })}
        />
      }
    >
      <Rows
        rows={[
          {
            label: t("asset:loanOverview.payoff_date"),
            value: milestones.payoff ? (
              date(milestones.payoff)
            ) : (
              <span className="text-muted-foreground">{t("asset:loanOverview.unavailable")}</span>
            ),
            note:
              milestones.monthsEarly > 0 ? (
                <span className="text-success">
                  {t("asset:loanOverview.early_by", {
                    duration: duration(milestones.monthsEarly),
                  })}
                </span>
              ) : undefined,
          },
          ...(extraPaid > 0
            ? [{ label: t("asset:loanOverview.extra_paid"), value: money(extraPaid) }]
            : []),
          ...(milestones.horizon
            ? [
                {
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {t("asset:loanOverview.original_payoff")}
                      <InfoTip text={t("asset:loanOverview.original_payoff_hint")} />
                    </span>
                  ),
                  value: date(milestones.horizon),
                },
              ]
            : []),
          {
            label: t("asset:loanOverview.payments_left"),
            value: numbers.formatDecimal(calculation.remainingPayments),
          },
          {
            label: t("asset:loanOverview.interest_paid"),
            value: money(calculation.interestToDate),
          },
          {
            label: t("asset:loanOverview.interest_left"),
            value: money(calculation.projectedInterest),
          },
          ...(calculation.residualBalance + calculation.residualInterest > 0
            ? [
                {
                  label: t("asset:loanActions.residual_balance"),
                  value: money(calculation.residualBalance + calculation.residualInterest),
                },
              ]
            : []),
        ]}
      />
    </OverviewCard>
  );
}

function LoanFactsCard({
  metadata,
  currency,
  originalAmount,
  lastConfirmed,
  linkedAsset,
  mortgage,
}: {
  metadata: Record<string, unknown>;
  currency: string;
  originalAmount: number | null;
  lastConfirmed?: string;
  linkedAsset?: AlternativeAssetHolding;
  mortgage: boolean;
}) {
  const { t, money, date, rate } = useLoanFormat(currency);
  const startRate =
    readLoanProjectionMetadata(metadata)?.annualRate ?? Number(metadata.interest_rate);
  const property = linkedAsset?.kind.toLowerCase() === "property" ? linkedAsset : undefined;
  const { data: linkedLoans = [] } = useLinkedLiabilities({
    assetId: property?.id ?? "",
    enabled: !!property,
  });
  // Every loan on the property counts against its equity, as on the property page.
  const securedDebt =
    property &&
    linkedLoans.length &&
    linkedLoans.every((loan) => loan.currency === property.currency)
      ? linkedLoans.reduce((sum, loan) => sum + Math.abs(Number(loan.marketValue)), 0)
      : null;
  return (
    <OverviewCard
      testId="loan-facts-card"
      title={t(
        mortgage ? "asset:loanOverview.mortgage_details" : "asset:loanOverview.loan_details",
      )}
    >
      <Rows
        rows={[
          ...(typeof metadata.origination_date === "string"
            ? [{ label: t("asset:loanOverview.started"), value: date(metadata.origination_date) }]
            : []),
          ...(originalAmount != null
            ? [{ label: t("asset:loanOverview.original_amount"), value: money(originalAmount) }]
            : []),
          ...(Number.isFinite(startRate)
            ? [{ label: t("asset:loanOverview.start_rate"), value: rate(startRate) }]
            : []),
          {
            label: t("asset:loanOverview.last_confirmed"),
            value: lastConfirmed ? date(lastConfirmed) : "—",
          },
        ]}
      />
      {linkedAsset && <LinkedAssetBlock asset={linkedAsset} securedDebt={securedDebt} />}
    </OverviewCard>
  );
}

/** The linked asset, its value and, for a property, the equity left after its loans. */
function LinkedAssetBlock({
  asset,
  securedDebt,
}: {
  asset: AlternativeAssetHolding;
  securedDebt: number | null;
}) {
  const { t, numbers, moneyText } = useLoanFormat(asset.currency);
  const navigate = useNavigate();
  const value = Number(asset.marketValue);
  const vehicle = asset.kind.toLowerCase() === "vehicle";
  const AssetIcon = vehicle ? Icons.VehicleDuotone : Icons.RealEstateDuotone;
  const equity = securedDebt != null && value > 0 ? value - securedDebt : null;
  return (
    <button
      type="button"
      onClick={() => navigate(`/holdings/${encodeURIComponent(asset.id)}`)}
      className="bg-muted/50 hover:bg-muted mt-4 w-full rounded-lg p-3 text-left transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full">
            <AssetIcon size={16} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{asset.name}</p>
            <p className="text-muted-foreground text-xs">
              {t(vehicle ? "asset:linkedLiabilities.vehicle" : "asset:linkedLiabilities.property")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-sm font-medium tabular-nums">
          {moneyText(value)}
          <Icons.ChevronRight className="text-muted-foreground size-4" />
        </div>
      </div>
      {equity != null && securedDebt != null && (
        <>
          <div className="mt-3 flex h-1 gap-0.5" aria-hidden="true">
            <span
              className="bg-success rounded-full"
              style={{ width: `${Math.max(0, Math.min(1, equity / value)) * 100}%` }}
            />
            <span className="bg-muted-foreground/30 flex-1 rounded-full" />
          </div>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap justify-between gap-x-3 text-xs tabular-nums">
            <span className={cn(equity < 0 && "text-destructive")}>
              {t("asset:loanOverview.equity_amount", { amount: moneyText(equity) })}
            </span>
            <span>
              {t("asset:loanOverview.loan_to_value", {
                percent: numbers.formatPercent(securedDebt / value, { digits: 0 }),
              })}
            </span>
          </div>
        </>
      )}
    </button>
  );
}

/** One way to mark a card whose figures are all estimates. */
function EstimatedLabel({ hint }: { hint: string }) {
  const { t } = useTranslation();
  return (
    <>
      <Badge variant="secondary" className="text-xs font-normal normal-case tracking-normal">
        {t("asset:loanOverview.projected")}
      </Badge>
      <InfoTip text={hint} />
    </>
  );
}

function OverviewCard({
  testId,
  title,
  aside,
  children,
}: {
  testId: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col" data-testid={testId} role="region" aria-label={title}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <h3 className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
          {title}
        </h3>
        {aside && <div className="flex items-center gap-1.5">{aside}</div>}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className="text-muted-foreground hover:text-foreground inline-flex"
        >
          <Icons.Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  );
}

interface DetailRow {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
}
function Rows({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="space-y-2 text-sm">
      {rows.map(({ label, value, note }, index) => (
        <div key={index}>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="whitespace-nowrap text-right font-medium tabular-nums">{value}</dd>
          </div>
          {note && <dd className="text-right text-xs">{note}</dd>}
        </div>
      ))}
    </dl>
  );
}
