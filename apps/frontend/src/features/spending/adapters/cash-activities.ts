import { invoke, logger } from "#platform";
import type { Activity } from "@/lib/types";

import type {
  ActivityTaxonomyAssignment,
  ActivitySplit,
  CashActivityFilter,
  CashActivitySearchRequest,
  CashActivitySearchResponse,
  CashActivity,
  NewActivitySplit,
} from "../types/cash-activity";

export const listCashActivities = async (filter?: CashActivityFilter): Promise<CashActivity[]> => {
  try {
    return await invoke<CashActivity[]>("list_cash_activities", { filter });
  } catch (error) {
    logger.error("Error listing cash activities.");
    throw error;
  }
};

export const searchCashActivities = async (
  request: CashActivitySearchRequest,
): Promise<CashActivitySearchResponse> => {
  try {
    return await invoke<CashActivitySearchResponse>("search_cash_activities", { request });
  } catch (error) {
    logger.error("Error searching cash activities.");
    throw error;
  }
};

export const getActivityAssignments = async (
  activityId: string,
): Promise<ActivityTaxonomyAssignment[]> => {
  try {
    return await invoke<ActivityTaxonomyAssignment[]>("get_activity_assignments", {
      activityId,
    });
  } catch (error) {
    logger.error("Error fetching activity assignments.");
    throw error;
  }
};

export const assignActivityCategory = async (
  activityId: string,
  taxonomyId: string,
  categoryId: string,
): Promise<ActivityTaxonomyAssignment> => {
  try {
    return await invoke<ActivityTaxonomyAssignment>("assign_activity_category", {
      activityId,
      taxonomyId,
      categoryId,
    });
  } catch (error) {
    logger.error("Error assigning activity category.");
    throw error;
  }
};

export const unassignActivityCategory = async (
  activityId: string,
  taxonomyId: string,
): Promise<void> => {
  try {
    await invoke<void>("unassign_activity_category", { activityId, taxonomyId });
  } catch (error) {
    logger.error("Error clearing activity category.");
    throw error;
  }
};

export const getActivitySplits = async (activityId: string): Promise<ActivitySplit[]> => {
  try {
    return await invoke<ActivitySplit[]>("get_activity_splits", { activityId });
  } catch (error) {
    logger.error("Error fetching activity splits.");
    throw error;
  }
};

export const replaceActivitySplits = async (
  activityId: string,
  splits: NewActivitySplit[],
): Promise<ActivitySplit[]> => {
  try {
    return await invoke<ActivitySplit[]>("replace_activity_splits", { activityId, splits });
  } catch (error) {
    logger.error("Error replacing activity splits.");
    throw error;
  }
};

export const clearActivitySplits = async (activityId: string): Promise<void> => {
  try {
    await invoke<void>("clear_activity_splits", { activityId });
  } catch (error) {
    logger.error("Error clearing activity splits.");
    throw error;
  }
};

export interface BulkCategoryAssignment {
  activityId: string;
  taxonomyId: string;
  categoryId: string;
  /** Explicitly reviewed split state; omit to preserve splits. */
  expectedSplits?: ActivitySplit[];
}

/** Atomic batch — all rows committed in a single DB transaction. */
export const bulkAssignCategories = async (
  items: BulkCategoryAssignment[],
): Promise<ActivityTaxonomyAssignment[]> => {
  try {
    return await invoke<ActivityTaxonomyAssignment[]>("bulk_assign_categories", { items });
  } catch (error) {
    logger.error("Error bulk-assigning categories.");
    throw error;
  }
};

export const setActivityEvent = async (
  activityId: string,
  eventId: string | null,
): Promise<Activity> => {
  try {
    return await invoke<Activity>("set_activity_event", { activityId, eventId });
  } catch (error) {
    logger.error("Error setting activity event.");
    throw error;
  }
};

/** How many transactions are filed under each payee, by payee id. */
export const getPayeeUsage = async (): Promise<Record<string, number>> => {
  try {
    return await invoke<Record<string, number>>("get_payee_usage");
  } catch (error) {
    logger.error("Error counting payee usage.");
    throw error;
  }
};

/** What still points at a payee: it can only be deleted once nothing does. */
export interface PayeeReferences {
  /** Transactions filed under it, on every account, in Spending or not. */
  transactions: number;
  /** Rules that set it. */
  rules: number;
}

export const getPayeeReferences = async (payeeId: string): Promise<PayeeReferences> => {
  try {
    return await invoke<PayeeReferences>("get_payee_references", { payeeId });
  } catch (error) {
    logger.error("Error counting payee references.");
    throw error;
  }
};

/**
 * Files every transaction of one payee under another, on every account, in
 * one write. Returns how many moved.
 */
export const movePayeeActivities = async (
  sourceId: string,
  destinationId: string,
): Promise<number> => {
  try {
    return await invoke<number>("move_payee_activities", { sourceId, destinationId });
  } catch (error) {
    logger.error("Error moving a payee's transactions.");
    throw error;
  }
};
