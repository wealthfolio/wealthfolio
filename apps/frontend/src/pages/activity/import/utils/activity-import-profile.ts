import type { TFunction } from "i18next";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import {
  AccountType,
  ActivityType,
  ActivityTypeNames,
  IMPORT_REQUIRED_FIELDS,
  ImportFormat,
} from "@/lib/constants";
import type { Account, ImportMappingData } from "@/lib/types";

const ACTIVITY_SKIP = "_SKIP_";

export type ActivityImportProfileKind = "investment" | "transaction";

export type ImportReviewColumnId =
  | "activityDate"
  | "accountId"
  | "activityType"
  | "subtype"
  | "isExternal"
  | "symbol"
  | "instrumentType"
  | "quantity"
  | "unitPrice"
  | "amount"
  | "currency"
  | "fee"
  | "tax"
  | "fxRate"
  | "comment";

export interface ActivityImportProfile {
  kind: ActivityImportProfileKind;
  label: string;
  visibleMappingFields: readonly ImportFormat[];
  requiredMappingFields: readonly ImportFormat[];
  assetResolutionEnabled: boolean;
  allowedActivityTypes: readonly ActivityType[];
  activityTypeLabels?: Partial<Record<ActivityType, string>>;
  reviewColumns: readonly ImportReviewColumnId[];
}

type AccountProfileOption = { id: string; accountType?: string | null };

const IMPORTABLE_ACTIVITY_TYPES = Object.values(ActivityType).filter(
  (type): type is ActivityType => type !== ActivityType.UNKNOWN,
);

const CASH_ACTIVITY_TYPES = [
  ActivityType.DEPOSIT,
  ActivityType.WITHDRAWAL,
  ActivityType.TRANSFER_IN,
  ActivityType.TRANSFER_OUT,
  ActivityType.INTEREST,
  ActivityType.FEE,
  ActivityType.TAX,
  ActivityType.CREDIT,
] as const;

const CREDIT_CARD_ACTIVITY_TYPES = [
  ActivityType.WITHDRAWAL,
  ActivityType.TRANSFER_IN,
  ActivityType.CREDIT,
  ActivityType.FEE,
  ActivityType.INTEREST,
] as const;

const ALL_MAPPING_FIELDS = Object.values(ImportFormat);

const TRANSACTION_MAPPING_FIELDS = [
  ImportFormat.DATE,
  ImportFormat.ACCOUNT,
  ImportFormat.ACTIVITY_TYPE,
  ImportFormat.AMOUNT,
  ImportFormat.CURRENCY,
  ImportFormat.FEE,
  ImportFormat.TAX,
  ImportFormat.COMMENT,
  ImportFormat.FX_RATE,
  ImportFormat.SUBTYPE,
] as const;

const INVESTMENT_REVIEW_COLUMNS = [
  "activityDate",
  "accountId",
  "activityType",
  "subtype",
  "isExternal",
  "symbol",
  "instrumentType",
  "quantity",
  "unitPrice",
  "amount",
  "currency",
  "fee",
  "tax",
  "fxRate",
  "comment",
] as const satisfies readonly ImportReviewColumnId[];

const TRANSACTION_REVIEW_COLUMNS = [
  "activityDate",
  "accountId",
  "activityType",
  "subtype",
  "isExternal",
  "amount",
  "currency",
  "fee",
  "tax",
  "fxRate",
  "comment",
] as const satisfies readonly ImportReviewColumnId[];

export const DEFAULT_ACTIVITY_IMPORT_PROFILE: ActivityImportProfile = {
  kind: "investment",
  label: "Activity",
  visibleMappingFields: ALL_MAPPING_FIELDS,
  requiredMappingFields: IMPORT_REQUIRED_FIELDS,
  assetResolutionEnabled: true,
  allowedActivityTypes: IMPORTABLE_ACTIVITY_TYPES,
  reviewColumns: INVESTMENT_REVIEW_COLUMNS,
};

export const CASH_TRANSACTION_IMPORT_PROFILE: ActivityImportProfile = {
  kind: "transaction",
  label: "Transaction",
  visibleMappingFields: TRANSACTION_MAPPING_FIELDS,
  requiredMappingFields: [ImportFormat.DATE, ImportFormat.ACTIVITY_TYPE, ImportFormat.AMOUNT],
  assetResolutionEnabled: false,
  allowedActivityTypes: CASH_ACTIVITY_TYPES,
  reviewColumns: TRANSACTION_REVIEW_COLUMNS,
};

export const CREDIT_CARD_TRANSACTION_IMPORT_PROFILE: ActivityImportProfile = {
  ...CASH_TRANSACTION_IMPORT_PROFILE,
  allowedActivityTypes: CREDIT_CARD_ACTIVITY_TYPES,
  activityTypeLabels: {
    [ActivityType.WITHDRAWAL]: "Charge",
    [ActivityType.TRANSFER_IN]: "Payment",
    [ActivityType.CREDIT]: "Refund / Credit",
    [ActivityType.INTEREST]: "Interest Charge",
  },
};

export function getActivityImportProfileForAccountType(
  accountType: string | null | undefined,
): ActivityImportProfile {
  if (accountType === AccountType.CREDIT_CARD) return CREDIT_CARD_TRANSACTION_IMPORT_PROFILE;
  if (accountType === AccountType.CASH) return CASH_TRANSACTION_IMPORT_PROFILE;
  return DEFAULT_ACTIVITY_IMPORT_PROFILE;
}

export function getActivityImportProfile(
  account?: Pick<Account, "accountType"> | null,
): ActivityImportProfile {
  return getActivityImportProfileForAccountType(account?.accountType);
}

export function getActivityImportProfileForResolvedAccountIds(
  accounts: readonly AccountProfileOption[] | undefined,
  accountIds: Iterable<string>,
): ActivityImportProfile {
  const accountById = new Map((accounts ?? []).map((account) => [account.id, account]));
  const accountTypes = Array.from(accountIds)
    .map((accountId) => accountById.get(accountId)?.accountType)
    .filter((accountType): accountType is string => Boolean(accountType));

  if (accountTypes.length === 0) return DEFAULT_ACTIVITY_IMPORT_PROFILE;

  const allTransactionAccounts = accountTypes.every(
    (accountType) => accountType === AccountType.CASH || accountType === AccountType.CREDIT_CARD,
  );
  if (!allTransactionAccounts) return DEFAULT_ACTIVITY_IMPORT_PROFILE;

  const allCreditCardAccounts = accountTypes.every(
    (accountType) => accountType === AccountType.CREDIT_CARD,
  );
  return allCreditCardAccounts
    ? CREDIT_CARD_TRANSACTION_IMPORT_PROFILE
    : CASH_TRANSACTION_IMPORT_PROFILE;
}

function getMappedAccountColumnValue(
  row: readonly string[],
  headers: readonly string[],
  accountFieldMapping: string | string[] | undefined,
): string {
  if (!accountFieldMapping) return "";
  const mappedHeaders = Array.isArray(accountFieldMapping)
    ? accountFieldMapping
    : [accountFieldMapping];
  for (const mappedHeader of mappedHeaders) {
    const idx = headers.indexOf(mappedHeader);
    if (idx === -1) continue;
    const value = row[idx]?.trim();
    if (value) return value;
  }
  return "";
}

export function getActivityImportProfileForImportContext({
  defaultAccountId,
  accounts,
  headers = [],
  parsedRows = [],
  fieldMappings,
  accountMappings = {},
}: {
  defaultAccountId?: string | null;
  accounts?: readonly AccountProfileOption[];
  headers?: readonly string[];
  parsedRows?: readonly string[][];
  fieldMappings?: ImportMappingData["fieldMappings"];
  accountMappings?: ImportMappingData["accountMappings"];
}): ActivityImportProfile {
  const accountById = new Map((accounts ?? []).map((account) => [account.id, account]));
  const selectedAccount = defaultAccountId ? accountById.get(defaultAccountId) : undefined;
  if (selectedAccount) return getActivityImportProfileForAccountType(selectedAccount.accountType);

  const accountFieldMapping = fieldMappings?.[ImportFormat.ACCOUNT];
  if (!accountFieldMapping || headers.length === 0 || parsedRows.length === 0) {
    return DEFAULT_ACTIVITY_IMPORT_PROFILE;
  }

  const resolvedAccountIds = new Set<string>();
  for (const row of parsedRows) {
    const rawAccount = getMappedAccountColumnValue(row, headers, accountFieldMapping);
    const mappedAccountId = rawAccount
      ? (accountMappings[rawAccount] ?? accountMappings[rawAccount.toLowerCase()])
      : accountMappings[""];
    const accountId = mappedAccountId || (accountById.has(rawAccount) ? rawAccount : "");
    if (accountId && accountById.has(accountId)) {
      resolvedAccountIds.add(accountId);
    }
  }

  return getActivityImportProfileForResolvedAccountIds(accounts, resolvedAccountIds);
}

export function isTransactionImportProfile(profile: ActivityImportProfile): boolean {
  return profile.kind === "transaction";
}

export function getAllowedActivityTypesForAccountType(
  accountType: string | null | undefined,
): readonly ActivityType[] {
  return getActivityImportProfileForAccountType(accountType).allowedActivityTypes;
}

export function activityTypeAllowedForImportProfile(
  activityType: string | null | undefined,
  profile: ActivityImportProfile,
): boolean {
  if (!activityType) return true;
  return profile.allowedActivityTypes.includes(activityType.toUpperCase() as ActivityType);
}

export function getActivityTypeLabelForImportProfile(
  activityType: ActivityType,
  profile: ActivityImportProfile,
  t?: TFunction,
): string {
  return (
    profile.activityTypeLabels?.[activityType] ??
    (t ? localizeActivityTypeName(t, activityType) : ActivityTypeNames[activityType])
  );
}

function appendAliases(
  mappings: Record<string, string[]>,
  activityType: ActivityType,
  aliases: readonly string[],
) {
  const existing = mappings[activityType] ?? [];
  const seen = new Set(existing.map((value) => value.toUpperCase()));
  const next = [...existing];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) continue;
    const key = trimmed.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(trimmed);
  }
  mappings[activityType] = next;
}

export function getDefaultActivityMappingsForImportProfile(
  profile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): Record<string, string[]> {
  const mappings: Record<string, string[]> = {};
  for (const activityType of profile.allowedActivityTypes) {
    mappings[activityType] = [activityType];
  }

  if (profile === CREDIT_CARD_TRANSACTION_IMPORT_PROFILE) {
    appendAliases(mappings, ActivityType.WITHDRAWAL, [
      "CHARGE",
      "PURCHASE",
      "CARD PURCHASE",
      "DEBIT",
      "SALE",
      "PAYMENT TO",
      "TRANSACTION",
    ]);
    appendAliases(mappings, ActivityType.TRANSFER_IN, [
      "PAYMENT",
      "PAYMENT RECEIVED",
      "AUTOPAY PAYMENT",
      "THANK YOU",
      "THANK YOU PAYMENT",
      "CREDIT CARD PAYMENT",
    ]);
    appendAliases(mappings, ActivityType.CREDIT, [
      "REFUND",
      "RETURN",
      "REVERSAL",
      "STATEMENT CREDIT",
      "CREDIT ADJUSTMENT",
      "CASHBACK",
      "CASH BACK",
      "REWARDS",
      "REIMBURSEMENT",
      "REIMBURSED",
      "EXPENSE REIMBURSEMENT",
    ]);
    appendAliases(mappings, ActivityType.FEE, ["ANNUAL FEE", "LATE FEE", "SERVICE FEE"]);
    appendAliases(mappings, ActivityType.INTEREST, ["INTEREST CHARGE", "FINANCE CHARGE"]);
  } else if (isTransactionImportProfile(profile)) {
    appendAliases(mappings, ActivityType.DEPOSIT, [
      "DEPOSIT",
      "PAYROLL",
      "DIRECT DEPOSIT",
      "E-TRANSFER IN",
      "WIRE IN",
      "ACH IN",
    ]);
    appendAliases(mappings, ActivityType.WITHDRAWAL, [
      "WITHDRAWAL",
      "DEBIT",
      "PAYMENT",
      "PURCHASE",
      "POS",
      "ATM WITHDRAWAL",
      "BILL PAYMENT",
    ]);
    appendAliases(mappings, ActivityType.TRANSFER_IN, ["TRANSFER IN", "TRANSFER_IN"]);
    appendAliases(mappings, ActivityType.TRANSFER_OUT, ["TRANSFER OUT", "TRANSFER_OUT"]);
    appendAliases(mappings, ActivityType.INTEREST, ["INTEREST", "INTEREST EARNED"]);
    appendAliases(mappings, ActivityType.CREDIT, [
      "REFUND",
      "REVERSAL",
      "CREDIT",
      "CASHBACK",
      "CASH BACK",
      "REWARDS",
      "REIMBURSEMENT",
      "REIMBURSED",
      "EXPENSE REIMBURSEMENT",
    ]);
  }

  return mappings;
}

export function sanitizeFieldMappingsForImportProfile(
  fieldMappings: Record<string, string | string[]> | undefined,
  profile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): Record<string, string | string[]> {
  const allowed = new Set(profile.visibleMappingFields);
  return Object.fromEntries(
    Object.entries(fieldMappings ?? {}).filter(([field]) => allowed.has(field as ImportFormat)),
  );
}

export function sanitizeActivityMappingsForImportProfile(
  activityMappings: Record<string, string[]> | undefined,
  profile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): Record<string, string[]> {
  const allowed = new Set<string>(profile.allowedActivityTypes);
  const sanitized: Record<string, string[]> = {};
  for (const [activityType, values] of Object.entries(activityMappings ?? {})) {
    if (activityType !== ACTIVITY_SKIP && !allowed.has(activityType)) continue;
    const cleanedValues = (values ?? []).map((value) => value.trim()).filter(Boolean);
    if (cleanedValues.length > 0) sanitized[activityType] = cleanedValues;
  }
  return sanitized;
}

export function mergeActivityMappingsForImportProfile(
  activityMappings: Record<string, string[]> | undefined,
  profile = DEFAULT_ACTIVITY_IMPORT_PROFILE,
): Record<string, string[]> {
  const merged = getDefaultActivityMappingsForImportProfile(profile);
  const sanitized = sanitizeActivityMappingsForImportProfile(activityMappings, profile);

  for (const [activityType, values] of Object.entries(sanitized)) {
    appendAliases(merged, activityType as ActivityType, values);
  }

  return merged;
}

export function sanitizeImportMappingForProfile<
  T extends Pick<
    ImportMappingData,
    "fieldMappings" | "activityMappings" | "symbolMappings" | "symbolMappingMeta"
  >,
>(mapping: T, profile = DEFAULT_ACTIVITY_IMPORT_PROFILE): T {
  return {
    ...mapping,
    fieldMappings: sanitizeFieldMappingsForImportProfile(mapping.fieldMappings, profile),
    activityMappings: sanitizeActivityMappingsForImportProfile(mapping.activityMappings, profile),
    symbolMappings: profile.assetResolutionEnabled ? mapping.symbolMappings : {},
    symbolMappingMeta: profile.assetResolutionEnabled ? mapping.symbolMappingMeta : {},
  };
}
