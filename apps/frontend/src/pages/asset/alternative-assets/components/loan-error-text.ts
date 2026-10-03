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

/** The desktop runtime rejects with the message itself; the web runtime with an Error. */
function errorMessage(cause: unknown): string | undefined {
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
}

/** Refusals caused by a stale copy of the loan; reloading lets the next attempt succeed. */
export function isStaleLoanError(cause: unknown): boolean {
  const message = errorMessage(cause);
  return message === "LOAN_EVENT_CHANGED" || message === "LOAN_EVENT_MISSING";
}

/** Loan errors are backend codes or translation keys; other errors are shown as they are. */
export function loanErrorText(t: TFunction, cause: unknown, fallbackKey: string): string {
  const message = errorMessage(cause);
  if (!message) return t(fallbackKey);
  const key = LOAN_ERROR_KEYS[message] ?? (message.startsWith("asset:") ? message : undefined);
  return key ? t(key) : message;
}
