import { invoke, logger } from "#platform";
import type { MonthlyReport, ReportRequest } from "../types/report";

export const getSpendingReport = async (request: ReportRequest): Promise<MonthlyReport> => {
  try {
    return await invoke<MonthlyReport>("get_spending_report", { request });
  } catch (e) {
    logger.error("Error fetching spending report.");
    throw e;
  }
};
