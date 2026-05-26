import type { Goal, GoalAllocation, AccountValuation, GoalProgress } from './data-types';

function isParticipatingGoal(goal: Goal): boolean {
  if (goal.statusLifecycle) {
    return goal.statusLifecycle === 'active';
  }

  return true;
}

function getFiniteAmount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? amount : undefined;
}

function toFiniteAmount(value: unknown): number {
  return getFiniteAmount(value) ?? 0;
}

/**
 * Calculate goal progress from goal summaries, falling back to allocations.
 */
export function calculateGoalProgress(
  accountsValuations: AccountValuation[],
  goals: Goal[],
  allocations: GoalAllocation[],
): GoalProgress[] {
  if (!goals) {
    return [];
  }

  const baseCurrency = accountsValuations?.[0]?.baseCurrency ?? 'USD';

  // accountId -> totalValue in base currency
  const accountValueMap = new Map<string, number>();
  accountsValuations?.forEach((account) => {
    const valueInBaseCurrency = account.totalValueBase ?? 0;
    accountValueMap.set(account.accountId, valueInBaseCurrency);
  });

  // goalId -> allocations
  const allocationsByGoal = new Map<string, GoalAllocation[]>();
  allocations?.forEach((alloc) => {
    const existing = allocationsByGoal.get(alloc.goalId) ?? [];
    allocationsByGoal.set(alloc.goalId, [...existing, alloc]);
  });

  const sortedGoals = [...goals]
    .filter(isParticipatingGoal)
    .sort(
      (a, b) =>
        toFiniteAmount(a.summaryTargetAmount ?? a.targetAmount) -
        toFiniteAmount(b.summaryTargetAmount ?? b.targetAmount),
    );

  return sortedGoals.map((goal) => {
    const goalAllocations = allocationsByGoal.get(goal.id) ?? [];
    const targetAmount = toFiniteAmount(goal.summaryTargetAmount ?? goal.targetAmount);

    const totalAllocatedValue = goalAllocations.reduce((total, allocation) => {
      const accountValueInBase = accountValueMap.get(allocation.accountId) ?? 0;
      return total + (accountValueInBase * allocation.sharePercent) / 100;
    }, 0);

    const currentValue = getFiniteAmount(goal.summaryCurrentValue) ?? totalAllocatedValue;
    const progress =
      getFiniteAmount(goal.summaryProgress) ??
      (targetAmount > 0 ? currentValue / targetAmount : 0);

    return {
      goalId: goal.id,
      name: goal.title,
      targetValue: targetAmount,
      currentValue,
      progress,
      currency: goal.currency ?? baseCurrency,
      statusHealth: goal.statusHealth,
      targetDate: goal.targetDate,
    };
  });
}
