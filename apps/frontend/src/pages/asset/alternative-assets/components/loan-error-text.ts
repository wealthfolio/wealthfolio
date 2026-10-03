import type { TFunction } from "i18next";

/** Loan refusals from the backend, by their stable code. */
const LOAN_ERROR_KEYS: Record<string, string> = {
  LOAN_INVALID: "asset:loanEvents.invalid",
  LOAN_AMOUNT_EXCEEDS_BALANCE: "asset:loanActions.validation.amount_exceeds_balance",
  LOAN_BALANCE_DATE_TAKEN: "asset:loanEvents.balance_date_occupied",
  LOAN_EVENT_CHANGED: "asset:loanEvents.changed",
  LOAN_EVENT_MISSING: "asset:loanEvents.no_longer_exists",
  LOAN_PAYMENT_REQUIRED: "asset:loanActions.payment_required_for_frequency",
  LOAN_CLOSURE_DATE_INVALID: "asset:loanActions.validation.closure_date_invalid",
};

/**
 * Loan errors are backend codes or translation keys; other errors are shown as
 * they are. The desktop runtime rejects with the message itself.
 */
export function loanErrorText(t: TFunction, cause: unknown, fallbackKey: string): string {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  if (!message) return t(fallbackKey);
  const key = LOAN_ERROR_KEYS[message] ?? (message.startsWith("asset:") ? message : undefined);
  return key ? t(key) : message;
}
