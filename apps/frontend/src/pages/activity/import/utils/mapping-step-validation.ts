import { shouldResolveImportAsset } from "@/lib/activity-utils";
import { ImportFormat } from "@/lib/constants";
import type { Account, ImportMappingData } from "@/lib/types";

import {
  activityTypeAllowedForImportProfile,
  isTransactionImportProfile,
  mergeActivityMappingsForImportProfile,
  type ActivityImportProfile,
} from "./activity-import-profile";
import { ACTIVITY_SKIP } from "./draft-utils";
import { findMappedActivityType, validateTickerSymbol } from "./validation-utils";

export interface ActivityMappingProceedInput {
  importProfile: ActivityImportProfile;
  mapping: ImportMappingData;
  headers: string[];
  keptRows: string[][];
  accountId: string;
  accounts?: Account[];
}

function headerIndices(mapping: string | string[] | undefined, headers: string[]): number[] {
  if (!mapping) return [];
  return (Array.isArray(mapping) ? mapping : [mapping])
    .map((h) => headers.indexOf(h))
    .filter((i) => i !== -1);
}

function firstNonBlank(row: string[], indices: number[]): string | undefined {
  for (const idx of indices) {
    const value = row[idx]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function canProceedFromActivityMappingStep({
  importProfile,
  mapping,
  headers,
  keptRows,
  accountId,
  accounts,
}: ActivityMappingProceedInput): boolean {
  if (keptRows.length === 0) return false;
  if (!accountId && !mapping.fieldMappings[ImportFormat.ACCOUNT]) {
    return false;
  }

  if (mapping.fieldMappings[ImportFormat.ACCOUNT]) {
    const accountCols = headerIndices(mapping.fieldMappings[ImportFormat.ACCOUNT], headers);
    if (accountCols.length === 0) {
      return false;
    }

    const validAccountIds = new Set((accounts ?? []).map((account) => account.id));
    for (const row of keptRows) {
      const rawAccount = firstNonBlank(row, accountCols);
      if (!rawAccount) {
        if (!accountId && !mapping.accountMappings?.[""]) {
          return false;
        }
        continue;
      }
      if (!validAccountIds.has(rawAccount) && !mapping.accountMappings?.[rawAccount]) {
        return false;
      }
    }
  }

  const requiredFieldsMapped = importProfile.requiredMappingFields.every(
    (field) => headerIndices(mapping.fieldMappings[field], headers).length > 0,
  );
  if (!requiredFieldsMapped) return false;

  const activityTypeMapping = mapping.fieldMappings[ImportFormat.ACTIVITY_TYPE];
  if (activityTypeMapping) {
    const activityMappings = isTransactionImportProfile(importProfile)
      ? mergeActivityMappingsForImportProfile(mapping.activityMappings, importProfile)
      : mapping.activityMappings || {};
    const atIndices = headerIndices(activityTypeMapping, headers);

    if (atIndices.length > 0) {
      const uniqueValues = new Set<string>();
      keptRows.forEach((row) => {
        const value = firstNonBlank(row, atIndices);
        if (value) uniqueValues.add(value);
      });

      for (const value of uniqueValues) {
        const mappedType = findMappedActivityType(value, activityMappings) as string | null;
        if (
          !mappedType ||
          (mappedType !== ACTIVITY_SKIP &&
            !activityTypeAllowedForImportProfile(mappedType, importProfile))
        ) {
          return false;
        }
      }
    }
  }

  if (!importProfile.assetResolutionEnabled) {
    return true;
  }

  const symbolCols = headerIndices(mapping.fieldMappings[ImportFormat.SYMBOL], headers);
  if (symbolCols.length > 0) {
    const atCols = headerIndices(mapping.fieldMappings[ImportFormat.ACTIVITY_TYPE], headers);
    const subtypeCols = headerIndices(mapping.fieldMappings[ImportFormat.SUBTYPE], headers);
    const symbolsNeedingResolution = new Set<string>();

    keptRows.forEach((row) => {
      const symbol = firstNonBlank(row, symbolCols);
      if (!symbol) return;

      const csvActivityType = firstNonBlank(row, atCols);
      const csvSubtype = firstNonBlank(row, subtypeCols);

      if (csvActivityType) {
        const mappedType = findMappedActivityType(csvActivityType, mapping.activityMappings || {});
        if (mappedType && !shouldResolveImportAsset(mappedType, csvSubtype, symbol)) {
          return;
        }
      }

      symbolsNeedingResolution.add(symbol);
    });

    for (const symbol of symbolsNeedingResolution) {
      if (!mapping.symbolMappings?.[symbol] && !validateTickerSymbol(symbol)) {
        return false;
      }
    }
  }

  return true;
}
