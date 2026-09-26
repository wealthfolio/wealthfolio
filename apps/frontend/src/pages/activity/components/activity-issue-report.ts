import type { ActivityDetails } from "@/lib/types";
import type { ActivityType } from "@/lib/constants";
import type {
  ActivityAssetClass,
  ActivityIssueKind,
  ActivityIssueReport,
  ActivitySign,
} from "@/features/wealthfolio-connect/types";
import { KNOWN_PROVIDER_TYPES } from "./known-provider-types";

const DESCRIPTION_TERMS = [
  "municipal",
  "bond",
  "interest",
  "dividend",
  "contribution",
  "distribution",
  "reinvestment",
  "transfer",
  "fee",
  "tax",
] as const;

/** Synced local accounts retain the cloud owner's flag in existing metadata. */
export function isSharedBrokerAccount(meta?: string): boolean {
  if (!meta) return false;
  try {
    const parsed: unknown = JSON.parse(meta);
    if (!parsed || typeof parsed !== "object") return false;
    const owner = (parsed as Record<string, unknown>).owner;
    return (
      !!owner &&
      typeof owner === "object" &&
      (owner as Record<string, unknown>).is_own_account === false
    );
  } catch {
    return false;
  }
}

function providerSigns(activity: ActivityDetails): {
  amountSign?: ActivitySign;
  unitsSign?: ActivitySign;
} {
  const signs = activity.metadata?.provider_signs;
  if (!signs || typeof signs !== "object" || Array.isArray(signs)) return {};
  const fields = signs as Record<string, unknown>;
  const valid = (value: unknown): value is ActivitySign =>
    value === "positive" || value === "negative" || value === "zero" || value === "missing";
  return {
    ...(valid(fields.amount) ? { amountSign: fields.amount } : {}),
    ...(valid(fields.units) ? { unitsSign: fields.units } : {}),
  };
}

export function activityAssetClass(activity: ActivityDetails): ActivityAssetClass {
  switch (activity.instrumentType?.toUpperCase()) {
    case "BOND":
    case "FIXED_INCOME":
      return "bond";
    case "EQUITY":
    case "STOCK":
      return "stock";
    case "ETF":
    case "MUTUAL_FUND":
    case "FUND":
      return "fund";
    case "CRYPTOCURRENCY":
    case "CRYPTO":
      return "crypto";
    case "OPTION":
      return "option";
    case "CASH":
      return "cash";
    default:
      return activity.assetSymbol ? "unknown" : "cash";
  }
}

/** Only controlled terms leave the device. Never send the source description. */
export function activityDescriptionTerms(activity: ActivityDetails): string[] {
  const description =
    typeof activity.metadata?.description === "string"
      ? activity.metadata.description
      : (activity.comment ?? "");
  const words = new Set(description.toLowerCase().match(/[a-z]+/g) ?? []);
  return DESCRIPTION_TERMS.filter(
    (term) => words.has(term) || (term === "municipal" && words.has("muni")),
  );
}

export function activityRawType(activity: ActivityDetails): string | undefined {
  const rawType = activity.metadata?.raw_type;
  return typeof rawType === "string" && KNOWN_PROVIDER_TYPES.has(rawType.toUpperCase())
    ? rawType.toUpperCase()
    : undefined;
}

export function expectedTypeForIssue(
  issueKind: ActivityIssueKind,
  expectedType?: ActivityType,
): ActivityType | undefined {
  return issueKind === "wrong_type" || issueKind === "missing_activity" ? expectedType : undefined;
}

export function createActivityIssueReport(
  activity: ActivityDetails,
  accountId: string,
  issueKind: ActivityIssueKind,
  expectedType?: ActivityType,
): ActivityIssueReport {
  const applicableExpectedType = expectedTypeForIssue(issueKind, expectedType);
  return {
    consent: true,
    provider: "snaptrade",
    accountId,
    issueKind,
    observedType: activity.activityType,
    ...(applicableExpectedType ? { expectedType: applicableExpectedType } : {}),
    ...(activityRawType(activity) ? { rawType: activityRawType(activity) } : {}),
    features: {
      ...providerSigns(activity),
      assetClass: activityAssetClass(activity),
      hasSymbol: Boolean(activity.assetSymbol),
      descriptionTerms: activityDescriptionTerms(activity),
    },
  };
}
