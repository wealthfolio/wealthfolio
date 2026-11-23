export type BudgetTargetType = "category" | "group_buffer";
export type BudgetRolloverTargetType = "category" | "group";

export interface BudgetGroup {
  id: string;
  name: string;
  key: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewBudgetGroup {
  id?: string;
  name: string;
  key?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
  isSystem?: boolean;
}

export interface UpdateBudgetGroup {
  name?: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
}

export interface BudgetGroupAssignment {
  id: string;
  groupId: string;
  taxonomyId: string;
  categoryId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetTarget {
  id: string;
  periodKey: string;
  targetType: BudgetTargetType;
  taxonomyId: string | null;
  categoryId: string | null;
  groupId: string | null;
  amount: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewBudgetTarget {
  id?: string;
  periodKey: string;
  targetType: BudgetTargetType;
  taxonomyId?: string | null;
  categoryId?: string | null;
  groupId?: string | null;
  amount: string;
}

export interface BudgetRolloverSetting {
  id: string;
  targetType: BudgetRolloverTargetType;
  taxonomyId: string | null;
  categoryId: string | null;
  groupId: string | null;
  enabled: boolean;
  startMonth: string;
  startingBalance: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewBudgetRolloverSetting {
  id?: string;
  targetType: BudgetRolloverTargetType;
  taxonomyId?: string | null;
  categoryId?: string | null;
  groupId?: string | null;
  enabled?: boolean;
  startMonth: string;
  startingBalance: string;
}

export interface BudgetCategoryRow {
  taxonomyId: string;
  categoryId: string;
  groupId: string | null;
  parentId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  target: number;
  actual: number;
  rolloverIn: number;
  rolloverOut: number;
  remaining: number;
  overspent: boolean;
  hasDefaultTarget: boolean;
  hasMonthOverride: boolean;
  rolloverEnabled: boolean;
}

export interface BudgetGroupRow {
  group: BudgetGroup;
  categoryTargetTotal: number;
  buffer: number;
  plannedTotal: number;
  actual: number;
  rolloverIn: number;
  rolloverOut: number;
  remaining: number;
  overspent: boolean;
  rolloverEnabled: boolean;
  /** Savings categories listed in the group: a goal, outside the figures above. */
  savingsTargetTotal: number;
  savingsActual: number;
  categories: BudgetCategoryRow[];
}

/**
 * `spending*` is consumption (expense categories and group buffers), a limit.
 * `savings*` is the savings goal and the money moved to savings. The plan's total
 * allocation, to compare with income, is `spendingPlanned + savingsPlanned`.
 */
export interface BudgetTotals {
  spendingPlanned: number;
  spendingActual: number;
  spendingRemaining: number;
  savingsPlanned: number;
  savingsActual: number;
  incomePlanned: number;
  incomeActual: number;
  groupBuffer: number;
  rolloverIn: number;
  rolloverOut: number;
  overspentCount: number;
}

export interface BudgetSnapshot {
  state: {
    groups: BudgetGroup[];
    groupAssignments: BudgetGroupAssignment[];
    targets: BudgetTarget[];
    rolloverSettings: BudgetRolloverSetting[];
  };
  computed: {
    currency: string;
    periodKey: string;
    fxAsOf: string | null;
    groupRows: BudgetGroupRow[];
    ungroupedRows: BudgetCategoryRow[];
    incomeRows: BudgetCategoryRow[];
    totals: BudgetTotals;
  };
}
