import { isCreditCardAccountType } from "./constants";

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
