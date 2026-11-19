import {
  getActivitySpendingAmount,
  isCashActivityIncome,
  isCashActivityOutflow,
  isCreditCardAccountType,
} from "./constants";

interface ResolveCashActivitySubtypeInput {
  activityType: string;
  accountType?: string;
  existingActivityType?: string | null;
  existingSubtype?: string | null;
}

export function resolveCashActivitySubtype({
  activityType,
  accountType,
  existingActivityType,
  existingSubtype,
}: ResolveCashActivitySubtypeInput): string | null {
  if (activityType !== "CREDIT" || isCreditCardAccountType(accountType)) {
    return null;
  }

  if (existingActivityType === "CREDIT") {
    return existingSubtype ?? null;
  }

  return "REIMBURSEMENT";
}

function isTransferType(activityType: string | undefined): boolean {
  return activityType === "TRANSFER_IN" || activityType === "TRANSFER_OUT";
}

export function cashActivityFlowMetadata(
  activityType: string,
  subtype?: string | null,
  existingMetadata?: Record<string, unknown>,
  existingActivityType?: string,
): Record<string, unknown> | undefined {
  const normalizedSubtype = subtype?.trim().toUpperCase();
  const supportsCreditBoundary = activityType === "CREDIT";

  const existingFlow = existingMetadata?.flow;
  const hasFlowObject =
    typeof existingFlow === "object" && existingFlow !== null && !Array.isArray(existingFlow);
  const flow = hasFlowObject ? { ...(existingFlow as Record<string, unknown>) } : {};
  const hasExplicitBoundary = typeof flow.is_external === "boolean";

  // A saved transfer keeps its boundary. A row becoming one is external until
  // it is linked: its other side is not tracked yet. Sent explicitly, since the
  // core defaults it only for a few type pairs.
  if (isTransferType(activityType)) {
    if (isTransferType(existingActivityType)) {
      return hasFlowObject ? { ...existingMetadata, flow } : undefined;
    }
    return { ...existingMetadata, flow: { ...flow, is_external: true } };
  }

  if (supportsCreditBoundary && hasExplicitBoundary) {
    return {
      ...existingMetadata,
      flow,
    };
  }

  if (activityType === "CREDIT" && normalizedSubtype === "REIMBURSEMENT") {
    return {
      ...existingMetadata,
      flow: { ...flow, is_external: true },
    };
  }

  if (!hasFlowObject || !("is_external" in flow)) {
    return undefined;
  }

  delete flow.is_external;
  const metadata = { ...existingMetadata };
  if (Object.keys(flow).length > 0) {
    metadata.flow = flow;
  } else {
    delete metadata.flow;
  }
  return metadata;
}

/** How reports count a row of a type, which a type change explains before saving. */
export type ReportingEffect =
  | "transferOut"
  | "transferIn"
  | "cardPayment"
  | "cardAdvance"
  | "spending"
  | "refund"
  | "income"
  | "none";

export function reportingEffect(
  activityType: string,
  accountType?: string,
  subtype?: string | null,
): ReportingEffect {
  if (isTransferType(activityType)) {
    // A bank's one-sided transfer still counts as spending or income until it
    // is linked; a card's is never spending.
    if (isCreditCardAccountType(accountType)) {
      return activityType === "TRANSFER_IN" ? "cardPayment" : "cardAdvance";
    }
    return activityType === "TRANSFER_IN" ? "transferIn" : "transferOut";
  }
  const spending = getActivitySpendingAmount({ activityType, amount: 1, subtype }, accountType);
  if (spending > 0) return "spending";
  if (spending < 0) return "refund";
  return isCashActivityIncome(activityType, accountType, subtype) ? "income" : "none";
}

interface TypeChangeSide {
  activityType: string;
  subtype?: string | null;
}

/**
 * What changing a saved row's type does to reports and to the balance, or
 * null when it changes neither. `effect` is set when reports count it differently.
 */
export function describeTypeChange(
  saved: TypeChangeSide,
  next: TypeChangeSide,
  accountType?: string,
): { effect?: ReportingEffect; reversesBalance: boolean } | null {
  if (saved.activityType === next.activityType) return null;
  const before = reportingEffect(saved.activityType, accountType, saved.subtype);
  const after = reportingEffect(next.activityType, accountType, next.subtype);
  const reversesBalance =
    isCashActivityOutflow(saved.activityType, accountType) !==
    isCashActivityOutflow(next.activityType, accountType);
  if (before === after && !reversesBalance) return null;
  return { effect: before === after ? undefined : after, reversesBalance };
}

/**
 * The transfer a saved row becomes when linked with another account, or
 * undefined when it cannot be linked from the Spending form.
 */
export function linkableTransferType(
  activityType: string,
  accountType?: string,
): "TRANSFER_IN" | "TRANSFER_OUT" | undefined {
  switch (activityType) {
    case "TRANSFER_IN":
    case "DEPOSIT":
      return "TRANSFER_IN";
    case "TRANSFER_OUT":
    case "WITHDRAWAL":
      return "TRANSFER_OUT";
    case "CREDIT":
      return isCreditCardAccountType(accountType) ? "TRANSFER_IN" : undefined;
    default:
      return undefined;
  }
}
