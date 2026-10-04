import { useId, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { AnimatedToggleGroup, Button, Checkbox, Icons } from "@wealthfolio/ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import type { AlternativeAssetHolding, Quote } from "@/lib/types";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { cn } from "@/lib/utils";
import { canRenewLoan } from "../lib/loan-events";
import {
  buildLoanLedger,
  collapsePaymentRuns,
  groupLoanLedger,
  loanLedgerView,
  type LoanLedgerEntry,
  type LoanLedgerView,
} from "../lib/loan-ledger";
import type { LoanActionCallbacks } from "../hooks/use-loan-actions";
import { useLoanFormat } from "../hooks/use-loan-format";
import { LoanTermsStrip } from "./loan-terms-strip";
import { useLoanToday } from "../hooks/use-loan-calculation";

// Columns: date, activity, amount, balance (from sm), edit action.
const ROW_GRID =
  "grid grid-cols-[4.5rem_minmax(0,1fr)_auto_2rem] items-center gap-3 px-4 sm:grid-cols-[5.5rem_minmax(0,1fr)_9rem_9rem_2rem] sm:px-6";

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

function LoanLedger({ holding, calculation, quotes, actions, onEditDetails }: LoanHistoryProps) {
  const { t, money, moneyText, rate, date, shortDate: day } = useLoanFormat(holding.currency);
  const today = useLoanToday();
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
              `${t("asset:loanOverview.scheduled_payoff")} ${date(entry.scheduledPayoff)}`,
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
              ? t("asset:loanInterest.adjustment", { amount: moneyText(entry.adjustment) })
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
                  `${t("asset:loanOverview.next_renewal")} ${date(event.termEndDate)}`,
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
                collapsePaymentRuns(key, group.entries, openRuns).map((item) => {
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
