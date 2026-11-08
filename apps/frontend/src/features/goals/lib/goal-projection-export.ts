import type { RetirementTrajectoryPoint, SaveUpTrajectoryPointDTO } from "@/lib/types";
import type { ExportCell } from "@/pages/allocation-targets/components/allocation-worksheet-export";

/** The goal and the day the projection was exported, written after the table. */
export interface GoalProjectionContext {
  goalName: string;
  currency: string;
  exportedOn: string;
}

/** Texts both projections share, already translated by the caller. */
export interface GoalProjectionContextLabels {
  title: string;
  goal: string;
  exportedOn: string;
  currency: string;
  noteLabel: string;
  note: string;
}

export interface RetirementProjectionExportLabels extends GoalProjectionContextLabels {
  age: string;
  year: string;
  phase: string;
  phaseAccumulation: string;
  phaseRetirement: string;
  portfolioStart: string;
  annualContribution: string;
  annualIncome: string;
  annualExpenses: string;
  plannedExpenses: string;
  fundedExpenses: string;
  annualShortfall: string;
  netWithdrawal: string;
  grossWithdrawal: string;
  annualTaxes: string;
  portfolioEnd: string;
  requiredCapital: string;
  pensionAssets: string;
}

export interface SaveUpProjectionExportLabels extends GoalProjectionContextLabels {
  date: string;
  projected: string;
  optimistic: string;
  pessimistic: string;
  target: string;
  needed: string;
}

const money = (value: number | null | undefined): ExportCell =>
  value === null || value === undefined ? "" : { decimal: value, digits: 2 };

function contextRows(
  { goalName, currency, exportedOn }: GoalProjectionContext,
  labels: GoalProjectionContextLabels,
): ExportCell[][] {
  return [
    [],
    [labels.title],
    [labels.goal, goalName],
    [labels.exportedOn, exportedOn],
    [labels.currency, currency],
    [labels.noteLabel, labels.note],
  ];
}

/**
 * The deterministic year-by-year retirement projection, one row per year, as
 * the backend calculates it: amounts in nominal currency of that year.
 */
export function retirementProjectionExportRows(
  trajectory: readonly RetirementTrajectoryPoint[],
  context: GoalProjectionContext,
  labels: RetirementProjectionExportLabels,
): ExportCell[][] {
  const amount = (label: string) => `${label} (${context.currency})`;
  const rows: ExportCell[][] = [
    [
      labels.age,
      labels.year,
      labels.phase,
      amount(labels.portfolioStart),
      amount(labels.annualContribution),
      amount(labels.annualIncome),
      amount(labels.annualExpenses),
      amount(labels.plannedExpenses),
      amount(labels.fundedExpenses),
      amount(labels.annualShortfall),
      amount(labels.netWithdrawal),
      amount(labels.grossWithdrawal),
      amount(labels.annualTaxes),
      amount(labels.portfolioEnd),
      amount(labels.requiredCapital),
      amount(labels.pensionAssets),
    ],
  ];
  for (const point of trajectory) {
    rows.push([
      point.age,
      point.year,
      point.phase === "fire" ? labels.phaseRetirement : labels.phaseAccumulation,
      money(point.portfolioStart),
      money(point.annualContribution),
      money(point.annualIncome),
      money(point.annualExpenses),
      money(point.plannedExpenses),
      money(point.fundedExpenses),
      money(point.annualShortfall),
      money(point.netWithdrawalFromPortfolio),
      money(point.grossWithdrawal),
      money(point.annualTaxes),
      money(point.portfolioEnd),
      money(point.requiredCapital),
      money(point.pensionAssets),
    ]);
  }
  return [...rows, ...contextRows(context, labels)];
}

/** The save-up projection, one row per point the backend calculates. */
export function saveUpProjectionExportRows(
  trajectory: readonly SaveUpTrajectoryPointDTO[],
  context: GoalProjectionContext,
  labels: SaveUpProjectionExportLabels,
): ExportCell[][] {
  const amount = (label: string) => `${label} (${context.currency})`;
  const rows: ExportCell[][] = [
    [
      labels.date,
      amount(labels.projected),
      amount(labels.optimistic),
      amount(labels.pessimistic),
      amount(labels.target),
      amount(labels.needed),
    ],
  ];
  for (const point of trajectory) {
    rows.push([
      point.date,
      money(point.nominal),
      money(point.optimistic),
      money(point.pessimistic),
      money(point.target),
      money(point.needed),
    ]);
  }
  return [...rows, ...contextRows(context, labels)];
}

/** A name a file system takes, keeping letters of any script. */
function fileSlug(name: string, fallback: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // Hangul syllables come apart above; put them back together.
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || fallback;
}

export function goalProjectionFileName(goalName: string, exportedOn: string): string {
  return `goal-projection_${fileSlug(goalName, "goal")}_${exportedOn}.csv`;
}
