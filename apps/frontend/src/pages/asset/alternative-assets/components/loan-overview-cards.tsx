import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { Button, Icons, Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { useNavigate } from "react-router-dom";
import { useLinkedLiabilities } from "@/hooks/use-alternative-assets";
import type { AlternativeAssetHolding } from "@/lib/types";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { cn } from "@/lib/utils";
import { RENEWAL_SOON_DAYS, loanMilestones } from "../lib/loan-presentation";
import { readLoanEvents, readLoanProjectionMetadata } from "../lib/loan-events";
import { getLoanRenewalSummary } from "../lib/loan-renewal-summary";
import { useLoanFormat } from "../hooks/use-loan-format";
import { useLoanToday } from "../hooks/use-loan-calculation";

export function ThisTermCard({
  calculation,
  maturity,
  currency,
  mortgage,
  onRenew,
}: {
  calculation: LoanCalculation;
  /** Renewal date ending the current term. */
  maturity: string;
  currency: string;
  mortgage: boolean;
  onRenew: () => void;
}) {
  const { t, numbers, money, duration } = useLoanFormat(currency);
  const today = useLoanToday();
  const renewal = getLoanRenewalSummary(calculation, maturity, today);
  const renewalDue =
    differenceInCalendarDays(parseISO(maturity), parseISO(today)) <= RENEWAL_SOON_DAYS;
  return (
    <OverviewCard
      testId="loan-term-card"
      title={t("asset:loanOverview.this_term")}
      aside={<EstimatedLabel hint={t("asset:loanOverview.term_estimate_hint")} />}
    >
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
      {renewalDue && (
        <Button variant="outline" size="sm" className="mt-4 w-full rounded-full" onClick={onRenew}>
          {t(mortgage ? "asset:loanOverview.renew_mortgage" : "asset:loanActions.renew_loan")}
        </Button>
      )}
    </OverviewCard>
  );
}

export function PayoffCard({
  calculation,
  metadata,
  currency,
}: {
  calculation: LoanCalculation;
  metadata: Record<string, unknown>;
  currency: string;
}) {
  const { t, numbers, money, date, duration } = useLoanFormat(currency);
  const today = useLoanToday();
  const milestones = loanMilestones(calculation, metadata, today);
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
          // Only worth a row once the estimate has moved away from the original date.
          ...(milestones.horizon && milestones.horizon !== milestones.payoff
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

export function LoanFactsCard({
  metadata,
  currency,
  originalAmount,
  lastConfirmed,
  linkedAsset,
  mortgage,
  onAddRenewal,
}: {
  metadata: Record<string, unknown>;
  currency: string;
  originalAmount: number | null;
  lastConfirmed?: string;
  linkedAsset?: AlternativeAssetHolding;
  mortgage: boolean;
  /** Offered while a tracked mortgage has no renewal date. */
  onAddRenewal?: () => void;
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
          ...(onAddRenewal
            ? [
                {
                  label: t("asset:loanOverview.next_renewal"),
                  value: (
                    <Button variant="link" size="xs" className="h-auto p-0" onClick={onAddRenewal}>
                      {t("asset:loanOverview.add_renewal")}
                    </Button>
                  ),
                },
              ]
            : []),
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
