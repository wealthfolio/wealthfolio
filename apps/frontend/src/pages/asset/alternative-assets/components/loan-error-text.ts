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

/** Loan form fields a setup refusal can be about. */
export type LoanSetupField =
  | "originalAmount"
  | "originationDate"
  | "interestRate"
  | "amortization"
  | "firstPaymentDate"
  | "paymentAmount"
  | "renewalMaturity";

const LOAN_ERROR_FIELDS: Record<string, LoanSetupField> = {
  LOAN_AMOUNT_REQUIRED: "originalAmount",
  LOAN_ORIGINATION_REQUIRED: "originationDate",
  LOAN_RATE_INVALID: "interestRate",
  LOAN_AMORTIZATION_INVALID: "amortization",
  LOAN_FIRST_PAYMENT_BEFORE_ORIGINATION: "firstPaymentDate",
  LOAN_PAYMENT_AMOUNT_INVALID: "paymentAmount",
  LOAN_MATURITY_BEFORE_ORIGINATION: "renewalMaturity",
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

/** A loan refusal with its own message, which the form that sent it shows. */
export function isLoanRefusal(cause: unknown): boolean {
  const message = errorMessage(cause);
  return message !== undefined && message in LOAN_ERROR_KEYS;
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

/** The field a setup refusal is about, among those a form shows; otherwise `fallback`. */
export function loanErrorField(
  cause: unknown,
  fields: readonly LoanSetupField[],
  fallback: LoanSetupField,
): LoanSetupField {
  const field = LOAN_ERROR_FIELDS[errorMessage(cause) ?? ""];
  return field && fields.includes(field) ? field : fallback;
}
