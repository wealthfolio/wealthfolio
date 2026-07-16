import { invoke, logger } from "#platform";
import type {
  BudgetSnapshot,
  NewBudgetGroup,
  NewBudgetRolloverSetting,
  NewBudgetTarget,
  UpdateBudgetGroup,
} from "../types/budget";

export const getBudget = async (periodKey?: string): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("get_budget", { periodKey });
  } catch (e) {
    logger.error("Error fetching budget.");
    throw e;
  }
};

export const upsertBudgetTarget = async (
  target: NewBudgetTarget,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("upsert_budget_target", { target, periodKey });
  } catch (e) {
    logger.error("Error saving budget target.");
    throw e;
  }
};

export const deleteBudgetTarget = async (
  id: string,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("delete_budget_target", { id, periodKey });
  } catch (e) {
    logger.error("Error deleting budget target.");
    throw e;
  }
};

export const upsertBudgetRolloverSetting = async (
  setting: NewBudgetRolloverSetting,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("upsert_budget_rollover_setting", { setting, periodKey });
  } catch (e) {
    logger.error("Error saving budget rollover setting.");
    throw e;
  }
};

export const deleteBudgetRolloverSetting = async (
  id: string,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("delete_budget_rollover_setting", { id, periodKey });
  } catch (e) {
    logger.error("Error deleting budget rollover setting.");
    throw e;
  }
};

export const createBudgetGroup = async (
  group: NewBudgetGroup,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("create_budget_group", { group, periodKey });
  } catch (e) {
    logger.error("Error creating budget group.");
    throw e;
  }
};

export const updateBudgetGroup = async (
  id: string,
  patch: UpdateBudgetGroup,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("update_budget_group", { id, patch, periodKey });
  } catch (e) {
    logger.error("Error updating budget group.");
    throw e;
  }
};

export const deleteBudgetGroup = async (
  id: string,
  reassignToGroupId: string,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("delete_budget_group", {
      id,
      reassignToGroupId,
      periodKey,
    });
  } catch (e) {
    logger.error("Error deleting budget group.", e);
    throw e;
  }
};

export const assignCategoryToGroup = async (
  categoryId: string,
  groupId: string,
  periodKey?: string,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("assign_category_to_group", {
      categoryId,
      groupId,
      periodKey,
    });
  } catch (e) {
    logger.error("Error assigning category to group.");
    throw e;
  }
};

export const resetBudgetGroups = async (periodKey?: string): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("reset_budget_groups", { periodKey });
  } catch (e) {
    logger.error("Error resetting budget groups.");
    throw e;
  }
};

export const copyBudgetTargets = async (
  sourcePeriodKey: string,
  targetPeriodKey: string,
  overwrite: boolean,
): Promise<BudgetSnapshot> => {
  try {
    return await invoke<BudgetSnapshot>("copy_budget_targets", {
      sourcePeriodKey,
      targetPeriodKey,
      overwrite,
    });
  } catch (e) {
    logger.error("Error copying budget targets.");
    throw e;
  }
};
