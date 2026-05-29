import { invoke, logger } from "#platform";

import type { SpendingInsight, SpendingInsightRequest } from "../types/insight";

export const getSpendingInsight = async (
  request: SpendingInsightRequest,
): Promise<SpendingInsight> => {
  try {
    return await invoke<SpendingInsight>("get_spending_insight", { request });
  } catch (e) {
    logger.error("Error fetching spending insight.");
    throw e;
  }
};
