import type { TFunction } from "i18next";

import { LOAN_ERROR_KEYS } from "@/lib/loan-error-codes";
import { backendError, backendErrorText } from "@/lib/backend-error";

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
  return message !== undefined && Object.hasOwn(LOAN_ERROR_KEYS, message);
}

/** The withdrawal matches a recorded extra repayment; linking can replace it on request. */
export function isDuplicateEventError(cause: unknown): boolean {
  return errorMessage(cause) === "LOAN_PAYMENT_DUPLICATES_EVENT";
}

/** Loan refusals retain actionable translations; unknown diagnostics stay private. */
export function loanErrorText(t: TFunction, cause: unknown, fallbackKey: string): string {
  const message = errorMessage(cause);
  if (!message) return t(fallbackKey);
  const key = Object.hasOwn(LOAN_ERROR_KEYS, message)
    ? LOAN_ERROR_KEYS[message]
    : Object.values(LOAN_ERROR_KEYS).includes(message)
      ? message
      : undefined;
  return key
    ? t(key, { defaultValue: t(fallbackKey) })
    : backendError(cause)
      ? backendErrorText(cause, t)
      : t(fallbackKey);
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
