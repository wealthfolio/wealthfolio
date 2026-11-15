import type { BudgetSnapshot } from "@/features/spending/types/budget";
import type { CashActivity } from "@/features/spending/types/cash-activity";
import type {
  EventSpendingSummary,
  EventType,
  SpendingEvent,
} from "@/features/spending/types/event";
import type { SpendingInsight } from "@/features/spending/types/insight";
import type { MonthlyReport } from "@/features/spending/types/report";
import type { CalculationQuality, SpendingToolContext } from "./spending-card-shared";

/** Results of the assistant's Spending read tools (`crates/agent-tools/src/tools/spending_reads.rs`). */

export type GetSpendingContextOutput = SpendingToolContext;

export interface ListSpendingEventsOutput {
  events: SpendingEvent[];
  eventTypes: EventType[];
}

export interface SpendingInsightOutput {
  context: SpendingToolContext;
  insight: SpendingInsight & { calculationQuality?: CalculationQuality };
}

export interface SpendingReportOutput {
  context: SpendingToolContext;
  period: { startDate: string; endDate: string; currency: string };
  report: MonthlyReport & {
    current: MonthlyReport["current"] & { calculationQuality?: CalculationQuality };
  };
}

/** Category allocation of one transaction; `amount` is a decimal string. */
export interface EffectiveCategoryAllocation {
  taxonomyId: string;
  categoryId: string;
  amount: string;
}

export interface SpendingTransaction extends CashActivity {
  effectiveAllocations: EffectiveCategoryAllocation[];
  hasHiddenAssignment: boolean;
}

export interface SearchSpendingTransactionsOutput {
  context: SpendingToolContext;
  items: SpendingTransaction[];
  totalCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface GetBudgetOutput {
  context: SpendingToolContext;
  budget: BudgetSnapshot & {
    computed: BudgetSnapshot["computed"] & { calculationQuality?: CalculationQuality };
  };
}

export interface EventSpendingSummariesOutput {
  context: SpendingToolContext;
  period: { startDate?: string | null; endDate?: string | null; currency: string };
  summaries: (EventSpendingSummary & { calculationQuality?: CalculationQuality })[];
}
