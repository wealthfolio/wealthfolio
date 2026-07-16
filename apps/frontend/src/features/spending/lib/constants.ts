import { AccountPurpose, accountSupportsPurpose, isLiabilityAccountType } from "@/lib/constants";

/** Cash/card activity types tracked by the spending module. */
export const CASH_ACTIVITY_TYPES = [
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "FEE",
  "TAX",
  "INTEREST",
  "CREDIT",
] as const;

export type CashActivityType = (typeof CASH_ACTIVITY_TYPES)[number];

export const CREDIT_CARD_ACTIVITY_TYPES: CashActivityType[] = [
  "WITHDRAWAL",
  "FEE",
  "INTEREST",
  "TRANSFER_IN",
  "CREDIT",
];

export const CASH_ACTIVITY_TYPE_LABELS: Record<CashActivityType, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  TRANSFER_IN: "Transfer In",
  TRANSFER_OUT: "Transfer Out",
  FEE: "Fee",
  TAX: "Tax",
  INTEREST: "Interest",
  CREDIT: "Credit",
};

const CREDIT_CARD_ACTIVITY_TYPE_LABELS: Partial<Record<CashActivityType, string>> = {
  WITHDRAWAL: "Charge",
  FEE: "Fee",
  INTEREST: "Interest Charge",
  TRANSFER_IN: "Payment",
  CREDIT: "Refund / Credit",
};

/** Activity types that count as outflow (red, negative direction). */
export const OUTFLOW_TYPES: CashActivityType[] = ["WITHDRAWAL", "TRANSFER_OUT", "FEE", "TAX"];

/** Activity types that count as income (green, positive direction). */
export const INCOME_TYPES: CashActivityType[] = ["DEPOSIT", "TRANSFER_IN", "INTEREST"];

export function isSpendingAccountType(accountType: string | undefined): boolean {
  return accountSupportsPurpose(accountType, AccountPurpose.SPENDING);
}

export function isCreditCardAccountType(accountType: string | undefined): boolean {
  return isLiabilityAccountType(accountType);
}

export function getActivityTypesForAccount(accountType: string | undefined): CashActivityType[] {
  return isCreditCardAccountType(accountType)
    ? CREDIT_CARD_ACTIVITY_TYPES
    : [...CASH_ACTIVITY_TYPES];
}

export function getCashActivityLabel(
  activityType: string,
  accountType?: string,
  subtype?: string | null,
): string {
  if (isCreditCardAccountType(accountType)) {
    return (
      CREDIT_CARD_ACTIVITY_TYPE_LABELS[activityType as CashActivityType] ??
      CASH_ACTIVITY_TYPE_LABELS[activityType as CashActivityType] ??
      activityType
    );
  }

  if (activityType === "CREDIT" && subtype === "REIMBURSEMENT") {
    return "Reimbursement / refund";
  }

  return CASH_ACTIVITY_TYPE_LABELS[activityType as CashActivityType] ?? activityType;
}

export function getEffectiveCashActivityType(activity: {
  activityType: string;
  activityTypeOverride?: string | null;
}): string {
  return activity.activityTypeOverride ?? activity.activityType;
}

export function isCashActivityIncome(
  activityType: string,
  accountType?: string,
  subtype?: string | null,
): boolean {
  if (isCreditCardAccountType(accountType)) {
    return false;
  }
  if (activityType === "CREDIT") {
    return subtype === "BONUS";
  }
  return INCOME_TYPES.includes(activityType as CashActivityType);
}

export function isCashActivityOutflow(activityType: string, accountType?: string): boolean {
  if (isCreditCardAccountType(accountType)) {
    return activityType === "WITHDRAWAL" || activityType === "FEE" || activityType === "INTEREST";
  }
  return OUTFLOW_TYPES.includes(activityType as CashActivityType);
}

export function getActivitySpendingAmount(
  activity: {
    activityType: string;
    activityTypeOverride?: string | null;
    amount?: string | number | null;
    subtype?: string | null;
    sourceGroupId?: string | null;
  },
  accountType?: string,
): number {
  const activityType = getEffectiveCashActivityType(activity);
  const amount =
    typeof activity.amount === "number" ? activity.amount : parseFloat(activity.amount ?? "0") || 0;
  const absAmount = Math.abs(amount);

  if (
    activity.sourceGroupId &&
    (activityType === "TRANSFER_IN" || activityType === "TRANSFER_OUT")
  ) {
    return 0;
  }

  if (isCreditCardAccountType(accountType)) {
    if (activityType === "CREDIT") {
      return -absAmount;
    }
    return activityType === "WITHDRAWAL" || activityType === "FEE" || activityType === "INTEREST"
      ? absAmount
      : 0;
  }

  if (activityType === "CREDIT") {
    if (
      activity.subtype === "REFUND" ||
      activity.subtype === "REBATE" ||
      activity.subtype === "REIMBURSEMENT"
    ) {
      return -absAmount;
    }
    return 0;
  }

  if (accountType && !isSpendingAccountType(accountType)) {
    return 0;
  }

  return OUTFLOW_TYPES.includes(activityType as CashActivityType) ? absAmount : 0;
}

export function getPositiveActivitySpendingAmount(
  activity: Parameters<typeof getActivitySpendingAmount>[0],
  accountType?: string,
): number {
  return Math.max(0, getActivitySpendingAmount(activity, accountType));
}

export function getActivityRefundAmount(
  activity: Parameters<typeof getActivitySpendingAmount>[0],
  accountType?: string,
): number {
  const amount = getActivitySpendingAmount(activity, accountType);
  return amount < 0 ? -amount : 0;
}
