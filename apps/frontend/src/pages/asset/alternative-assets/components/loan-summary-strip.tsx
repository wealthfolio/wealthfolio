import {
  differenceInCalendarDays,
  differenceInCalendarMonths,
  differenceInMonths,
  parseISO,
} from "date-fns";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui";
import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { cn } from "@/lib/utils";
import { RENEWAL_SOON_DAYS, loanMilestones } from "../lib/loan-presentation";
import { readLoanEvents } from "../lib/loan-events";
import { useLoanFormat } from "../hooks/use-loan-format";
import { useLoanToday } from "../hooks/use-loan-calculation";

/** Repaid share, the current term and the next payment, above the balance chart. */
export function LoanSummaryStrip({
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
  const today = useLoanToday();
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
              {/* With no renewal before or ahead, the term is the whole loan. */}
              {t(
                currentRenewal || milestones.maturity
                  ? "asset:loanEvents.current_term"
                  : "asset:loanActions.loan_term",
              )}
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
