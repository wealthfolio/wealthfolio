import { invoke, logger } from "#platform";
import type {
  CategorizationRule,
  ImportPresetResult,
  NewCategorizationRule,
  RemovePresetResult,
  RulePresetSummary,
  UpdateCategorizationRule,
} from "../types/rule";

export type { ImportPresetResult, RemovePresetResult, RulePresetSummary } from "../types/rule";

export const listCategorizationRules = async (): Promise<CategorizationRule[]> => {
  try {
    return await invoke<CategorizationRule[]>("list_categorization_rules");
  } catch (e) {
    logger.error("Error listing activity rules.");
    throw e;
  }
};

export const createCategorizationRule = async (
  rule: NewCategorizationRule,
): Promise<CategorizationRule> => {
  try {
    return await invoke<CategorizationRule>("create_categorization_rule", { rule });
  } catch (e) {
    logger.error("Error creating activity rule.");
    throw e;
  }
};

export const updateCategorizationRule = async (
  id: string,
  patch: UpdateCategorizationRule,
): Promise<CategorizationRule> => {
  try {
    return await invoke<CategorizationRule>("update_categorization_rule", { id, patch });
  } catch (e) {
    logger.error("Error updating activity rule.");
    throw e;
  }
};

export const deleteCategorizationRule = async (id: string): Promise<void> => {
  try {
    await invoke<void>("delete_categorization_rule", { id });
  } catch (e) {
    logger.error("Error deleting activity rule.");
    throw e;
  }
};

export const rerunCategorizationRules = async (onlyUncategorized: boolean): Promise<number> => {
  try {
    return await invoke<number>("rerun_categorization_rules", { onlyUncategorized });
  } catch (e) {
    logger.error("Error re-running activity rules.");
    throw e;
  }
};

export const listRulePresets = async (): Promise<RulePresetSummary[]> => {
  try {
    return await invoke<RulePresetSummary[]>("list_rule_presets");
  } catch (e) {
    logger.error("Error listing rule presets.");
    throw e;
  }
};

export const importRulePreset = async (presetId: string): Promise<ImportPresetResult> => {
  try {
    return await invoke<ImportPresetResult>("import_rule_preset", { presetId });
  } catch (e) {
    logger.error("Error importing rule preset.");
    throw e;
  }
};

export const removeRulePreset = async (presetId: string): Promise<RemovePresetResult> => {
  try {
    return await invoke<RemovePresetResult>("remove_rule_preset", { presetId });
  } catch (e) {
    logger.error("Error removing rule preset.");
    throw e;
  }
};
