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
  LOAN_PAYMENT_ACCOUNT_INVALID: "asset:loanPayments.account_invalid",
  LOAN_PAYMENT_NOT_ELIGIBLE: "asset:loanPayments.not_eligible",
  LOAN_AMOUNT_REQUIRED: "asset:loanSetup.amount_required",
  LOAN_ORIGINATION_REQUIRED: "asset:loanSetup.origination_required",
  LOAN_RATE_INVALID: "asset:loanSetup.rate_invalid",
  LOAN_AMORTIZATION_INVALID: "asset:loanSetup.amortization_invalid",
  LOAN_FIRST_PAYMENT_BEFORE_ORIGINATION:
    "asset:loanActions.validation.first_payment_after_origination",
  LOAN_MATURITY_BEFORE_ORIGINATION: "asset:loanSetup.maturity_after_origination",
  LOAN_PAYMENT_AMOUNT_INVALID: "asset:loanSetup.payment_invalid",
  LOAN_PAYMENT_UNAVAILABLE: "asset:loanSetup.payment_unavailable",
  LOAN_FIELDS_READ_ONLY: "asset:loanSetup.fields_read_only",
  LOAN_BALANCE_BEFORE_ORIGINATION: "asset:quickAdd.validation.balance_date_before_origination",
  LOAN_PAYMENT_DUPLICATES_EVENT: "asset:loanPayments.duplicates_event",
  LOAN_EXTRA_ALREADY_LINKED: "asset:loanPayments.extra_already_linked",
  LOAN_EXTRA_ALREADY_RECORDED: "asset:loanPayments.extra_already_recorded",
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

/** The withdrawal matches a recorded extra repayment; linking can replace it on request. */
export function isDuplicateEventError(cause: unknown): boolean {
  return errorMessage(cause) === "LOAN_PAYMENT_DUPLICATES_EVENT";
}

/** Loan errors are backend codes or translation keys; other errors are shown as they are. */
export function loanErrorText(t: TFunction, cause: unknown, fallbackKey: string): string {
  const message = errorMessage(cause);
  if (!message) return t(fallbackKey);
  const key = LOAN_ERROR_KEYS[message] ?? (message.startsWith("asset:") ? message : undefined);
  return key ? t(key) : message;
}
