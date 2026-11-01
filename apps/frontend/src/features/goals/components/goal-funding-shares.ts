import type { GoalFundingRule } from "@/lib/types";

export const SHARE_EPSILON = 0.01;

/**
 * One account's shares. Savings goals set aside their share; the retirement
 * plan's share is an upper limit on what it counts of what they leave free.
 * Core computes retirement values the same way.
 */
export interface AccountShares {
  /** Shares the other savings goals set aside. */
  otherReserved: number;
  /** What the retirement plan counts of this account. */
  retirementCounted: number;
  /** Set aside by savings goals plus what the retirement plan counts. */
  total: number;
  /** Most this goal may hold. */
  maxForThisGoal: number;
  /** What savings goals can still set aside. */
  left: number;
  /** Counted by no goal. */
  free: number;
  /** Set aside beyond 100%, which blocks a savings goal's save. */
  overBy: number;
}

function sumShares(rules: Pick<GoalFundingRule, "sharePercent">[]): number {
  return rules.reduce((sum, rule) => sum + rule.sharePercent, 0);
}

export function countedRetirementShare(share: number, reserved: number): number {
  return Math.min(share, Math.max(0, 100 - reserved));
}

/**
 * @param thisShare this goal's share of the account
 * @param otherRules the other active goals' shares of the same account
 */
export function computeAccountShares({
  thisShare,
  isRetirement,
  otherRules,
  retirementGoalIds,
}: {
  thisShare: number;
  isRetirement: boolean;
  otherRules: Pick<GoalFundingRule, "goalId" | "sharePercent">[];
  retirementGoalIds: ReadonlySet<string>;
}): AccountShares {
  const otherReserved = sumShares(otherRules.filter((rule) => !retirementGoalIds.has(rule.goalId)));
  const reserved = otherReserved + (isRetirement ? 0 : thisShare);
  const retirementShare = isRetirement
    ? thisShare
    : sumShares(otherRules.filter((rule) => retirementGoalIds.has(rule.goalId)));
  const retirementCounted = countedRetirementShare(retirementShare, reserved);
  const total = reserved + retirementCounted;

  return {
    otherReserved,
    retirementCounted,
    total,
    maxForThisGoal: isRetirement ? 100 : Math.max(0, 100 - otherReserved),
    left: Math.max(0, 100 - reserved),
    free: Math.max(0, 100 - total),
    overBy: isRetirement ? 0 : Math.max(0, reserved - 100),
  };
}
