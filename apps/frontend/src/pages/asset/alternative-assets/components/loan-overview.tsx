import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { cn } from "@/lib/utils";
import { LoanTimeline } from "./loan-timeline";
import { LoanSummaryStrip } from "./loan-summary-strip";
import { LoanFactsCard, PayoffCard, ThisTermCard } from "./loan-overview-cards";
import { lastLoanConfirmation, loanDisplayBalance, loanMilestones } from "../lib/loan-presentation";
import type { LoanActionCallbacks } from "../hooks/use-loan-actions";
import { useLoanToday } from "../hooks/use-loan-calculation";

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
  const today = useLoanToday();
  const metadata = holding.metadata ?? {};
  const confirmed = lastLoanConfirmation(quotes, today);
  const balance = loanDisplayBalance(calculation, holding.marketValue);
  const original = Number(metadata.original_amount ?? metadata.purchase_price);
  const originalAmount = Number.isFinite(original) && original > 0 ? original : null;
  const lastConfirmed = confirmed?.timestamp.slice(0, 10);
  const milestones = loanMilestones(calculation, metadata, today);
  // Without a renewal date the term is the whole loan, which the strip already shows.
  const maturity = calculation ? milestones.maturity : undefined;
  const cards = 1 + (maturity ? 1 : 0) + (calculation ? 1 : 0);
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
        {calculation && maturity && (
          <ThisTermCard
            calculation={calculation}
            maturity={maturity}
            currency={holding.currency}
            mortgage={mortgage}
            onRenew={actions.renew}
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
          onAddRenewal={mortgage && calculation && !milestones.maturity ? onEdit : undefined}
        />
      </div>
    </div>
  );
}
