import { invoke, logger } from "#platform";
import type { ImportPresetResult, RemovePresetResult, RulePresetSummary } from "../types/rule";

export type { ImportPresetResult, RemovePresetResult, RulePresetSummary } from "../types/rule";

export {
  listCategorizationRules,
  createCategorizationRule,
  updateCategorizationRule,
  deleteCategorizationRule,
  rerunCategorizationRules,
  rerunCategorizationRulesDetailed,
} from "../../../adapters/shared/spending";

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
