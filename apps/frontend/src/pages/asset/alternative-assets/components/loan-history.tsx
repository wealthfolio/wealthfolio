import { useId, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { useTranslation } from "react-i18next";
import { differenceInCalendarDays, parseISO } from "date-fns";
import {
  AmountDisplay,
  AnimatedToggleGroup,
  Badge,
  Button,
  Checkbox,
  Icons,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useDateFormatting,
  useNumberFormatting,
  useAmountFormatting,
} from "@wealthfolio/ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { cn, formatDateISO } from "@/lib/utils";
import {
  readActiveLoanProjection,
  canRenewLoan,
  readLoanEvents,
  type LoanPaymentFrequency,
} from "../lib/loan-events";
import {
  buildLoanLedger,
  groupLoanLedger,
  loanLedgerView,
  type LoanLedgerEntry,
  type LoanLedgerView,
} from "../lib/loan-ledger";
import { loanMilestones } from "../lib/loan-presentation";
import type { LoanActionCallbacks } from "../hooks/use-loan-actions";

// Columns: date, activity, amount, balance (from sm), edit action.
const ROW_GRID =
  "grid grid-cols-[4.5rem_minmax(0,1fr)_auto_2rem] items-center gap-3 px-4 sm:grid-cols-[5.5rem_minmax(0,1fr)_9rem_9rem_2rem] sm:px-6";
// Runs of plain payments longer than this collapse behind a "more payments" row.
const PAYMENT_RUN_LIMIT = 2;

interface LoanHistoryProps {
  holding: AlternativeAssetHolding;
  calculation: LoanCalculation | null;
  quotes: Quote[];
  actions: LoanActionCallbacks;
  onEditDetails: () => void;
}

/** Loan history: the terms over time, then one ledger of payments, events and confirmations. */
export function LoanHistory({
  holding,
  calculation,
  quotes,
  actions,
  onEditDetails,
}: LoanHistoryProps) {
  return (
    <div className="space-y-4">
      <LoanTermsStrip
        holding={holding}
        calculation={calculation}
        onEditTerms={onEditDetails}
        onEditEvent={actions.editEvent}
      />
      <LoanLedger
        holding={holding}
        calculation={calculation}
        quotes={quotes}
        actions={actions}
        onEditDetails={onEditDetails}
      />
    </div>
  );
}

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

function LoanTermsStrip({
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
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const numbers = useNumberFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
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
  const month = (date: string) =>
    dates.formatCalendarDate(date, { month: "short", year: "numeric" });

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
                  {numbers.formatDecimal(term.annualRate, { maximumFractionDigits: 2 })}%
                </Badge>
              </span>
              <span className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                {term.paymentAmount != null && (
                  <>
                    <span>
                      <AmountDisplay
                        value={term.paymentAmount}
                        currency={holding.currency}
                        isHidden={isBalanceHidden}
                      />
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

type LedgerItem = LoanLedgerEntry | { more: string; count: number };

function LoanLedger({ holding, calculation, quotes, actions, onEditDetails }: LoanHistoryProps) {
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const numbers = useNumberFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const today = formatDateISO(new Date());
  const metadata = useMemo(() => holding.metadata ?? {}, [holding.metadata]);
  const [searchParams, setSearchParams] = useSearchParams();
  const view: LoanLedgerView =
    calculation && searchParams.get("schedule") === "upcoming" ? "upcoming" : "past";
  const eventsOnly = searchParams.get("events") === "only";
  const eventsFilterId = useId();
  const updateFilter = (key: string, value: string | null) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };
  const [openYears, setOpenYears] = useState<Record<string, boolean>>({});
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const entries = useMemo(
    () => buildLoanLedger(calculation, quotes, metadata, today),
    [calculation, quotes, metadata, today],
  );
  const years = groupLoanLedger(
    loanLedgerView(entries, view, today).filter((entry) => !eventsOnly || entry.kind !== "payment"),
  );
  const currency = holding.currency;
  const { formatAmount } = useAmountFormatting();
  const money = (value: number) => (
    <AmountDisplay value={value} currency={currency} isHidden={isBalanceHidden} />
  );
  const rate = (value: number) => `${numbers.formatDecimal(value, { maximumFractionDigits: 2 })}%`;
  const day = (date: string) => dates.formatCalendarDate(date, { month: "short", day: "numeric" });

  const withCollapsedRuns = (group: string, list: LoanLedgerEntry[]): LedgerItem[] => {
    const items: LedgerItem[] = [];
    let run: LoanLedgerEntry[] = [];
    const flush = () => {
      const key = `${group}:${run[0]?.date}`;
      if (run.length <= PAYMENT_RUN_LIMIT || openRuns.has(key)) items.push(...run);
      else items.push(run[0], { more: key, count: run.length - 1 });
      run = [];
    };
    for (const entry of list) {
      if (entry.kind === "payment") run.push(entry);
      else {
        flush();
        items.push(entry);
      }
    }
    flush();
    return items;
  };

  const describe = (
    entry: LoanLedgerEntry,
  ): { icon: ReactNode; label: string; detail?: ReactNode; amount?: ReactNode } => {
    const dot = <span className="bg-success size-2 rounded-full" />;
    switch (entry.kind) {
      case "start":
        return {
          icon: <Icons.CalendarDots size={14} />,
          label: t("asset:loanEvents.loan_started"),
          detail: [
            entry.scheduledPayoff &&
              `${t("asset:loanOverview.scheduled_payoff")} ${dates.formatCalendarDate(
                entry.scheduledPayoff,
                { month: "short", day: "numeric", year: "numeric" },
              )}`,
            entry.frequency && t(`asset:loanActions.${entry.frequency}`),
          ]
            .filter(Boolean)
            .join(" · "),
          amount: (
            <>
              {entry.annualRate != null && rate(entry.annualRate)}
              {entry.paymentAmount != null && (
                <span className="text-muted-foreground block text-xs">
                  {money(entry.paymentAmount)}
                </span>
              )}
            </>
          ),
        };
      case "payment":
        return {
          icon: null,
          label: `${t("asset:valueHistory.payment")} · ${t("asset:loanOverview.projected")}`,
          detail: (
            <>
              {t("asset:valueHistory.capital")} {money(entry.principal)} ·{" "}
              {t("asset:valueHistory.interest")} {money(entry.interest)}
            </>
          ),
          amount: money(entry.payment),
        };
      case "maturity":
        return {
          icon: <Icons.LightningDuotone size={14} className="opacity-60" />,
          label: t("asset:loanOverview.next_renewal"),
          detail: t("asset:loanEvents.rate_unknown"),
        };
      case "balance":
        return {
          icon:
            entry.type === "closed" ? (
              <Icons.Lock className="size-3.5" />
            ) : entry.type === "extra_repayment" ? (
              dot
            ) : (
              <Icons.CheckCircle className="size-3.5" />
            ),
          label: t(
            entry.type === "closed"
              ? "asset:loanOverview.event_closed"
              : entry.type === "extra_repayment"
                ? "asset:loanOverview.event_extra_repayment"
                : "asset:loanOverview.event_balance_correction",
          ),
          detail:
            entry.adjustment != null && entry.adjustment !== 0
              ? t("asset:loanInterest.adjustment", {
                  amount: isBalanceHidden ? "••••" : formatAmount(entry.adjustment, currency),
                })
              : entry.quote.notes && !entry.quote.notes.startsWith("loan_")
                ? entry.quote.notes
                : undefined,
        };
      case "event": {
        const { event } = entry;
        const label = t(`asset:loanOverview.event_${event.type}`);
        const note = event.note || undefined;
        switch (event.type) {
          case "renewal":
            return {
              icon: <Icons.LightningDuotone size={14} />,
              label,
              detail: [
                event.termEndDate &&
                  `${t("asset:loanOverview.next_renewal")} ${dates.formatCalendarDate(
                    event.termEndDate,
                    { month: "short", day: "numeric", year: "numeric" },
                  )}`,
                event.frequency && t(`asset:loanActions.${event.frequency}`),
                note,
              ]
                .filter(Boolean)
                .join(" · "),
              amount: (
                <>
                  {rate(event.annualRate)}
                  {event.paymentAmount != null && (
                    <span className="text-muted-foreground block text-xs">
                      {money(event.paymentAmount)}
                    </span>
                  )}
                </>
              ),
            };
          case "extra_repayment":
            return { icon: dot, label, detail: note, amount: money(event.amount) };
          case "rate_change":
            return {
              icon: <Icons.Percent className="size-3.5" />,
              label,
              detail: note,
              amount: rate(event.annualRate),
            };
          case "payment_change":
            return {
              icon: <Icons.DollarSign className="size-3.5" />,
              label,
              detail: note,
              amount: money(event.paymentAmount),
            };
          case "payment_frequency_change":
            return {
              icon: <Icons.Calendar className="size-3.5" />,
              label,
              detail: note,
              amount: t(`asset:loanActions.${event.frequency}`),
            };
        }
      }
    }
  };

  const edit = (entry: LoanLedgerEntry) =>
    entry.kind === "event"
      ? () => actions.editEvent(entry.index)
      : entry.kind === "balance"
        ? () => actions.editBalance(entry.quote)
        : entry.kind === "start"
          ? onEditDetails
          : undefined;

  const views: LoanLedgerView[] = calculation ? ["past", "upcoming"] : ["past"];

  return (
    <Card role="region" aria-label={t("asset:loanEvents.history_title")}>
      <CardHeader className="flex flex-col gap-3 space-y-0 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-lg font-bold">{t("asset:loanEvents.history_title")}</CardTitle>
          {calculation && (
            <CardDescription className="text-xs">
              {t("asset:loanEvents.ledger_hint")}
            </CardDescription>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <AnimatedToggleGroup
            items={views.map((value) => ({
              value,
              label: t(`asset:loanEvents.view_${value}`),
            }))}
            value={view}
            onValueChange={(value) => updateFilter("schedule", value)}
            size="sm"
            variant="default"
            aria-label={t("asset:loanEvents.history_title")}
          />
          <div className="flex min-h-10 items-center gap-2 px-2">
            <Checkbox
              id={eventsFilterId}
              checked={eventsOnly}
              onCheckedChange={(checked) =>
                updateFilter("events", checked === true ? "only" : null)
              }
            />
            <label htmlFor={eventsFilterId} className="cursor-pointer py-2 text-sm font-medium">
              {t("asset:loanEvents.view_events")}
            </label>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                {t("asset:loanEvents.add_event")}
                <Icons.ChevronDown className="ml-2 size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={actions.confirmBalance}>
                {t("asset:loanActions.confirm_balance")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={actions.extraPayment}>
                {t("asset:loanActions.extra_repayment")}
              </DropdownMenuItem>
              {canRenewLoan(metadata) && (
                <DropdownMenuItem onSelect={actions.renew}>
                  {t(
                    (metadata.sub_type ?? metadata.liability_type) === "mortgage"
                      ? "asset:loanOverview.renew_mortgage"
                      : "asset:loanActions.renew_loan",
                  )}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="p-0 text-sm">
        <div className={cn(ROW_GRID, "text-muted-foreground border-t py-2 text-xs")}>
          <span />
          <span />
          <span className="text-right">{t("asset:loanEvents.amount")}</span>
          <span className="hidden text-right sm:block">{t("asset:valueHistory.balance")}</span>
          <span />
        </div>
        {years.length === 0 && (
          <p className="text-muted-foreground border-t px-6 py-6">
            {t("asset:loanEvents.empty_view")}
          </p>
        )}
        {years.map((group, position) => {
          const key = `${view}:${eventsOnly}:${group.year}`;
          const open = openYears[key] ?? (eventsOnly || position === 0);
          return (
            <section key={key} aria-label={group.year}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenYears((current) => ({ ...current, [key]: !open }))}
                className={cn(
                  ROW_GRID,
                  "bg-muted/40 hover:bg-muted/60 w-full border-t py-2.5 text-left",
                )}
              >
                <span className="flex items-center gap-1.5 font-semibold tabular-nums">
                  {open ? (
                    <Icons.ChevronDown className="text-muted-foreground size-4" />
                  ) : (
                    <Icons.ChevronRight className="text-muted-foreground size-4" />
                  )}
                  {group.year}
                </span>
                <span className="text-muted-foreground col-span-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                  {group.paid > 0 && (
                    <>
                      <span>
                        {t("asset:loanEvents.paid")} {money(group.paid)}
                      </span>
                      <span>
                        {t("asset:valueHistory.capital")} {money(group.principal)}
                      </span>
                      <span>
                        {t("asset:valueHistory.interest")} {money(group.interest)}
                      </span>
                    </>
                  )}
                  {group.extra > 0 && (
                    <span className="text-success">
                      {t("asset:loanEvents.extra")} {money(group.extra)}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground hidden text-right text-xs tabular-nums sm:block">
                  {group.endBalance != null && money(group.endBalance)}
                </span>
                <span />
              </button>
              {open &&
                withCollapsedRuns(key, group.entries).map((item) => {
                  if ("more" in item)
                    return (
                      <button
                        key={item.more}
                        type="button"
                        onClick={() => setOpenRuns((current) => new Set(current).add(item.more))}
                        className={cn(
                          ROW_GRID,
                          "text-muted-foreground hover:text-foreground w-full border-t py-2 text-left text-xs",
                        )}
                      >
                        <span />
                        <span className="flex items-center gap-1.5">
                          <Icons.ChevronDown className="size-3.5" />
                          {t("asset:loanEvents.more_payments", { count: item.count })}
                        </span>
                      </button>
                    );
                  const { icon, label, detail, amount } = describe(item);
                  const onEdit = edit(item);
                  return (
                    <div
                      key={`${item.kind}-${item.date}-${"index" in item ? item.index : ""}`}
                      data-testid="loan-ledger-row"
                      data-kind={item.kind}
                      className={cn(
                        ROW_GRID,
                        "border-t py-2.5",
                        item.kind !== "payment" && "bg-muted/20",
                      )}
                    >
                      <span className="text-muted-foreground tabular-nums">{day(item.date)}</span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="text-success flex size-4 shrink-0 items-center justify-center">
                            {icon}
                          </span>
                          <span
                            className={cn(
                              "truncate",
                              item.kind === "payment" ? "text-muted-foreground" : "font-medium",
                            )}
                          >
                            {label}
                          </span>
                        </span>
                        {detail && (
                          <span className="text-muted-foreground block truncate pl-6 text-xs">
                            {detail}
                          </span>
                        )}
                      </span>
                      <span className="text-right tabular-nums">{amount}</span>
                      <span className="hidden text-right tabular-nums sm:block">
                        {item.balance != null && money(item.balance)}
                      </span>
                      <span className="flex justify-end">
                        {onEdit && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t("common:edit")}
                            onClick={onEdit}
                          >
                            <Icons.Pencil className="size-3.5" />
                          </Button>
                        )}
                      </span>
                    </div>
                  );
                })}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
