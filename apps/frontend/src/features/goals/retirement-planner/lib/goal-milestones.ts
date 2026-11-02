import type { Goal, GoalHealth, GoalType } from "@/lib/types";

/** A savings goal shown on the retirement chart at its target date. */
export interface GoalMilestone {
  id: string;
  title: string;
  goalType: GoalType;
  targetAmount: number | null;
  targetDate: string;
  statusHealth: GoalHealth;
  /** The planner's age when the target date arrives. */
  age: number;
}

/** Age on a calendar date, from the plan's birth year and month. */
export function ageAtDate(birthYearMonth: string, date: string): number | undefined {
  const [birthYear, birthMonth] = birthYearMonth.split("-").map(Number);
  const [year, month] = date.slice(0, 10).split("-").map(Number);
  if (![birthYear, birthMonth, year, month].every(Number.isInteger)) return undefined;
  if (birthMonth < 1 || birthMonth > 12 || month < 1 || month > 12) return undefined;
  const age = year - birthYear - (month < birthMonth ? 1 : 0);
  return age >= 0 ? age : undefined;
}

/**
 * Active savings goals with a target date inside the chart's age range,
 * in date order. Status comes from core; the retirement goal is the chart itself.
 */
export function buildGoalMilestones(
  goals: Goal[],
  {
    birthYearMonth,
    startAge,
    endAge,
  }: { birthYearMonth: string; startAge: number; endAge: number },
): GoalMilestone[] {
  return goals
    .filter((goal) => goal.statusLifecycle === "active" && goal.goalType !== "retirement")
    .flatMap((goal) => {
      if (!goal.targetDate) return [];
      const age = ageAtDate(birthYearMonth, goal.targetDate);
      if (age === undefined || age < startAge || age > endAge) return [];
      return [
        {
          id: goal.id,
          title: goal.title,
          goalType: goal.goalType,
          targetAmount: goal.summaryTargetAmount ?? goal.targetAmount ?? null,
          targetDate: goal.targetDate,
          statusHealth: goal.statusHealth,
          age,
        },
      ];
    })
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate));
}
