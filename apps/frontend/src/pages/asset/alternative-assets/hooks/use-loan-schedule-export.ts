import { useNumberFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openFileSaveDialog } from "@/adapters";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { csvFile, toCsv } from "@/pages/allocation-targets/components/allocation-worksheet-export";
import type { AlternativeAssetHolding } from "@/lib/types";
import { loanScheduleExportRows, loanScheduleFileName } from "../lib/loan-schedule-export";
import { useLoanToday } from "./use-loan-calculation";

/** Saves the loan's calculated schedule as a dated CSV; null while there is none. */
export function useLoanScheduleExport(
  holding: AlternativeAssetHolding | null | undefined,
  calculation: LoanCalculation | null | undefined,
): (() => Promise<void>) | null {
  const { t } = useTranslation();
  // Numbers carry the user's decimal mark, as the worksheet export writes them.
  const { decimalSeparator } = useNumberFormatting();
  const today = useLoanToday();
  if (!holding || !calculation?.rows.length) return null;
  return async () => {
    try {
      const rows = loanScheduleExportRows(
        { name: holding.name, currency: holding.currency, calculation, exportedOn: today },
        {
          title: t("asset:loanExport.title"),
          date: t("asset:loanExport.date"),
          status: t("asset:loanExport.status"),
          statusPast: t("asset:loanExport.status_past"),
          statusProjected: t("asset:loanExport.status_projected"),
          confirmed: t("asset:loanExport.confirmed"),
          scheduledPayment: t("asset:loanExport.scheduled_payment"),
          openingBalance: t("asset:loanExport.opening_balance"),
          payment: t("asset:loanExport.payment"),
          principal: t("asset:loanExport.principal"),
          interest: t("asset:loanExport.interest"),
          extraPayment: t("asset:loanExport.extra_payment"),
          balanceAdjustment: t("asset:loanExport.balance_adjustment"),
          balance: t("asset:loanExport.balance"),
          yes: t("common:yes"),
          no: t("common:no"),
          loan: t("asset:loanExport.loan"),
          exportedOn: t("asset:loanExport.exported_on"),
          currency: t("asset:loanExport.currency"),
          annualRate: t("asset:loanExport.annual_rate"),
          paymentAmount: t("asset:loanExport.payment_amount"),
          payoffDate: t("asset:loanExport.payoff_date"),
          interestToDate: t("asset:loanExport.interest_to_date"),
          projectedInterest: t("asset:loanExport.projected_interest"),
          noteLabel: t("asset:loanExport.note_label"),
          note: t("asset:loanExport.note"),
        },
      );
      // The runtime's own save: a native dialog in the app, a download on the web.
      await openFileSaveDialog(
        csvFile(toCsv(rows, decimalSeparator)),
        loanScheduleFileName(holding.name, today),
      );
    } catch {
      toast.error(t("asset:loanExport.failed"));
    }
  };
}
