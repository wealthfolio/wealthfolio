import { invoke, logger } from "#platform";
import type { CategorizationRule } from "../types/rule";
import type { ApplySuggestionRequest, SuggestedRule } from "../types/suggestion";

export const getSpendingRuleSuggestions = async (): Promise<SuggestedRule[]> => {
  try {
    return await invoke<SuggestedRule[]>("get_spending_rule_suggestions");
  } catch (e) {
    logger.error("Error loading rule suggestions.");
    throw e;
  }
};

export const applySpendingRuleSuggestion = async (
  request: ApplySuggestionRequest,
): Promise<CategorizationRule> => {
  try {
    return await invoke<CategorizationRule>("apply_spending_rule_suggestion", { request });
  } catch (e) {
    logger.error("Error applying rule suggestion.");
    throw e;
  }
};
