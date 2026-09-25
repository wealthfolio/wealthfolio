import { format } from "date-fns";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Quote } from "@/lib/types";
import { AmountDisplay } from "@wealthfolio/ui";
import { isConfirmedLoanBalance } from "../lib/loan-balance";
import {
  getLoanFrequencyAtDate,
  readLoanEvents,
  type LoanExtraRepaymentEvent,
} from "../lib/loan-events";
import { getRemainingLoanProjection } from "../lib/loan-projection";

interface LoanAmortizationScheduleProps {
  quoteHistory: Quote[];
  metadata: Record<string, unknown>;
  currency: string;
}

export function LoanAmortizationSchedule({
  quoteHistory,
  metadata,
  currency,
}: LoanAmortizationScheduleProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const remaining = getRemainingLoanProjection(metadata, quoteHistory);
    const events = readLoanEvents(metadata);
    const historicalDays = new Set<string>();
    const parsedOriginalAmount = Number(metadata.original_amount ?? metadata.purchase_price);
    let previousBalance =
      Number.isFinite(parsedOriginalAmount) && parsedOriginalAmount > 0
        ? parsedOriginalAmount
        : null;
    const historicalRows = quoteHistory
      .filter((quote) => new Date(quote.timestamp) <= new Date())
      .sort(
        (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
      )
      .map((quote) => {
        const quoteDay = quote.timestamp.slice(0, 10);
        historicalDays.add(quoteDay);
        const extraRepayment = events.find(
          (event): event is LoanExtraRepaymentEvent =>
            event.type === "extra_repayment" && event.effectiveDate === quoteDay,
        );
        const payment = parseNoteNumber(quote.notes, "payment") ?? extraRepayment?.amount ?? null;
        const rate = parseNoteNumber(quote.notes, "rate");
        const openingBalance = previousBalance;
        const frequency = getLoanFrequencyAtDate(metadata, quoteDay);
        const periodsPerYear = frequency === "monthly" ? 12 : 26;
        const interest =
          extraRepayment !== undefined
            ? 0
            : rate !== null && openingBalance !== null
              ? openingBalance * (rate / 100 / periodsPerYear)
              : undefined;
        previousBalance = Math.abs(quote.close);
        return {
          date: new Date(quote.timestamp),
          payment: payment ?? undefined,
          principal:
            extraRepayment !== undefined
              ? extraRepayment.amount
              : payment !== null && interest !== undefined
                ? Math.max(0, payment - interest)
                : undefined,
          interest,
          balance: previousBalance,
          status: isConfirmedLoanBalance(quote) ? "confirmed" : "projected",
        } as const;
      });

    return [
      ...historicalRows,
      ...(remaining?.projection.rows ?? [])
        .filter((row) => !historicalDays.has(format(row.paymentDate, "yyyy-MM-dd")))
        .map((row) => ({
          date: row.paymentDate,
          payment: row.payment,
          principal: row.principal,
          interest: row.interest,
          balance: row.closingBalance,
          status: "projected" as const,
        })),
    ];
  }, [metadata, quoteHistory]);

  if (rows.length === 0) return null;

  return (
    <section className="bg-card overflow-hidden rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="font-semibold">{t("asset:loanActions.amortization_schedule")}</h3>
        <p className="text-muted-foreground text-sm">
          {t("asset:loanActions.amortization_description")}
        </p>
      </div>
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0 z-10">
            <tr className="text-muted-foreground text-left">
              <th className="px-4 py-2">{t("asset:valueHistory.date")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.payment")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.capital")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.interest")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.balance")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.date.toISOString()}-${index}`} className="border-t">
                <td className="px-4 py-2">{format(row.date, "dd/MM/yyyy")}</td>
                <td className="px-4 py-2 text-right">
                  {row.payment === undefined ? (
                    "—"
                  ) : (
                    <AmountDisplay value={row.payment} currency={currency} />
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {row.principal === undefined ? (
                    "—"
                  ) : (
                    <AmountDisplay value={row.principal} currency={currency} />
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {row.interest === undefined ? (
                    "—"
                  ) : (
                    <AmountDisplay value={row.interest} currency={currency} />
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <AmountDisplay value={row.balance} currency={currency} />
                </td>
                <td className="text-muted-foreground px-4 py-2 text-right">
                  {t(`asset:loanActions.status_${row.status}`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function parseNoteNumber(notes: string | null | undefined, key: string): number | null {
  const value = notes?.match(new RegExp(`(?:^|\\|)${key}=([\\d.]+)`))?.[1];
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
