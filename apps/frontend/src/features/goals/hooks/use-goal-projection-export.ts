import { useNumberFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openFileSaveDialog } from "@/adapters";
import type { RetirementTrajectoryPoint, SaveUpTrajectoryPointDTO } from "@/lib/types";
import { csvFile, toCsv } from "@/pages/allocation-targets/components/allocation-worksheet-export";
import {
  goalProjectionFileName,
  retirementProjectionExportRows,
  saveUpProjectionExportRows,
  type GoalProjectionContext,
} from "../lib/goal-projection-export";

/** The goal's deterministic projection, as the goal screen shows it. */
export type GoalProjection =
  | { kind: "retirement"; trajectory: readonly RetirementTrajectoryPoint[] }
  | { kind: "save_up"; trajectory: readonly SaveUpTrajectoryPointDTO[] };

/**
 * Saves the projection as a dated CSV; null while the goal has none. Monte
 * Carlo, stress tests and sensitivity maps are not part of it.
 */
export function useGoalProjectionExport(
  projection: GoalProjection | null,
  context: GoalProjectionContext,
): (() => Promise<void>) | null {
  const { t } = useTranslation();
  // Numbers carry the user's decimal mark, as the worksheet export writes them.
  const { decimalSeparator } = useNumberFormatting();
  if (!projection?.trajectory.length) return null;
  return async () => {
    try {
      const shared = {
        goal: t("goals:export.goal"),
        exportedOn: t("goals:export.exported_on"),
        currency: t("goals:export.currency"),
        noteLabel: t("goals:export.note_label"),
      };
      const rows =
        projection.kind === "retirement"
          ? retirementProjectionExportRows(projection.trajectory, context, {
              ...shared,
              title: t("goals:export.retirement_title"),
              note: t("goals:export.retirement_note"),
              age: t("goals:export.age"),
              year: t("goals:export.year"),
              phase: t("goals:export.phase"),
              phaseAccumulation: t("goals:export.phase_accumulation"),
              phaseRetirement: t("goals:export.phase_retirement"),
              portfolioStart: t("goals:export.portfolio_start"),
              annualContribution: t("goals:export.annual_contribution"),
              annualIncome: t("goals:export.annual_income"),
              annualExpenses: t("goals:export.annual_expenses"),
              plannedExpenses: t("goals:export.planned_expenses"),
              fundedExpenses: t("goals:export.funded_expenses"),
              annualShortfall: t("goals:export.annual_shortfall"),
              netWithdrawal: t("goals:export.net_withdrawal"),
              grossWithdrawal: t("goals:export.gross_withdrawal"),
              annualTaxes: t("goals:export.annual_taxes"),
              portfolioEnd: t("goals:export.portfolio_end"),
              requiredCapital: t("goals:export.required_capital"),
              pensionAssets: t("goals:export.pension_assets"),
            })
          : saveUpProjectionExportRows(projection.trajectory, context, {
              ...shared,
              title: t("goals:export.save_up_title"),
              note: t("goals:export.save_up_note"),
              date: t("goals:export.date"),
              projected: t("goals:export.projected"),
              optimistic: t("goals:export.optimistic"),
              pessimistic: t("goals:export.pessimistic"),
              target: t("goals:export.target"),
              needed: t("goals:export.needed"),
            });
      // The runtime's own save: a native dialog in the app, a download on the web.
      await openFileSaveDialog(
        csvFile(toCsv(rows, decimalSeparator)),
        goalProjectionFileName(context.goalName, context.exportedOn),
      );
    } catch {
      toast.error(t("goals:export.failed"));
    }
  };
}
