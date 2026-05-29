import type { ImportMappingData, ImportTemplateData } from "@/lib/types";
import { ImportType } from "@/lib/types";
import type { ParseConfig } from "../context";
import {
  DEFAULT_ACTIVITY_IMPORT_PROFILE,
  getDefaultActivityMappingsForImportProfile,
  type ActivityImportProfile,
} from "./activity-import-profile";

export const DEFAULT_ACTIVITY_TEMPLATE_ID = "system_default_activity";

export function createDefaultParseConfig(defaultCurrency = "USD"): ParseConfig {
  return {
    hasHeaderRow: true,
    headerRowIndex: 0,
    delimiter: "auto",
    skipTopRows: 0,
    skipBottomRows: 0,
    skipEmptyRows: true,
    dateFormat: "auto",
    decimalSeparator: "auto",
    thousandsSeparator: "auto",
    defaultCurrency,
  };
}

export function createDefaultActivityTemplate(
  profile: ActivityImportProfile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): ImportTemplateData {
  return {
    id: DEFAULT_ACTIVITY_TEMPLATE_ID,
    name: "Default",
    scope: "SYSTEM",
    kind: ImportType.ACTIVITY,
    fieldMappings: {},
    activityMappings: getDefaultActivityMappingsForImportProfile(profile),
    symbolMappings: {},
    accountMappings: {},
    symbolMappingMeta: {},
  };
}

export function createDefaultActivityMapping(
  accountId = "",
  profile: ActivityImportProfile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): ImportMappingData {
  return {
    accountId,
    importType: ImportType.ACTIVITY,
    name: "",
    fieldMappings: {},
    activityMappings: createDefaultActivityTemplate(profile).activityMappings,
    symbolMappings: {},
    accountMappings: {},
    symbolMappingMeta: {},
  };
}

export function createEmptyHoldingsMapping(accountId = ""): ImportMappingData {
  return {
    accountId,
    importType: ImportType.HOLDINGS,
    name: "",
    fieldMappings: {},
    activityMappings: {},
    symbolMappings: {},
    accountMappings: {},
    symbolMappingMeta: {},
  };
}

export function prependDefaultActivityTemplate(
  templates: ImportTemplateData[],
  profile: ActivityImportProfile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): ImportTemplateData[] {
  return [
    createDefaultActivityTemplate(profile),
    ...templates.filter((template) => template.id !== DEFAULT_ACTIVITY_TEMPLATE_ID),
  ];
}

export function isDefaultActivityTemplateId(templateId: string | null): boolean {
  return templateId === DEFAULT_ACTIVITY_TEMPLATE_ID;
}
