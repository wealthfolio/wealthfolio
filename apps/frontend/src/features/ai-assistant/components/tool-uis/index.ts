/**
 * Tool UI Registry
 *
 * Maps tool names to their makeAssistantToolUI components.
 * These are rendered by @assistant-ui/react when the AI calls tools.
 */

import { AccountsToolUI } from "./accounts-tool-ui";
import { ActivitiesToolUI } from "./activities-tool-ui";
import { AllocationToolUI } from "./allocation-tool-ui";
import { CategorizationProposalsToolUI } from "./categorization-proposals-tool-ui";
import { CreateCategorizationRuleToolUI } from "./create-categorization-rule-tool-ui";
import { GoalsToolUI } from "./goals-tool-ui";
import { HoldingsToolUI } from "./holdings-tool-ui";
import { ImportCsvToolUI } from "./import-csv-tool-ui";
import { IncomeToolUI } from "./income-tool-ui";
import { ListCategorizationContextToolUI } from "./list-categorization-context-tool-ui";
import { PerformanceToolUI } from "./performance-tool-ui";
import { RecordActivityToolUI } from "./record-activity-tool-ui";
import { RecordActivitiesToolUI } from "./record-activities-tool-ui";
import { ValuationToolUI } from "./valuation-tool-ui";

/**
 * Registry of tool UIs keyed by tool name.
 * Used by MessagePrimitive.Parts in thread.tsx.
 */
export const toolUIs = {
  get_accounts: AccountsToolUI,
  get_asset_allocation: AllocationToolUI,
  get_goals: GoalsToolUI,
  get_holdings: HoldingsToolUI,
  get_income: IncomeToolUI,
  get_performance: PerformanceToolUI,
  get_valuation_history: ValuationToolUI,
  import_csv: ImportCsvToolUI,
  create_categorization_rule: CreateCategorizationRuleToolUI,
  list_categorization_context: ListCategorizationContextToolUI,
  propose_transaction_categories: CategorizationProposalsToolUI,
  record_activity: RecordActivityToolUI,
  record_activities: RecordActivitiesToolUI,
  search_activities: ActivitiesToolUI,
} as const;

export type ToolUIName = keyof typeof toolUIs;

// Re-export individual components for direct imports if needed
export {
  AccountsToolUI,
  ActivitiesToolUI,
  AllocationToolUI,
  CategorizationProposalsToolUI,
  CreateCategorizationRuleToolUI,
  GoalsToolUI,
  HoldingsToolUI,
  ImportCsvToolUI,
  IncomeToolUI,
  ListCategorizationContextToolUI,
  PerformanceToolUI,
  RecordActivityToolUI,
  RecordActivitiesToolUI,
  ValuationToolUI,
};

// Re-export shared components
export * from "./shared";
