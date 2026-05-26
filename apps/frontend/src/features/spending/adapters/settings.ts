import { invoke, logger } from "#platform";
import type { SpendingSettings, SpendingSettingsUpdate } from "../types";

export const getSpendingSettings = async (): Promise<SpendingSettings> => {
  try {
    return await invoke<SpendingSettings>("get_spending_settings");
  } catch (error) {
    logger.error("Error fetching spending settings.");
    throw error;
  }
};

export const updateSpendingSettings = async (
  update: SpendingSettingsUpdate,
): Promise<SpendingSettings> => {
  try {
    return await invoke<SpendingSettings>("update_spending_settings", { update });
  } catch (error) {
    logger.error("Error updating spending settings.");
    throw error;
  }
};
