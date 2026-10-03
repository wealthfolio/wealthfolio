import { differenceInCalendarDays, parseISO } from "date-fns";
import {
  Badge,
  Icons,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useDateFormatting,
} from "@wealthfolio/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import type { AlternativeAssetHolding } from "@/lib/types";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { cn, formatDateISO } from "@/lib/utils";
import {
  readActiveLoanProjection,
  readLoanEvents,
  type LoanPaymentFrequency,
} from "../lib/loan-events";
import { loanMilestones } from "../lib/loan-presentation";
import { useLoanFormat } from "../hooks/use-loan-format";

interface LoanTerm {
  key: string;
  start: string;
  end: string;
  annualRate: number;
  paymentAmount?: number;
  frequency?: LoanPaymentFrequency;
  renewal: boolean;
  onEdit: () => void;
}

/** The original terms and each renewal on one timeline, with the stretch left to renew. */
export function LoanTermsStrip({
  holding,
  calculation,
  onEditTerms,
  onEditEvent,
}: {
  holding: AlternativeAssetHolding;
  calculation: LoanCalculation | null;
  onEditTerms: () => void;
  onEditEvent: (index: number) => void;
}) {
  const { t, money, month, rate } = useLoanFormat(holding.currency);
  const dates = useDateFormatting();
  const metadata = holding.metadata ?? {};
  const projection = readActiveLoanProjection(metadata);
  const origination =
    typeof metadata.origination_date === "string" ? metadata.origination_date : undefined;
  if (!projection || !origination) return null;

  const today = formatDateISO(new Date());
  const milestones = loanMilestones(calculation, metadata, today);
  const finish = milestones.payoff ?? milestones.horizon ?? today;
  const renewals = readLoanEvents(metadata).flatMap((event, index) =>
    event.type === "renewal" ? [{ event, index }] : [],
  );
  const terms: LoanTerm[] = [
    {
      key: "original",
      start: origination,
      end: renewals[0]?.event.effectiveDate ?? milestones.maturity ?? finish,
      annualRate: projection.annualRate,
      paymentAmount: projection.paymentAmount,
      frequency: projection.frequency,
      renewal: false,
      onEdit: onEditTerms,
    },
    ...renewals.map(({ event, index }, position) => ({
      key: `renewal-${index}`,
      start: event.effectiveDate,
      end: renewals[position + 1]?.event.effectiveDate ?? event.termEndDate ?? finish,
      annualRate: event.annualRate,
      paymentAmount: event.paymentAmount,
      frequency: event.frequency,
      renewal: true,
      onEdit: () => onEditEvent(index),
    })),
  ];
  const current = terms.filter((term) => term.start <= today && today < term.end).at(-1)?.key;
  const lastEnd = terms.at(-1)!.end;
  const future = finish > lastEnd ? { start: lastEnd, end: finish } : null;
  const days = (start: string, end: string) =>
    Math.max(1, differenceInCalendarDays(parseISO(end), parseISO(start)));
  const timelineEnd = lastEnd > finish ? lastEnd : finish;
  const duration = days(origination, timelineEnd);
  const position = (date: string) =>
    Math.max(
      0,
      Math.min(
        100,
        (differenceInCalendarDays(parseISO(date), parseISO(origination)) / duration) * 100,
      ),
    );
  const divider = (
    <span aria-hidden="true" className="bg-muted-foreground/70 h-3.5 w-px shrink-0" />
  );
  const todayPosition = position(today);
  const showToday = today >= origination && today <= timelineEnd;

  return (
    <Card data-testid="loan-terms-history" aria-label={t("asset:loanEvents.terms")} role="region">
      <CardHeader className="flex flex-row items-baseline justify-between space-y-0 pb-3">
        <CardTitle className="text-lg font-bold">{t("asset:loanEvents.terms")}</CardTitle>
        <span className="text-muted-foreground text-xs">
          {month(origination)} – {month(timelineEnd)}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative pt-8">
          <div className="bg-muted relative h-2 overflow-hidden rounded-full">
            {terms.map((term) => {
              const elapsed = Math.max(
                0,
                Math.min(
                  100,
                  (differenceInCalendarDays(parseISO(today), parseISO(term.start)) /
                    days(term.start, term.end)) *
                    100,
                ),
              );
              return (
                <div
                  key={term.key}
                  className="bg-success/15 border-background absolute inset-y-0 border-r-2 last:border-r-0"
                  style={{
                    left: `${position(term.start)}%`,
                    width: `${position(term.end) - position(term.start)}%`,
                  }}
                >
                  <div
                    className={cn(
                      "h-full",
                      term.key === current ? "bg-success" : "bg-muted-foreground/40",
                    )}
                    style={{ width: `${elapsed}%` }}
                  />
                </div>
              );
            })}
            {future && (
              <div
                className="border-muted-foreground/40 bg-muted/30 absolute inset-y-0 border border-dashed"
                style={{
                  left: `${position(future.start)}%`,
                  width: `${position(future.end) - position(future.start)}%`,
                }}
              />
            )}
          </div>
          {showToday && (
            <div
              data-testid="loan-term-today"
              className="absolute bottom-0 top-0 w-px"
              style={{ left: `${todayPosition}%` }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "text-success focus-visible:ring-ring absolute whitespace-nowrap rounded-sm text-xs font-medium focus-visible:outline-none focus-visible:ring-2",
                      todayPosition < 20
                        ? "left-0"
                        : todayPosition > 80
                          ? "right-0"
                          : "-translate-x-1/2",
                    )}
                  >
                    {t("asset:loanOverview.today")}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {dates.formatCalendarDate(today, {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                </TooltipContent>
              </Tooltip>
              <span className="bg-success absolute bottom-0 left-0 h-4 w-px -translate-x-1/2" />
              <span className="border-background bg-success absolute -bottom-0.5 left-0 size-3 -translate-x-1/2 rounded-full border-2" />
            </div>
          )}
        </div>
        <div
          className={cn(
            "grid grid-cols-1 gap-3",
            (terms.length > 1 || future) && "sm:grid-cols-2 lg:grid-cols-4",
          )}
        >
          {terms.map((term) => (
            <button
              key={term.key}
              type="button"
              onClick={term.onEdit}
              className="hover:bg-muted/50 -m-1.5 rounded-md p-1.5 text-left transition-colors"
            >
              <span
                className={cn(
                  "flex items-center gap-1.5 text-sm font-medium",
                  term.key === current && "text-success",
                )}
              >
                {term.renewal ? (
                  <Icons.LightningDuotone size={14} />
                ) : (
                  <Icons.CalendarDots size={14} />
                )}
                {t(
                  term.key === current
                    ? "asset:loanEvents.current_term"
                    : term.renewal
                      ? "asset:loanOverview.event_renewal"
                      : "asset:loanEvents.original_terms",
                )}
                <Badge
                  variant="secondary"
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
                    term.key === current
                      ? "bg-success/10 text-success"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {rate(term.annualRate)}
                </Badge>
              </span>
              <span className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                {term.paymentAmount != null && (
                  <>
                    <span>
                      {money(term.paymentAmount)}
                      {term.frequency && ` ${t(`asset:loanActions.${term.frequency}`)}`}
                    </span>
                    {divider}
                  </>
                )}
                <span>
                  {month(term.start)} – {month(term.end)}
                </span>
              </span>
            </button>
          ))}
          {future && (
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 text-sm font-medium">
                {t("asset:loanEvents.after_renewal")}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="focus-visible:ring-ring rounded-sm focus-visible:outline-none focus-visible:ring-2"
                      aria-label={t("asset:loanOverview.forecast_hint")}
                    >
                      <Icons.Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {t("asset:loanEvents.rate_unknown")}. {t("asset:loanOverview.forecast_hint")}
                  </TooltipContent>
                </Tooltip>
              </span>
              <span className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                <span>{t("asset:loanOverview.projected")}</span>
                {divider}
                <span>
                  {month(future.start)} – {month(future.end)}
                </span>
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
