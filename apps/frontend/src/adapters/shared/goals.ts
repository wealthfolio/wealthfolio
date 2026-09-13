// Goal Commands
import type {
  Goal,
  GoalFundingRule,
  GoalFundingRuleInput,
  GoalPlan,
  NewGoal,
  RetirementOverview,
  SaveGoalPlan,
  SaveUpOverviewDTO,
  SaveUpPreviewInputDTO,
} from "@/lib/types";

import { invoke, logger } from "./platform";

export const getGoals = async (): Promise<Goal[]> => {
  try {
    return await invoke<Goal[]>("get_goals");
  } catch (error) {
    logger.error("Error fetching goals.");
    throw error;
  }
};

export const getGoal = async (goalId: string): Promise<Goal> => {
  try {
    return await invoke<Goal>("get_goal", { goalId });
  } catch (error) {
    logger.error("Error fetching goal.");
    throw error;
  }
};

export const createGoal = async (goal: NewGoal): Promise<Goal> => {
  try {
    return await invoke<Goal>("create_goal", { goal });
  } catch (error) {
    logger.error("Error creating goal.");
    throw error;
  }
};

export const updateGoal = async (goal: Goal): Promise<Goal> => {
  try {
    return await invoke<Goal>("update_goal", { goal });
  } catch (error) {
    logger.error("Error updating goal.");
    throw error;
  }
};

export const deleteGoal = async (goalId: string): Promise<void> => {
  try {
    await invoke<void>("delete_goal", { goalId });
  } catch (error) {
    logger.error("Error deleting goal.");
    throw error;
  }
};

export const setGoalCoverImage = async (
  goalId: string,
  contentBase64: string,
  fileExtension: string,
): Promise<Goal> => {
  try {
    return await invoke<Goal>("save_goal_cover_image", { goalId, contentBase64, fileExtension });
  } catch (error) {
    logger.error("Error saving goal cover image.");
    throw error;
  }
};

export const removeGoalCoverImage = async (goalId: string): Promise<Goal> => {
  try {
    return await invoke<Goal>("remove_goal_cover_image", { goalId });
  } catch (error) {
    logger.error("Error removing goal cover image.");
    throw error;
  }
};

export const getGoalFunding = async (goalId: string): Promise<GoalFundingRule[]> => {
  try {
    return await invoke<GoalFundingRule[]>("get_goal_funding", { goalId });
  } catch (error) {
    logger.error("Error fetching goal funding.");
    throw error;
  }
};

export const saveGoalFunding = async (
  goalId: string,
  rules: GoalFundingRuleInput[],
): Promise<GoalFundingRule[]> => {
  try {
    return await invoke<GoalFundingRule[]>("save_goal_funding", { goalId, rules });
  } catch (error) {
    logger.error("Error saving goal funding.");
    throw error;
  }
};

export const getGoalPlan = async (goalId: string): Promise<GoalPlan | null> => {
  try {
    return await invoke<GoalPlan | null>("get_goal_plan", { goalId });
  } catch (error) {
    logger.error("Error fetching goal plan.");
    throw error;
  }
};

export const saveGoalPlan = async (plan: SaveGoalPlan): Promise<GoalPlan> => {
  try {
    return await invoke<GoalPlan>("save_goal_plan", { plan });
  } catch (error) {
    logger.error("Error saving goal plan.");
    throw error;
  }
};

export const deleteGoalPlan = async (goalId: string): Promise<void> => {
  try {
    await invoke<void>("delete_goal_plan", { goalId });
  } catch (error) {
    logger.error("Error deleting goal plan.");
    throw error;
  }
};

export const refreshAllGoalSummaries = async (): Promise<Goal[]> => {
  try {
    return await invoke<Goal[]>("refresh_all_goal_summaries");
  } catch (error) {
    logger.error("Error refreshing all goal summaries.");
    throw error;
  }
};

export const refreshGoalSummary = async (goalId: string): Promise<Goal> => {
  try {
    return await invoke<Goal>("refresh_goal_summary", { goalId });
  } catch (error) {
    logger.error("Error refreshing goal summary.");
    throw error;
  }
};

export const getRetirementOverview = async (goalId: string): Promise<RetirementOverview> => {
  try {
    return await invoke<RetirementOverview>("get_retirement_overview", { goalId });
  } catch (error) {
    logger.error("Error fetching retirement overview.");
    throw error;
  }
};

export const getSaveUpOverview = async (goalId: string): Promise<SaveUpOverviewDTO> => {
  try {
    return await invoke<SaveUpOverviewDTO>("get_save_up_overview", { goalId });
  } catch (error) {
    logger.error("Error fetching save-up overview.");
    throw error;
  }
};

export const previewSaveUpOverview = async (
  input: SaveUpPreviewInputDTO,
): Promise<SaveUpOverviewDTO> => {
  try {
    return await invoke<SaveUpOverviewDTO>("preview_save_up_overview", { input });
  } catch (error) {
    logger.error("Error previewing save-up overview.");
    throw error;
  }
};
